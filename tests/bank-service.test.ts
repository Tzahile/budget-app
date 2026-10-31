import { db } from "../server/db.ts";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import { createAccount, createBankConnection, getAppData, getIngestionHistory, listBankConnections } from "../server/repository.ts";
import { disconnectBankConnection, mapBankAccount, syncBankConnection } from "../server/bank-service.ts";
import { createGoCardlessClient } from "../server/gocardless.ts";

let database: DatabaseSync;
function useGoCardlessEnvironment() {
  const values: Record<string, string> = { BUDGET_APP_BANK_PROVIDER: "gocardless-bank-account-data", BUDGET_APP_BANK_SYNC_VERIFIED: "true", BUDGET_APP_BBVA_ITALY_INSTITUTION_ID: "it-synthetic", BUDGET_APP_GOCARDLESS_SECRET_ID: "synthetic", BUDGET_APP_GOCARDLESS_SECRET_KEY: "synthetic" };
  Object.assign(globalThis, { Deno: { env: { get: (name: string) => values[name] } } });
}
beforeAll(() => { database = new DatabaseSync(":memory:"); useTestSqlite(database); useGoCardlessEnvironment(); });
afterAll(() => database.close());
beforeEach(useGoCardlessEnvironment);

describe("manual bank sync", () => {
  it("validates all provider accounts before writing, then replays idempotently and revokes", async () => {
    const id = await createBankConnection({
      provider: "gocardless-bank-account-data", providerConnectionId: "synthetic-requisition",
      institutionId: "it-synthetic", institutionName: "Synthetic Italian Bank", countryCode: "IT",
    });
    let incomplete = true;
    let revoked = false;
    const adapter = {
      getRequisition: async () => ({ id: "synthetic-requisition", status: "LN", accounts: ["a", "b"],
        link: null, institutionId: "it-synthetic", reference: null }),
      getAccount: async (accountId: string) => ({ id: accountId, status: "READY", name: `Synthetic ${accountId}`, iban: accountId === "a" ? "IT60X0542811101000000123456" : "IT60X0542811101000000654321" }),
      getBalances: async (accountId: string) => accountId === "b" && incomplete ? [] :
        [{ amountCents: accountId === "a" ? 1250 : 2500, type: "interimBooked", referenceDate: null }],
      getTransactions: async (accountId: string) => [{
        occurredOn: "2026-09-20", amountCents: accountId === "a" ? 1250 : 2500,
        description: "Synthetic entry", externalId: `bank-${accountId}`, status: "cleared" as const,
      }],
      deleteRequisition: async () => { revoked = true; },
    } as unknown as ReturnType<typeof createGoCardlessClient>;

    await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 422 });
    expect((await getAppData()).accounts).toEqual([]);
    incomplete = false;
    expect(await syncBankConnection(id, adapter)).toEqual({ importedCount: 2, duplicateCount: 0, accounts: 2 });
    expect((await getAppData()).accounts.map((account) => account.balanceCents).sort()).toEqual([1250, 2500]);
    expect(await syncBankConnection(id, adapter)).toEqual({ importedCount: 0, duplicateCount: 2, accounts: 2 });
    expect((await getAppData()).transactions).toHaveLength(2);
    await disconnectBankConnection(id, adapter);
    expect(revoked).toBe(true);
    expect((await listBankConnections())[0].status).toBe("disconnected");
    await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 409 });
  });
});

describe("atomic connection snapshots and reconnect", () => {
  it("rolls back every account when a later account has invalid canonical data", async () => {
    const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "atomic-synthetic", institutionId: "it-synthetic", institutionName: "Synthetic", countryCode: "IT" });
    const count = database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n;
    const adapter = {
      getRequisition: async () => ({ id: "atomic-synthetic", status: "LN", accounts: ["atomic-a", "atomic-b"], institutionId: "it-synthetic" }),
      getAccount: async (id: string) => ({ id, status: "READY", name: "Synthetic", iban: id === "atomic-a" ? "IT60X0542811101000000111111" : "IT60X0542811101000000222222" }),
      getBalances: async () => [{ amountCents: 1000, type: "interimBooked", referenceDate: null }],
      getTransactions: async (id: string) => [{ occurredOn: "2026-09-20", amountCents: id === "atomic-a" ? 1000 : 1.5, description: "Synthetic", externalId: id }],
    } as unknown as ReturnType<typeof createGoCardlessClient>;
    await expect(syncBankConnection(id, adapter)).rejects.toThrow("integer cents");
    expect(database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(count);
    expect(database.prepare("SELECT COUNT(*) AS n FROM imports WHERE bank_connection_id = ?").get(id)!.n).toBe(0);
    expect(database.prepare("SELECT sync_revision FROM bank_connections WHERE id = ?").get(id)!.sync_revision).toBe(0);
  });

  it("reuses stable account identity across new requisitions and provider IDs", async () => {
    let currentId = "old-provider-account";
    let description = "Pending synthetic";
    let status: "pending" | "cleared" = "pending";
    const adapter = {
      getRequisition: async () => ({ status: "LN", accounts: [currentId], institutionId: "reconnect-institution" }),
      getAccount: async (id: string) => ({ id, status: "READY", name: "Synthetic", iban: "IT60X0542811101000000333333" }),
      getBalances: async () => [{ amountCents: status === "pending" ? 1000 : 900, type: "interimBooked", referenceDate: null }],
      getTransactions: async () => [{ occurredOn: "2026-09-20", amountCents: -100, description, externalId: "stable-reconnect-tx", status }],
    } as unknown as ReturnType<typeof createGoCardlessClient>;
    const old = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "old-requisition", institutionId: "reconnect-institution", institutionName: "Synthetic", countryCode: "IT" });
    await syncBankConnection(old, adapter);
    const local = database.prepare("SELECT account_id FROM bank_account_links WHERE connection_id = ?").get(old)!.account_id;
    const newer = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "new-requisition", institutionId: "reconnect-institution", institutionName: "Synthetic", countryCode: "IT" });
    currentId = "new-provider-account"; description = "Booked synthetic"; status = "cleared";
    await syncBankConnection(newer, adapter);
    expect(database.prepare("SELECT account_id FROM bank_account_links WHERE connection_id = ?").get(newer)!.account_id).toBe(local);
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(local)!.n).toBe(1);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(local)!.balance_cents).toBe(900);
    expect(database.prepare("SELECT status FROM bank_connections WHERE id = ?").get(old)!.status).toBe("reauth_required");
    expect(database.prepare("SELECT bank_connection_id, status FROM transactions WHERE account_id = ?").get(local)).toMatchObject({ bank_connection_id: newer, status: "cleared" });
    expect(JSON.stringify(database.prepare("SELECT * FROM bank_account_identities").all())).not.toContain("IT60X0542811101000000333333");
    database.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(local);
    await expect(syncBankConnection(newer, adapter)).rejects.toMatchObject({ status: 409 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(local)!.balance_cents).toBe(900);
  });
});

it("checks the connection revision at SQL commit, rolling back a concurrent disconnect", async () => {
  const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "race-requisition", institutionId: "race-institution", institutionName: "Synthetic", countryCode: "IT" });
  const adapter = {
    getRequisition: async () => ({ status: "LN", accounts: ["race-account"], institutionId: "race-institution" }),
    getAccount: async (id: string) => ({ id, status: "READY", name: "Synthetic", iban: "IT60X0542811101000000444444" }),
    getBalances: async () => [{ amountCents: 1000, type: "interimBooked", referenceDate: null }],
    getTransactions: async () => [{ occurredOn: "2026-09-20", amountCents: 1000, description: "Synthetic", externalId: "race-tx" }],
  } as unknown as ReturnType<typeof createGoCardlessClient>;
  const count = database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n;
  const original = db.batch.bind(db);
  const spy = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
    database.prepare("UPDATE bank_connections SET status = 'disconnected', sync_revision = sync_revision + 1 WHERE id = ?").run(id);
    return original(statements);
  });
  try { await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 409 }); }
  finally { spy.mockRestore(); }
  expect(database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(count);
  expect(database.prepare("SELECT COUNT(*) AS n FROM imports WHERE bank_connection_id = ?").get(id)!.n).toBe(0);
});

it("uses gated Enable Banking consent/code exchange and the same canonical sync without raw identity persistence", async () => {
  const { beginBankConsent, completeBankConsent, bankConnectionsResponse } = await import("../server/bank-service.ts");
  const { getBankConnectionForSync } = await import("../server/repository.ts");
  const environment: Record<string, string> = { BUDGET_APP_BANK_PROVIDER: "enable-banking", BUDGET_APP_BANK_SYNC_VERIFIED: "true", BUDGET_APP_ENABLE_BANKING_APP_ID: "synthetic-app", BUDGET_APP_ENABLE_BANKING_PRIVATE_KEY: "synthetic-not-a-key", BUDGET_APP_ENABLE_BANKING_ASPSP_NAME: "BBVA" };
  Object.assign(globalThis, { Deno: { env: { get: (name: string) => environment[name] } } });
  let state = ""; let codeCalls = 0;
  const providerSession = { id: "enable-synthetic-session", status: "LN", accounts: ["enable-synthetic-account"], institutionId: "BBVA", reference: null, link: null, expiresAt: "2999-01-01T00:00:00.000Z", accountIdentities: { "enable-synthetic-account": "synthetic-enable-identity" } };
  const adapter = {
    providerId: "enable-banking", listItalianInstitutions: async () => [{ id: "BBVA", name: "BBVA", countries: ["IT"], transactionTotalDays: null }],
    createRequisition: async (_institution: string, redirect: string, reference: string) => { expect(redirect).toBe("https://budget.example/api/bank/callback"); state = reference; return { ...providerSession, id: "enable-synthetic-authorization", accounts: [], link: "https://auth.enablebanking.com/ais/start?sessionid=synthetic" }; },
    exchangeAuthorization: async (code: string) => { expect(code).toBe("synthetic-one-time-code"); codeCalls++; return providerSession; },
    getRequisition: async () => providerSession,
    getAccount: async (id: string) => ({ id, status: "READY", name: null, iban: null }),
    getBalances: async () => [{ amountCents: 1000, type: "interimBooked", referenceDate: null }],
    getTransactions: async () => [{ occurredOn: "2026-09-20", amountCents: 100, description: "Synthetic", externalId: "enable-entry" }],
    deleteRequisition: async () => undefined,
  };
  const { authorizationUrl } = await beginBankConsent({ institutionId: "BBVA", ownerUsername: "owner", origin: "https://budget.example" }, adapter);
  expect(authorizationUrl).toContain("https://auth.enablebanking.com/");
  expect(JSON.stringify(database.prepare("SELECT state_hash, redirect_uri FROM bank_consent_attempts").all())).not.toContain(state);
  await expect(completeBankConsent({ state, ownerUsername: "outsider", origin: "https://budget.example", code: "synthetic-one-time-code" }, adapter)).rejects.toMatchObject({ status: 400 });
  await completeBankConsent({ state, ownerUsername: "owner", origin: "https://budget.example", code: "synthetic-one-time-code" }, adapter);
  await expect(completeBankConsent({ state, ownerUsername: "owner", origin: "https://budget.example", code: "synthetic-one-time-code" }, adapter)).rejects.toMatchObject({ status: 400 });
  expect(codeCalls).toBe(1);
  const connection = (await listBankConnections()).find((c) => c.provider === "enable-banking")!;
  expect((await getBankConnectionForSync(connection.id))?.consentExpiresAt).toBe(providerSession.expiresAt);
  expect(await syncBankConnection(connection.id, adapter)).toEqual({ importedCount: 1, duplicateCount: 0, accounts: 1 });
  expect(await syncBankConnection(connection.id, adapter)).toEqual({ importedCount: 0, duplicateCount: 1, accounts: 1 });
  expect(JSON.stringify(await bankConnectionsResponse(adapter))).not.toContain("synthetic-enable-identity");
  environment.BUDGET_APP_BANK_SYNC_VERIFIED = "false";
  expect((await bankConnectionsResponse(adapter)).available).toBe(false);
  await expect(syncBankConnection(connection.id, adapter)).rejects.toMatchObject({ status: 503 });
  await disconnectBankConnection(connection.id, adapter);
  useGoCardlessEnvironment();
});

it("refuses a stale closing booked balance instead of reconciling today's ledger backwards", async () => {
  const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "stale-requisition", institutionId: "stale-institution", institutionName: "Synthetic", countryCode: "IT" });
  const adapter = { getRequisition: async () => ({ status: "LN", accounts: ["stale-account"], institutionId: "stale-institution" }),
    getAccount: async (id: string) => ({ id, status: "READY", name: null, iban: "IT60X0542811101000000555555" }),
    getBalances: async () => [{ amountCents: 123, type: "closingBooked", referenceDate: "2020-01-01" }], getTransactions: async () => [],
  } as unknown as ReturnType<typeof createGoCardlessClient>;
  await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 422 });
  expect(database.prepare("SELECT COUNT(*) AS n FROM bank_account_links WHERE connection_id = ?").get(id)!.n).toBe(0);
});

it("requires explicit mapping of an existing household account and preserves cash totals", async () => {
  await createAccount({ name: "Synthetic manually maintained bank", type: "checking", balanceCents: 10_000 });
  const local = (await getAppData()).accounts.find((account) => account.name === "Synthetic manually maintained bank")!;
  const initialCount = database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n;
  const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "manual-map-requisition",
    institutionId: "it-synthetic", institutionName: "Synthetic", countryCode: "IT" });
  const adapter = {
    providerId: "gocardless-bank-account-data",
    getRequisition: async () => ({ status: "LN", accounts: ["manual-provider-account"], institutionId: "it-synthetic" }),
    getAccount: async (id: string) => ({ id, status: "READY", name: "Synthetic bank", iban: "IT60X0542811101000000888888" }),
    getBalances: async () => [{ amountCents: 10_000, type: "interimBooked", referenceDate: null }],
    getTransactions: async () => [{ occurredOn: "2026-10-12", amountCents: 200, description: "Synthetic deposit", externalId: "map-entry" }],
  } as unknown as ReturnType<typeof createGoCardlessClient>;
  await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 409 });
  expect(database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(initialCount);
  expect((await getAppData()).accounts.find((account) => account.id === local.id)?.balanceCents).toBe(10_000);
  expect(await mapBankAccount(id, "manual-provider-account", local.id, adapter)).toBe(local.id);
  expect(await syncBankConnection(id, adapter)).toEqual({ importedCount: 1, duplicateCount: 0, accounts: 1 });
  expect(database.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(initialCount);
  expect((await getAppData()).accounts.find((account) => account.id === local.id)?.balanceCents).toBe(10_000);
  expect(await syncBankConnection(id, adapter)).toEqual({ importedCount: 0, duplicateCount: 1, accounts: 1 });
  const coverage = database.prepare("SELECT * FROM bank_account_sync_coverage WHERE account_id = ?").get(local.id) as Record<string, unknown>;
  expect(coverage.first_date).toBeTruthy();
  expect(coverage.has_gap).toBe(0);
  database.prepare("UPDATE bank_account_sync_coverage SET first_date = '2020-01-01', last_date = '2020-01-02' WHERE account_id = ?").run(local.id);
  await syncBankConnection(id, adapter);
  expect(database.prepare("SELECT has_gap FROM bank_account_sync_coverage WHERE account_id = ?").get(local.id)).toMatchObject({ has_gap: 1 });
});

it("persists a real failed import audit ID without partial financial writes", async () => {
  const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "rejected-sync",
    institutionId: "it-synthetic", institutionName: "Synthetic", countryCode: "IT" });
  const adapter = {
    providerId: "gocardless-bank-account-data",
    getRequisition: async () => ({ status: "LN", accounts: ["rejected-provider-account"], institutionId: "it-synthetic" }),
    getAccount: async (id: string) => ({ id, status: "READY", name: "Synthetic", iban: "IT60X0542811101000000999999" }),
    getBalances: async () => [{ amountCents: 400, type: "interimBooked", referenceDate: null }],
    getTransactions: async () => [
      { occurredOn: "2026-10-12", amountCents: 100, description: "Synthetic transaction A", externalId: "conflicting-id" },
      { occurredOn: "2026-10-12", amountCents: 200, description: "Synthetic transaction B", externalId: "conflicting-id" },
    ],
  } as unknown as ReturnType<typeof createGoCardlessClient>;
  await mapBankAccount(id, "rejected-provider-account", null, adapter);
  const before = database.prepare("SELECT COUNT(*) AS n FROM transactions").get()!.n;
  let importId: string | undefined;
  try { await syncBankConnection(id, adapter); }
  catch (error) { importId = (error as { importId?: string }).importId; }
  expect(importId).toBeTruthy();
  expect(database.prepare("SELECT status, account_id FROM imports WHERE id = ?").get(importId!)).toMatchObject({
    status: "failed", account_id: null,
  });
  expect((await getIngestionHistory()).some((run) => run.id === importId && run.status === "failed")).toBe(true);
  expect(database.prepare("SELECT COUNT(*) AS n FROM transactions").get()!.n).toBe(before);
});

it("marks locally expired consent as requiring reauthorization before provider requests", async () => {
  const id = await createBankConnection({ provider: "gocardless-bank-account-data", providerConnectionId: "expired-consent",
    institutionId: "it-synthetic", institutionName: "Synthetic", countryCode: "IT",
    consentExpiresAt: "2020-01-01T00:00:00.000Z" });
  const adapter = { providerId: "gocardless-bank-account-data", getRequisition: vi.fn() } as unknown as ReturnType<typeof createGoCardlessClient>;
  await expect(syncBankConnection(id, adapter)).rejects.toMatchObject({ status: 409 });
  expect(adapter.getRequisition).not.toHaveBeenCalled();
  expect(database.prepare("SELECT status, safe_error_code FROM bank_connections WHERE id = ?").get(id))
    .toMatchObject({ status: "reauth_required", safe_error_code: "consent_expired" });
});
