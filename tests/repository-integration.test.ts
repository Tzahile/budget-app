import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import {
  completePlanned,
  correctPlannedCompletion,
  createAccount,
  createPlanned,
  createReserve,
  createTransaction,
  createTransfer,
  deleteTransaction,
  deleteTransfer,
  getAppData,
  ingestTransactions,
  reconcileAccount,
  undoPlannedCompletion,
  updateTransaction,
  updateTransfer,
} from "../server/repository.ts";

let database: DatabaseSync;

beforeAll(() => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
});

afterAll(() => database.close());

function row(sql: string, ...args: (string | number)[]): Record<string, unknown> {
  return database.prepare(sql).get(...args) as Record<string, unknown>;
}

describe("repository integration against the migrated SQLite schema", () => {
  it("keeps balances, audit history, planned corrections, transfers, goals, and canonical imports consistent", async () => {
    await createAccount({ name: "Synthetic current", type: "checking", balanceCents: 100_000 });
    await createAccount({ name: "Synthetic savings", type: "savings", balanceCents: 50_000 });
    let data = await getAppData("2026-09-30");
    const current = data.accounts.find((account) => account.name === "Synthetic current")!;
    const savings = data.accounts.find((account) => account.name === "Synthetic savings")!;

    // Manual balance mutations remain reversible and never alter another account.
    await createTransaction({ accountId: current.id, date: "2026-09-10", amountCents: 2_500, description: "Synthetic food", kind: "expense" });
    let manual = (await getAppData("2026-09-30")).transactions.find((transaction) => transaction.description === "Synthetic food")!;
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(97_500);

    await updateTransaction(manual.id, { accountId: savings.id, date: "2026-09-11", amountCents: 3_000, description: "Synthetic corrected food", kind: "expense" });
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(100_000);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", savings.id).balance_cents).toBe(47_000);
    manual = (await getAppData("2026-09-30")).transactions.find((transaction) => transaction.description === "Synthetic corrected food")!;
    await deleteTransaction(manual.id);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", savings.id).balance_cents).toBe(50_000);

    await reconcileAccount(current.id, { actualBalanceCents: 101_234, date: "2026-09-12", note: "Synthetic statement checkpoint" });
    expect(row("SELECT previous_balance_cents, actual_balance_cents, difference_cents FROM account_reconciliations")).toMatchObject({
      previous_balance_cents: 100_000, actual_balance_cents: 101_234, difference_cents: 1_234,
    });

    // Transfers preserve total household cash and can only be changed as linked legs.
    await createTransfer({ fromAccountId: current.id, toAccountId: savings.id, date: "2026-09-13", amountCents: 10_000, description: "Synthetic transfer" });
    const transfer = row("SELECT transfer_group_id FROM transactions WHERE description = ? LIMIT 1", "Synthetic transfer");
    const groupId = String(transfer.transfer_group_id);
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE transfer_group_id = ?", groupId).count).toBe(2);
    await updateTransfer(groupId, { fromAccountId: current.id, toAccountId: savings.id, date: "2026-09-14", amountCents: 12_000, description: "Synthetic transfer updated" });
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(89_234);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", savings.id).balance_cents).toBe(62_000);
    await deleteTransfer(groupId);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(101_234);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", savings.id).balance_cents).toBe(50_000);

    // Completion correction and reversal leave a trace while restoring exactly one effective balance.
    await createPlanned({ accountId: current.id, description: "Synthetic one-off goal", kind: "expense", amountCents: 20_000, recurrence: "once", intervalCount: 1, nextDate: "2026-09-20", endDate: null, isActive: true });
    data = await getAppData("2026-09-30");
    const planned = data.plannedTransactions.find((item) => item.description === "Synthetic one-off goal")!;
    await completePlanned(planned.id, "2026-09-20");
    data = await getAppData("2026-09-30");
    const completion = data.plannedCompletions.find((item) => item.plannedTransactionId === planned.id)!;
    expect(completion.effectiveTransaction?.amountCents).toBe(-20_000);
    await correctPlannedCompletion(completion.id, { accountId: savings.id, date: "2026-09-21", amountCents: 22_000, expectedEffectiveTransactionId: completion.originalTransactionId });
    data = await getAppData("2026-09-30");
    const corrected = data.plannedCompletions.find((item) => item.id === completion.id)!;
    expect(corrected.effectiveTransaction).toMatchObject({ accountId: savings.id, amountCents: -22_000 });
    await undoPlannedCompletion(corrected.id, corrected.effectiveTransaction!.id);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(101_234);
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", savings.id).balance_cents).toBe(50_000);
    expect(row("SELECT status FROM planned_completions WHERE id = ?", corrected.id).status).toBe("undone");

    // A reserve goal may link to the eligible one-off obligation even after it was completed and reversed.
    await createReserve({ name: "Synthetic goal reserve", fundedAmountCents: 5_000, targetAmountCents: 20_000, targetDate: "2026-09-20", linkedPlannedTransactionId: planned.id, note: "Synthetic only" });
    expect(row("SELECT amount_cents, linked_planned_transaction_id FROM reserves WHERE name = ?", "Synthetic goal reserve")).toMatchObject({
      amount_cents: 5_000, linked_planned_transaction_id: planned.id,
    });

    // The canonical pipeline stores source/audit history and a second identical run is a no-op.
    const sourceRows = [{ occurredOn: "2026-09-22", amountCents: -1_500, description: "Synthetic imported utility", externalId: "synthetic-bank-1", status: "cleared" as const }];
    const firstImport = await ingestTransactions({ accountId: current.id, filename: "synthetic.csv", source: "csv", transactions: sourceRows });
    const repeatedImport = await ingestTransactions({ accountId: current.id, filename: "synthetic-repeat.csv", source: "csv", transactions: sourceRows });
    expect(firstImport).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect(repeatedImport).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE external_id = ?", "synthetic-bank-1").count).toBe(1);
    expect(row("SELECT status, imported_count, duplicate_count FROM imports WHERE id = ?", repeatedImport.importId)).toMatchObject({
      status: "completed", imported_count: 0, duplicate_count: 1,
    });
    expect(row("SELECT balance_cents FROM accounts WHERE id = ?", current.id).balance_cents).toBe(99_734);

    await expect(updateTransaction(String(row("SELECT id FROM transactions WHERE external_id = ?", "synthetic-bank-1").id), {
      accountId: current.id, date: "2026-09-22", amountCents: 1_500, description: "Must not edit import", kind: "expense",
    })).rejects.toMatchObject({ status: 409 });
  });
});
