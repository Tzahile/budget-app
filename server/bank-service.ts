import { householdDate } from "../shared/finance.ts";
import type { BankConnectionsResponse } from "../shared/types.ts";
import { createGoCardlessClient, GoCardlessError, type GoCardlessInstitution } from "./gocardless.ts";
import {
  consumeBankConsentAttempt, createBankConnection, createBankConsentAttempt,
  createLinkedBankAccount, getAppData, getBankConnectionForSync,
  hashBankConsentState, ingestBankAccountTransactions, listBankConnections,
  markBankConnection,
} from "./repository.ts";

const provider = "gocardless-bank-account-data";
const client = createGoCardlessClient();
type BankProviderClient = ReturnType<typeof createGoCardlessClient>;

function configuredInstitutionId(): string | null {
  const id = Deno.env.get("BUDGET_APP_BBVA_ITALY_INSTITUTION_ID")?.trim();
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    Deno.env.get("BUDGET_APP_GOCARDLESS_SECRET_ID") && Deno.env.get("BUDGET_APP_GOCARDLESS_SECRET_KEY") ? id : null;
}

async function eligibleInstitutions(adapter: BankProviderClient): Promise<GoCardlessInstitution[]> {
  const id = configuredInstitutionId();
  if (!id) return [];
  const catalog = await adapter.listItalianInstitutions();
  return catalog.filter((institution) => institution.id === id && institution.countries.includes("IT"));
}

export async function bankConnectionsResponse(adapter: BankProviderClient = client): Promise<BankConnectionsResponse> {
  const connections = await listBankConnections();
  const accounts = (await getAppData()).accounts;
  let institutions: GoCardlessInstitution[] = [];
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
      institutionName: connection.institutionName, status: connection.status,
      expiresAt: connection.consentExpiresAt, lastSyncedAt: connection.lastSyncedAt,
      lastError: connection.safeErrorCode,
      accounts: connection.accounts.map(({ accountId }) => {
        const account = accounts.find((item) => item.id === accountId);
        return { id: accountId, accountId, name: account?.name ?? "Bank account", currency: account?.currency ?? "EUR" };
      }),
    })),
  };
}

export async function beginBankConsent(input: {
  institutionId: string; ownerUsername: string; origin: string;
}, adapter: BankProviderClient = client): Promise<{ authorizationUrl: string }> {
  const institution = (await eligibleInstitutions(adapter)).find((item) => item.id === input.institutionId);
  if (!institution) throw safeError(503, "Bank institution is unavailable");
  const state = randomToken();
  const redirectUri = `${input.origin}/api/bank/callback?state=${encodeURIComponent(state)}`;
  const requisition = await adapter.createRequisition(institution.id, redirectUri, randomToken());
  try {
    await createBankConsentAttempt({
      stateHash: await hashBankConsentState(state), ownerUsername: input.ownerUsername,
      provider, institutionId: institution.id, institutionName: institution.name,
      providerRequisitionId: requisition.id, redirectUri,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  } catch (error) {
    await adapter.deleteRequisition(requisition.id).catch(() => undefined);
    throw error;
  }
  return { authorizationUrl: requisition.link! };
}

export async function completeBankConsent(input: {
  state: string; ownerUsername: string; origin: string;
}, adapter: BankProviderClient = client): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.state)) throw safeError(400, "Invalid bank consent state");
  const redirectUri = `${input.origin}/api/bank/callback?state=${encodeURIComponent(input.state)}`;
  const attempt = await consumeBankConsentAttempt({
    stateHash: await hashBankConsentState(input.state), ownerUsername: input.ownerUsername, redirectUri,
  });
  if (!attempt || attempt.provider !== provider) throw safeError(400, "Bank consent expired or was already used");
  const requisition = await adapter.getRequisition(attempt.providerRequisitionId);
  if (requisition.status !== "LN" || requisition.institutionId !== attempt.institutionId || !requisition.accounts.length) {
    throw safeError(409, "Bank consent is incomplete; reconnect to continue");
  }
  await createBankConnection({
    provider, providerConnectionId: requisition.id, institutionId: attempt.institutionId,
    institutionName: attempt.institutionName, countryCode: "IT",
  });
}

export async function syncBankConnection(id: string, adapter: BankProviderClient = client): Promise<{ importedCount: number; duplicateCount: number; accounts: number }> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  if (connection.provider !== provider || connection.status !== "connected") throw safeError(409, "Bank connection requires reconnection");
  try {
    const requisition = await adapter.getRequisition(connection.providerConnectionId);
    if (requisition.status !== "LN" || !requisition.accounts.length) {
      await markBankConnection(id, "reauth_required", "consent_expired");
      throw safeError(409, "Bank consent requires reconnection");
    }
    // Fetch and validate every source response before applying any account write.
    const to = householdDate();
    const from = new Date(`${to}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 89);
    const snapshots = await Promise.all(requisition.accounts.map(async (providerAccountId) => {
      const [account, balances, transactions] = await Promise.all([
        adapter.getAccount(providerAccountId), adapter.getBalances(providerAccountId),
        adapter.getTransactions(providerAccountId, { from: from.toISOString().slice(0, 10), to }),
      ]);
      if (account.status !== "READY" || transactions.length > 2000) throw safeError(422, "Bank account data is incomplete");
      // Available balances can include pending card holds. Only a booked
      // balance can reconcile the app's cleared-transaction ledger.
      const balance = balances.find((item) => item.type === "interimBooked") ??
        balances.find((item) => item.type === "closingBooked");
      if (!balance) throw safeError(422, "Bank balance type is unsupported");
      return { providerAccountId, name: account.name ?? "Bank account", balanceCents: balance.amountCents, transactions };
    }));
    let importedCount = 0;
    let duplicateCount = 0;
    for (const snapshot of snapshots) {
      const accountId = await createLinkedBankAccount({
        connectionId: id, providerAccountId: snapshot.providerAccountId, name: snapshot.name,
      });
      const result = await ingestBankAccountTransactions({
        connectionId: id, accountId, provider, transactions: snapshot.transactions,
        balanceCents: snapshot.balanceCents,
      });
      importedCount += result.importedCount;
      duplicateCount += result.duplicateCount;
    }
    return { importedCount, duplicateCount, accounts: snapshots.length };
  } catch (error) {
    if (error instanceof GoCardlessError) {
      const expired = error.status === 401 || error.status === 403;
      await markBankConnection(id, expired ? "reauth_required" : "connected", expired ? "consent_expired" : "provider_unavailable");
      throw safeError(expired ? 409 : 502, expired ? "Bank consent requires reconnection" : "Bank data is temporarily unavailable");
    }
    throw error;
  }
}

export async function disconnectBankConnection(id: string, adapter: BankProviderClient = client): Promise<void> {
  const connection = await getBankConnectionForSync(id);
  if (!connection) throw safeError(404, "Bank connection not found");
  if (connection.status === "disconnected") return;
  if (connection.provider !== provider) throw safeError(409, "Unsupported bank provider");
  try { await adapter.deleteRequisition(connection.providerConnectionId); }
  catch (error) {
    if (!(error instanceof GoCardlessError) || error.status !== 404) {
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
