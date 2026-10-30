import { db } from "../server/db.ts";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import { createBankConnection, getAppData, listBankConnections } from "../server/repository.ts";
import { disconnectBankConnection, syncBankConnection } from "../server/bank-service.ts";
import { createGoCardlessClient } from "../server/gocardless.ts";

let database: DatabaseSync;
beforeAll(() => { database = new DatabaseSync(":memory:"); useTestSqlite(database); });
afterAll(() => database.close());

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
