import { householdDate } from "../shared/finance.ts";
import type { BankConnectionsResponse } from "../shared/types.ts";
import { createGoCardlessClient } from "./gocardless.ts";
import { createEnableBankingClient } from "./enable-banking.ts";
import { BankProviderError, type BankInstitution, type BankProviderClient } from "./bank-provider.ts";
import {
  consumeBankConsentAttempt, createBankConnection, createBankConsentAttempt,
  applyBankConnectionSnapshot, getAppData, getBankConnectionForSync,
  hashBankConsentState, listBankConnections, listBankSyncCoverage, listMappedBankAccounts,
  confirmBankAccountMapping, markBankConnection,
} from "./repository.ts";

const clients: Record<string, BankProviderClient> = {
  "gocardless-bank-account-data": createGoCardlessClient(), "enable-banking": createEnableBankingClient(),
};
function selectedProvider(): string { return Deno.env.get("BUDGET_APP_BANK_PROVIDER") ?? ""; }
function clientFor(provider: string): BankProviderClient {
  const client = clients[provider]; if (!client) throw safeError(503, "Bank provider is not configured"); return client;
}
function configuredInstitutionId(provider = selectedProvider()): string | null {
  if (Deno.env.get("BUDGET_APP_BANK_SYNC_VERIFIED") !== "true" || provider !== selectedProvider()) return null;
  if (provider === "enable-banking") {
    const name = Deno.env.get("BUDGET_APP_ENABLE_BANKING_ASPSP_NAME")?.trim();
    return name === "BBVA" && Deno.env.get("BUDGET_APP_ENABLE_BANKING_APP_ID") && Deno.env.get("BUDGET_APP_ENABLE_BANKING_PRIVATE_KEY") ? name : null;
  }
  const id = Deno.env.get("BUDGET_APP_BBVA_ITALY_INSTITUTION_ID")?.trim();
  return provider === "gocardless-bank-account-data" && id && /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    Deno.env.get("BUDGET_APP_GOCARDLESS_SECRET_ID") && Deno.env.get("BUDGET_APP_GOCARDLESS_SECRET_KEY") ? id : null;
}

async function eligibleInstitutions(adapter: BankProviderClient): Promise<BankInstitution[]> {
  const id = configuredInstitutionId(adapter.providerId);
  if (!id) return [];
  const catalog = await adapter.listItalianInstitutions();
  return catalog.filter((institution) => institution.id === id && institution.countries.includes("IT"));
}

export async function bankConnectionsResponse(adapter: BankProviderClient = clients[selectedProvider()] ?? clients["gocardless-bank-account-data"]): Promise<BankConnectionsResponse> {
  const connections = await listBankConnections();
  const accounts = (await getAppData()).accounts;
  const coverage = new Map((await listBankSyncCoverage()).map((row) => [row.accountId, row]));
  let institutions: BankInstitution[] = [];
  let reason = "BBVA Italy provider access has not been verified and configured.";
  if (configuredInstitutionId()) {
    try {
      institutions = await eligibleInstitutions(adapter);
      if (!institutions.length) reason = "BBVA Italy is not in the current provider catalog.";
    } catch {
      reason = "The bank provider catalog is temporarily unavailable.";
    }
  }
  return {
    available: institutions.length > 0,
    ...(!institutions.length ? { reason } : { institutions: institutions.map(({ id, name }) => ({ id, name })) }),
    connections: connections.map((connection) => ({
      id: connection.id, provider: connection.provider, institutionId: connection.institutionId,
      institutionName: connection.institutionName,
      status: connection.status === "connected" && connection.consentExpiresAt &&
        connection.consentExpiresAt <= new Date().toISOString() ? "reauth_required" : connection.status,
      expiresAt: connection.consentExpiresAt, lastSyncedAt: connection.lastSyncedAt,
      lastError: connection.status === "connected" && connection.consentExpiresAt &&
        connection.consentExpiresAt <= new Date().toISOString() ? "consent_expired" : connection.safeErrorCode,
      accounts: connection.accounts.map(({ accountId }) => {
        const account = accounts.find((item) => item.id === accountId);
        const interval = coverage.get(accountId);
        return { id: accountId, accountId, name: account?.name ?? "Bank account", currency: account?.currency ?? "EUR",
          historyFrom: interval?.from ?? null, historyThrough: interval?.through ?? null, historyGap: interval?.hasGap ?? false };
      }),
    })),
  };
}

export async function beginBankConsent(input: {
  institutionId: string; ownerUsername: string; origin: string;
}, adapter: BankProviderClient = clients[selectedProvider()] ?? clients["gocardless-bank-account-data"]): Promise<{ authorizationUrl: string }> {
  const provider = adapter.providerId!;
  const institution = (await eligibleInstitutions(adapter)).find((item) => item.id === input.institutionId);
  if (!institution) throw safeError(503, "Bank institution is unavailable");
  const state = randomToken();
  const redirectUri = adapter.exchangeAuthorization ? `${input.origin}/api/bank/callback` : `${input.origin}/api/bank/callback?state=${encodeURIComponent(state)}`;
  const requisition = await adapter.createRequisition(institution.id, redirectUri, state);
  try {
    await createBankConsentAttempt({
      stateHash: await hashBankConsentState(state), ownerUsername: input.ownerUsername,
      provider, institutionId: institution.id, institutionName: institution.name,
      providerRequisitionId: requisition.id, redirectUri: `${input.origin}/api/bank/callback`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  } catch (error) {
    await adapter.deleteRequisition(requisition.id).catch(() => undefined);
    throw error;
  }
  return { authorizationUrl: requisition.link! };
}

export async function completeBankConsent(input: {
  state: string; ownerUsername: string; origin: string; code?: string;
}, adapter: BankProviderClient = clients[selectedProvider()] ?? clients["gocardless-bank-account-data"]): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.state)) throw safeError(400, "Invalid bank consent state");
  const redirectUri = `${input.origin}/api/bank/callback`;
  const attempt = await consumeBankConsentAttempt({
    stateHash: await hashBankConsentState(input.state), ownerUsername: input.ownerUsername, redirectUri,
  });
  if (!attempt) throw safeError(400, "Bank consent expired or was already used");
  const provider = attempt.provider;
  adapter = adapter.providerId === provider ? adapter : clientFor(provider);
  if (adapter.exchangeAuthorization && !input.code) throw safeError(400, "Bank authorization code is required");
  const requisition = adapter.exchangeAuthorization ? await adapter.exchangeAuthorization(input.code!) : await adapter.getRequisition(attempt.providerRequisitionId);
  try {
    if (requisition.status !== "LN" || requisition.institutionId !== attempt.institutionId || !requisition.accounts.length ||
      (requisition.expiresAt && requisition.expiresAt <= new Date().toISOString())) throw safeError(409, "Bank consent is incomplete; reconnect to continue");
    await createBankConnection({ provider, providerConnectionId: requisition.id, institutionId: attempt.institutionId,
      institutionName: attempt.institutionName, countryCode: "IT", consentExpiresAt: requisition.expiresAt });
  } catch (error) {
    // If storing a newly authorized session fails, do not leave an untracked live consent.
    await adapter.deleteRequisition(requisition.id).catch(() => undefined);
    throw error;
  }
}

/** Fetch owner-visible mapping candidates only on an authenticated, explicit request. */
export async function bankAccountMappingChoices(id: string, adapter?: BankProviderClient): Promise<{
  providerAccounts: { providerAccountId: string; label: string; balanceCents: number | null; mappedAccountId: string | null }[];
}> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  if (connection.status === "connected" && connection.consentExpiresAt &&
      connection.consentExpiresAt <= new Date().toISOString()) {
    await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
    throw safeError(409, "Bank connection requires reconnection");
  }
  if (!configuredInstitutionId(connection.provider)) throw safeError(503, "Bank sync is disabled or not verified");
  adapter ??= clientFor(connection.provider);
  if (adapter.providerId !== connection.provider || connection.status !== "connected") throw safeError(409, "Bank connection requires reconnection");
  if (connection.consentExpiresAt && connection.consentExpiresAt <= new Date().toISOString()) {
    await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
    throw safeError(409, "Bank connection requires reconnection");
  }
  const session = await adapter.getRequisition(connection.providerConnectionId);
  if (session.institutionId !== connection.institutionId || session.status !== "LN" ||
    !session.accounts.length || session.accounts.length > 50 ||
    new Set(session.accounts).size !== session.accounts.length) throw safeError(409, "Bank account list needs reauthorization");
  const mapped = new Map((await listMappedBankAccounts(id)).map((item) => [item.providerAccountId, item.accountId]));
  const providerAccounts = await Promise.all(session.accounts.map(async (providerAccountId, index) => {
    const [account, balances] = await Promise.all([adapter!.getAccount(providerAccountId), adapter!.getBalances(providerAccountId)]);
    if (account.id !== providerAccountId || account.status !== "READY") throw safeError(422, "Bank account is unavailable");
    const booked = balances.find((item) => item.type === "interimBooked" || item.type === "closingBooked");
    return { providerAccountId, label: account.name?.slice(0, 100) || `Bank account ${index + 1}`,
      balanceCents: booked?.amountCents ?? null, mappedAccountId: mapped.get(providerAccountId) ?? null };
  }));
  return { providerAccounts };
}

/** Explicit owner choice; the provider proves the identity, not the browser. */
export async function mapBankAccount(id: string, providerAccountId: string, accountId: string | null, adapter?: BankProviderClient): Promise<string> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  if (connection.status === "connected" && connection.consentExpiresAt &&
      connection.consentExpiresAt <= new Date().toISOString()) {
    await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
    throw safeError(409, "Bank connection requires reconnection");
  }
  if (!configuredInstitutionId(connection.provider)) throw safeError(503, "Bank sync is disabled or not verified");
  adapter ??= clientFor(connection.provider);
  if (adapter.providerId !== connection.provider || connection.status !== "connected" ||
    (connection.consentExpiresAt && connection.consentExpiresAt <= new Date().toISOString())) throw safeError(409, "Bank connection requires reconnection");
  const session = await adapter.getRequisition(connection.providerConnectionId);
  if (session.status !== "LN" || session.institutionId !== connection.institutionId ||
      !session.accounts.includes(providerAccountId) || new Set(session.accounts).size !== session.accounts.length ||
      (session.expiresAt && session.expiresAt <= new Date().toISOString())) throw safeError(409, "Bank account is unavailable for mapping");
  const bankAccount = await adapter.getAccount(providerAccountId);
  if (bankAccount.id !== providerAccountId || bankAccount.status !== "READY") throw safeError(422, "Bank account is unavailable");
  const identity = stableBankIdentity(connection.provider, session, providerAccountId, bankAccount.iban);
  const identityHash = await hashBankConsentState(`${connection.provider}\u001f${connection.institutionId}\u001f${identity}`);
  return confirmBankAccountMapping({ connectionId: id, providerAccountId, identityHash, accountId });
}

function stableBankIdentity(provider: string, requisition: { accountIdentities?: Record<string, string> },
  providerAccountId: string, iban: string | null): string {
  if (provider === "enable-banking") {
    const identity = requisition.accountIdentities?.[providerAccountId];
    if (!identity) throw safeError(422, "Stable bank account identity is unavailable");
    return identity;
  }
  const normalized = iban?.replace(/\s/g, "").toUpperCase();
  if (!normalized || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(normalized)) throw safeError(422, "Stable bank account identity is unavailable");
  return normalized;
}

export async function syncBankConnection(id: string, adapter?: BankProviderClient): Promise<{ importedCount: number; duplicateCount: number; accounts: number }> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  if (connection.status === "connected" && connection.consentExpiresAt &&
      connection.consentExpiresAt <= new Date().toISOString()) {
    await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
    throw safeError(409, "Bank connection requires reconnection");
  }
  if (!configuredInstitutionId(connection.provider)) throw safeError(503, "Bank sync is disabled or not verified");
  adapter ??= clientFor(connection.provider);
  const provider = adapter.providerId ?? connection.provider;
  if (connection.provider !== provider || connection.status !== "connected") throw safeError(409, "Bank connection requires reconnection");
  if (connection.consentExpiresAt !== null && connection.consentExpiresAt <= new Date().toISOString()) {
    await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
    throw safeError(409, "Bank connection requires reconnection");
  }
  try {
    const requisition = await adapter.getRequisition(connection.providerConnectionId);
    if (requisition.institutionId !== connection.institutionId) throw safeError(422, "Bank institution does not match the connection");
    if (requisition.status !== "LN" || !requisition.accounts.length || (requisition.expiresAt && requisition.expiresAt <= new Date().toISOString())) {
      await markBankConnection(id, "reauth_required", "consent_expired", connection.syncRevision);
      throw safeError(409, "Bank consent requires reconnection");
    }
    if (requisition.accounts.length > 50 || new Set(requisition.accounts).size !== requisition.accounts.length) throw safeError(422, "Bank account list is incomplete or duplicated");
    // Fetch and validate every source response before applying any account write.
    const to = householdDate();
    const from = new Date(`${to}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 89);
    const snapshots = await Promise.all(requisition.accounts.map(async (providerAccountId) => {
      const [account, balances, transactions] = await Promise.all([
        adapter!.getAccount(providerAccountId), adapter!.getBalances(providerAccountId),
        adapter!.getTransactions(providerAccountId, { from: from.toISOString().slice(0, 10), to }),
      ]);
      if (account.id !== providerAccountId || account.status !== "READY" || transactions.length > 2000 ||
        transactions.some((transaction) => !transaction.externalId?.trim())) throw safeError(422, "Bank account data lacks stable transaction identities");
      // Available balances can include pending card holds. Only a booked
      // balance can reconcile the app's cleared-transaction ledger.
      const balance = balances.find((item) => item.type === "interimBooked") ??
        balances.find((item) => item.type === "closingBooked");
      if (!balance || (balance.type === "closingBooked" && balance.referenceDate !== to) ||
        (balance.referenceDate !== null && balance.referenceDate !== to)) throw safeError(422, "Bank booked balance is missing or stale");
      const identity = stableBankIdentity(provider, requisition, providerAccountId, account.iban);
      const identityHash = await hashBankConsentState(`${provider}\u001f${connection.institutionId}\u001f${identity}`);
      return { providerAccountId, identityHash, name: "Bank account", balanceCents: balance.amountCents, transactions,
        coverageFrom: from.toISOString().slice(0, 10), coverageThrough: to };
    }));
    return await applyBankConnectionSnapshot({ connectionId: id, provider, expectedRevision: connection.syncRevision, accounts: snapshots });
  } catch (error) {
    if (error instanceof BankProviderError) {
      const expired = error.status === 401 || error.status === 403;
      await markBankConnection(id, expired ? "reauth_required" : "connected", expired ? "consent_expired" : "provider_unavailable", connection.syncRevision);
      throw safeError(expired ? 409 : 502, expired ? "Bank consent requires reconnection" : "Bank data is temporarily unavailable");
    }
    throw error;
  }
}

export async function disconnectBankConnection(id: string, adapter?: BankProviderClient): Promise<void> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  adapter ??= clientFor(connection.provider);
  const provider = adapter.providerId ?? connection.provider;
  if (connection.status === "disconnected") return;
  if (connection.provider !== provider) throw safeError(409, "Unsupported bank provider");
  await markBankConnection(id, "error", "revocation_pending");
  try { await adapter.deleteRequisition(connection.providerConnectionId); }
  catch (error) {
    if (!(error instanceof BankProviderError) || error.status !== 404) {
      await markBankConnection(id, "error", "revocation_failed");
      throw safeError(502, "Bank disconnect could not be confirmed");
    }
  }
  await markBankConnection(id, "disconnected");
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
