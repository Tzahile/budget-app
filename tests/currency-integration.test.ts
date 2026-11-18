import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completePlanned, createAccount, createPlanned, createTransaction, deleteTransaction, getAppData, ingestTransactions, listTransactions, reconcileAccount, updateTransaction } from "../server/repository.ts";
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
  it("blocks reconciliation and balance mutations against a stored foreign account", async () => {
    const accountId = "synthetic-usd-mutation";
    database.prepare("INSERT INTO accounts (id, name, type, currency, balance_cents, created_at, updated_at) VALUES (?, 'Synthetic USD', 'checking', 'USD', 2222, '2026-09-01', '2026-09-01')").run(accountId);
    database.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, currency, description, kind, status, source, created_at, updated_at)
      VALUES ('synthetic-usd-mutation-tx', ?, '2026-09-16', -200, 'USD', 'Synthetic USD debit', 'expense', 'cleared', 'manual', '2026-09-16', '2026-09-16')`).run(accountId);
    const euro = database.prepare("SELECT id FROM accounts WHERE currency = 'EUR'").get()!;
    const date = "2026-09-16";
    const transaction = { accountId, date, amountCents: 100, description: "Synthetic", kind: "expense" as const };
    await expect(reconcileAccount(accountId, { actualBalanceCents: 1234, date, note: "Synthetic" })).rejects.toMatchObject({ status: 422 });
    await expect(createTransaction(transaction)).rejects.toMatchObject({ status: 422 });
    await expect(updateTransaction("synthetic-usd-mutation-tx", { ...transaction, accountId: String(euro.id) })).rejects.toMatchObject({ status: 422 });
    await expect(deleteTransaction("synthetic-usd-mutation-tx")).rejects.toMatchObject({ status: 422 });

    await createPlanned({ accountId: String(euro.id), description: "Synthetic EUR plan", kind: "expense", amountCents: 100, recurrence: "once", intervalCount: 1, nextDate: date, endDate: null, isActive: true });
    const planned = database.prepare("SELECT id FROM planned_transactions WHERE description = 'Synthetic EUR plan'").get()!;
    await expect(completePlanned(String(planned.id), date, accountId)).rejects.toMatchObject({ status: 422 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 2222 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?").get(accountId)).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_reconciliations WHERE account_id = ?").get(accountId)).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM planned_completions WHERE planned_transaction_id = ?").get(planned.id!)).toMatchObject({ count: 0 });
  });

});
