import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      getAccount: async (accountId: string) => ({ id: accountId, status: "READY", name: `Synthetic ${accountId}`, iban: null }),
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
