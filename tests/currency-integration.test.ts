import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, getAppData, ingestTransactions, listTransactions } from "../server/repository.ts";
import { exportBackup } from "../server/backup.ts";
import { useTestSqlite } from "./support/val-sqlite.ts";

let database: DatabaseSync;
beforeAll(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  await createAccount({ name: "Synthetic EUR", type: "checking", balanceCents: 100_000 });
});
afterAll(() => database.close());

describe("stored currency boundaries", () => {
  it("rejects foreign source rows before creating imports or mutating the balance", async () => {
    const before = await getAppData("2026-09-30");
    await expect(ingestTransactions({
      accountId: before.accounts[0].id, filename: "synthetic.csv", source: "csv",
      transactions: [{ occurredOn: "2026-09-16", currency: "USD", amountCents: -100, description: "Synthetic" }],
    })).rejects.toThrow("Mixed-currency");
    expect((await getAppData("2026-09-30")).accounts[0].balanceCents).toBe(100_000);
    expect(database.prepare("SELECT COUNT(*) AS count FROM imports").get()).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 0 });
  });

  it("preserves non-EUR stored data in backups and refuses to expose it through EUR-only views", async () => {
    database.exec(`INSERT INTO accounts (id, name, type, currency, balance_cents, created_at, updated_at)
      VALUES ('synthetic-usd', 'Synthetic USD', 'checking', 'USD', 2222, '2026-09-01', '2026-09-01');
      INSERT INTO transactions (id, account_id, date, amount_cents, currency, description, kind, status, source, created_at, updated_at)
      VALUES ('synthetic-usd-tx', 'synthetic-usd', '2026-09-16', -200, 'USD', 'Synthetic USD debit', 'expense', 'cleared', 'manual', '2026-09-16', '2026-09-16');`);
    const backup = await exportBackup();
    expect(backup.data.accounts).toContainEqual(expect.objectContaining({ id: "synthetic-usd", currency: "USD", balance_cents: 2222 }));
    expect(backup.data.transactions).toContainEqual(expect.objectContaining({ id: "synthetic-usd-tx", currency: "USD", amount_cents: -200 }));
    await expect(getAppData("2026-09-30")).rejects.toThrow("Only EUR");
    await expect(listTransactions({ limit: 50 })).rejects.toThrow("Only EUR");
  });
});
