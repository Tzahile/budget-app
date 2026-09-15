import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRecurrence } from "../shared/finance.ts";
import {
  completePlannedStatements,
  correctPlannedStatements,
  PLANNED_COMPLETIONS_QUERY,
  type PlannedSnapshot,
  type SqlStatement,
  undoPlannedStatements,
} from "../server/planned-operations.ts";

let db: DatabaseSync;
const now = "2026-09-15T10:00:00.000Z";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL, updated_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE planned_transactions (
      id TEXT PRIMARY KEY, account_id TEXT, description TEXT NOT NULL, kind TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, recurrence TEXT NOT NULL,
      interval_count INTEGER NOT NULL, next_date TEXT NOT NULL, end_date TEXT, is_active INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, latest_completion_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT, import_identity TEXT, transfer_group_id TEXT,
      planned_transaction_id TEXT, raw_metadata TEXT, corrected_from_transaction_id TEXT REFERENCES transactions(id),
      voided_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE planned_completions (
      id TEXT PRIMARY KEY, planned_transaction_id TEXT NOT NULL REFERENCES planned_transactions(id) ON DELETE RESTRICT,
      transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
      correction_transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
      occurrence_date TEXT NOT NULL, previous_next_date TEXT NOT NULL,
      previous_is_active INTEGER NOT NULL, completed_next_date TEXT NOT NULL, completed_is_active INTEGER NOT NULL,
      completed_revision INTEGER NOT NULL, status TEXT NOT NULL, operation_token TEXT, last_operation_token TEXT,
      created_at TEXT NOT NULL,
      adjusted_at TEXT
    );
  `);
  db.prepare("INSERT INTO accounts (id, balance_cents, updated_at, is_demo) VALUES (?, ?, ?, 1)").run("account-a", 100_000, now);
  db.prepare("INSERT INTO accounts (id, balance_cents, updated_at, is_demo) VALUES (?, ?, ?, 1)").run("account-b", 50_000, now);
});

afterEach(() => db.close());

function seed(overrides: Partial<PlannedSnapshot> = {}): PlannedSnapshot {
  const item: PlannedSnapshot = {
    id: "plan", revision: 0, accountId: "account-a", description: "Mortgage", kind: "expense",
    amountCents: 10_000, recurrence: "monthly", intervalCount: 1, nextDate: "2026-09-10",
    endDate: null, isActive: true, ...overrides,
  };
  db.prepare(`INSERT INTO planned_transactions
    (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count, next_date,
     end_date, is_active, revision, created_at, updated_at, is_demo)
    VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(item.id, item.accountId, item.description, item.kind, item.amountCents, item.recurrence,
      item.intervalCount, item.nextDate, item.endDate, Number(item.isActive), item.revision, now, now);
  return item;
}

function batch(statements: SqlStatement[]) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...statement.args);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function complete(item: PlannedSnapshot, ids = { completionId: "completion-1", transactionId: "transaction-1" }) {
  const nextDate = addRecurrence(item.nextDate, item.recurrence, item.intervalCount) ?? item.nextDate;
  const remainsActive = item.recurrence !== "once" && (!item.endDate || nextDate <= item.endDate);
  batch(completePlannedStatements({ item, ...ids, targetAccountId: "account-a", actualDate: "2026-09-15", nextDate, remainsActive, now }));
}

function row(sql: string): Record<string, unknown> {
  return db.prepare(sql).get() as Record<string, unknown>;
}

describe("planned completion SQL batches", () => {
  it("completes and undoes a one-off with exact balance and unpaid-state restoration", () => {
    const item = seed({ recurrence: "once", nextDate: "2026-09-20" });
    complete(item);
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(90_000);
    expect(row("SELECT next_date, is_active FROM planned_transactions WHERE id = 'plan'")).toMatchObject({ next_date: "2026-09-20", is_active: 0 });
    expect(row("SELECT is_demo FROM accounts WHERE id = 'account-a'").is_demo).toBe(0);
    expect(row("SELECT is_demo FROM planned_transactions WHERE id = 'plan'").is_demo).toBe(0);
    expect(row("SELECT is_demo FROM transactions WHERE id = 'transaction-1'").is_demo).toBe(0);

    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "undo-token", now }));
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(100_000);
    expect(row("SELECT next_date, is_active FROM planned_transactions WHERE id = 'plan'")).toMatchObject({ next_date: "2026-09-20", is_active: 1 });
    expect(row("SELECT status FROM planned_completions").status).toBe("undone");
    expect(row("SELECT voided_at FROM transactions WHERE id = 'transaction-1'").voided_at).toBe(now);
  });

  it("restores an overdue monthly occurrence rather than skipping unpaid months", () => {
    const item = seed({ nextDate: "2026-07-31" });
    complete(item);
    expect(row("SELECT next_date FROM planned_transactions").next_date).toBe("2026-08-31");
    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "undo-token", now }));
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-07-31", is_active: 1 });
  });

  it("advances and restores a regular monthly occurrence", () => {
    const item = seed({ nextDate: "2026-09-10" });
    complete(item);
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-10-10", is_active: 1 });
    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "undo-token", now }));
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-09-10", is_active: 1 });
  });

  it("restores an ended recurrence to its last unpaid active occurrence", () => {
    const item = seed({ nextDate: "2026-02-28", endDate: "2026-02-28" });
    complete(item);
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-03-28", is_active: 0 });
    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "undo-token", now }));
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-02-28", is_active: 1 });
  });

  it("corrects date, account, and amount with one linked active transaction", () => {
    const item = seed();
    complete(item);
    batch(correctPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1",
      correctionTransactionId: "transaction-2", token: "correct-token",
      accountId: "account-b", date: "2026-09-14", amountCents: 12_345, now,
    }));

    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(100_000);
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-b'").balance_cents).toBe(37_655);
    expect(row("SELECT voided_at FROM transactions WHERE id = 'transaction-1'").voided_at).toBe(now);
    expect(row("SELECT account_id, date, amount_cents, corrected_from_transaction_id FROM transactions WHERE id = 'transaction-2'"))
      .toMatchObject({ account_id: "account-b", date: "2026-09-14", amount_cents: -12_345, corrected_from_transaction_id: "transaction-1" });
    expect(row("SELECT status, correction_transaction_id FROM planned_completions")).toMatchObject({ status: "corrected", correction_transaction_id: "transaction-2" });
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE voided_at IS NULL").count).toBe(1);
  });

  it("re-corrects the current effective transaction and preserves the full audit chain", () => {
    const item = seed();
    complete(item);
    batch(correctPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1",
      correctionTransactionId: "transaction-2", token: "correct-token-1",
      accountId: "account-b", date: "2026-09-14", amountCents: 12_345, now,
    }));
    batch(correctPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-2",
      correctionTransactionId: "transaction-3", token: "correct-token-2",
      accountId: "account-a", date: "2026-09-13", amountCents: 8_000, now: "2026-09-15T10:05:00.000Z",
    }));

    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(92_000);
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-b'").balance_cents).toBe(50_000);
    expect(row("SELECT corrected_from_transaction_id FROM transactions WHERE id = 'transaction-2'").corrected_from_transaction_id).toBe("transaction-1");
    expect(row("SELECT corrected_from_transaction_id FROM transactions WHERE id = 'transaction-3'").corrected_from_transaction_id).toBe("transaction-2");
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE voided_at IS NULL").count).toBe(1);
    expect(row("SELECT correction_transaction_id, last_operation_token FROM planned_completions")).toMatchObject({ correction_transaction_id: "transaction-3", last_operation_token: "correct-token-2" });
    expect(row(PLANNED_COMPLETIONS_QUERY)).toMatchObject({
      adjustable: 1, original_id: "transaction-1", effective_id: "transaction-3",
      original_amount_cents: -10_000, effective_amount_cents: -8_000,
    });
  });

  it("undoes a correction against its effective account and amount", () => {
    const item = seed();
    complete(item);
    batch(correctPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1",
      correctionTransactionId: "transaction-2", token: "correct-token",
      accountId: "account-b", date: "2026-09-14", amountCents: 12_345, now,
    }));
    batch(undoPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-2",
      token: "undo-token", now: "2026-09-15T10:05:00.000Z",
    }));

    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(100_000);
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-b'").balance_cents).toBe(50_000);
    expect(row("SELECT next_date, is_active FROM planned_transactions")).toMatchObject({ next_date: "2026-09-10", is_active: 1 });
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE voided_at IS NULL").count).toBe(0);
    expect(row("SELECT status, correction_transaction_id, last_operation_token FROM planned_completions"))
      .toMatchObject({ status: "undone", correction_transaction_id: "transaction-2", last_operation_token: "undo-token" });
    expect(row(PLANNED_COMPLETIONS_QUERY)).toMatchObject({ adjustable: 0, original_id: "transaction-1", effective_id: null });
  });

  it("allows only one serialized adjustment for the same expected effective transaction", () => {
    const item = seed();
    complete(item);
    batch(correctPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1",
      correctionTransactionId: "transaction-2", token: "winning-token",
      accountId: "account-b", date: "2026-09-14", amountCents: 12_345, now,
    }));
    batch(undoPlannedStatements({
      completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1",
      token: "stale-token", now: "2026-09-15T10:05:00.000Z",
    }));

    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(100_000);
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-b'").balance_cents).toBe(37_655);
    expect(row("SELECT status, correction_transaction_id, last_operation_token FROM planned_completions"))
      .toMatchObject({ status: "corrected", correction_transaction_id: "transaction-2", last_operation_token: "winning-token" });
    expect(row("SELECT COUNT(*) AS count FROM transactions WHERE voided_at IS NULL").count).toBe(1);
    expect(row("SELECT id FROM transactions WHERE voided_at IS NULL").id).toBe("transaction-2");
  });

  it("rejects adjustment of an older completion after a newer completion wins", () => {
    const first = seed({ nextDate: "2026-07-10" });
    complete(first);
    const current = row("SELECT revision, next_date, is_active FROM planned_transactions");
    complete({ ...first, revision: Number(current.revision), nextDate: String(current.next_date), isActive: Boolean(current.is_active) }, { completionId: "completion-2", transactionId: "transaction-2" });

    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "stale-token", now }));
    expect(row("SELECT status FROM planned_completions WHERE id = 'completion-1'").status).toBe("completed");
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(80_000);
  });

  it("does not overwrite a plan edited after completion and retains its captured snapshot", () => {
    const item = seed();
    complete(item);
    db.exec("UPDATE planned_transactions SET next_date = '2027-01-01', revision = revision + 1, latest_completion_id = NULL");
    batch(undoPlannedStatements({ completionId: "completion-1", expectedEffectiveTransactionId: "transaction-1", token: "stale-token", now }));
    expect(row("SELECT next_date FROM planned_transactions").next_date).toBe("2027-01-01");
    expect(row("SELECT previous_next_date, status FROM planned_completions")).toMatchObject({ previous_next_date: "2026-09-10", status: "completed" });
    expect(row("SELECT balance_cents FROM accounts WHERE id = 'account-a'").balance_cents).toBe(90_000);
  });
});
