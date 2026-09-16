import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReserveStatement, updateReserveStatement } from "../server/reserve-operations.ts";

let db: DatabaseSync;
const now = "2026-09-16T10:00:00.000Z";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
  CREATE TABLE planned_transactions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, recurrence TEXT NOT NULL, is_active INTEGER NOT NULL
  );
  CREATE TABLE reserves (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    target_amount_cents INTEGER, target_date TEXT, contribution_month TEXT,
    contribution_cents INTEGER NOT NULL DEFAULT 0,
    linked_planned_transaction_id TEXT REFERENCES planned_transactions(id) ON DELETE SET NULL,
    currency TEXT NOT NULL DEFAULT 'EUR', note TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX reserves_linked_planned_idx
    ON reserves(linked_planned_transaction_id) WHERE linked_planned_transaction_id IS NOT NULL;
  INSERT INTO planned_transactions VALUES ('expense-once', 'expense', 'once', 1);
  INSERT INTO planned_transactions VALUES ('expense-recurring', 'expense', 'monthly', 1);
  INSERT INTO planned_transactions VALUES ('income-once', 'income', 'once', 1);
  INSERT INTO planned_transactions VALUES ('expense-inactive', 'expense', 'once', 0);`);
});

afterEach(() => db.close());

function insert(input: {
  funded?: number;
  target?: number | null;
  targetDate?: string | null;
  month?: string | null;
  contributed?: number;
  linkedPlannedTransactionId?: string | null;
} = {}): void {
  db.prepare(`INSERT INTO reserves
    (id, name, amount_cents, target_amount_cents, target_date, contribution_month,
      contribution_cents, linked_planned_transaction_id, note, is_active, updated_at)
    VALUES ('reserve-a', 'Goal', ?, ?, ?, ?, ?, ?, '', 1, ?)`)
    .run(input.funded ?? 0, input.target ?? null, input.targetDate ?? null,
      input.month ?? null, input.contributed ?? 0, input.linkedPlannedTransactionId ?? null, now);
}

function update(input: { funded: number; target?: number | null; targetDate?: string | null; month?: string; linkedPlannedTransactionId?: string | null }): number {
  const statement = updateReserveStatement({
    id: "reserve-a",
    name: "Goal",
    fundedAmountCents: input.funded,
    targetAmountCents: input.target === undefined ? 600_000 : input.target,
    targetDate: input.targetDate === undefined ? "2026-11-30" : input.targetDate,
    linkedPlannedTransactionId: input.linkedPlannedTransactionId ?? null,
    note: "",
    isActive: true,
    contributionMonth: input.month ?? "2026-09",
    now,
  });
  return Number(db.prepare(statement.sql).run(...statement.args).changes);
}

function row(): Record<string, unknown> {
  return db.prepare("SELECT * FROM reserves WHERE id = 'reserve-a'").get() as Record<string, unknown>;
}

describe("reserve contribution state", () => {
  it("treats a new goal's existing funded amount as its baseline", () => {
    insert({ funded: 150_000 });
    update({ funded: 200_000 });

    expect(row()).toMatchObject({
      amount_cents: 200_000,
      target_amount_cents: 600_000,
      contribution_month: "2026-09",
      contribution_cents: 0,
    });
  });

  it("records net increases, partial decreases, and month rollover atomically", () => {
    insert({ target: 600_000, targetDate: "2026-11-30", month: "2026-09" });
    update({ funded: 200_000 });
    expect(row()).toMatchObject({ contribution_month: "2026-09", contribution_cents: 200_000 });

    update({ funded: 125_000 });
    expect(row()).toMatchObject({ contribution_month: "2026-09", contribution_cents: 125_000 });

    update({ funded: 225_000, month: "2026-10" });
    expect(row()).toMatchObject({ contribution_month: "2026-10", contribution_cents: 100_000 });
  });

  it("preserves current-month progress across target edits and clears it when the goal is removed", () => {
    insert({ funded: 200_000, target: 600_000, targetDate: "2026-11-30", month: "2026-09", contributed: 200_000 });
    update({ funded: 200_000, target: 900_000, targetDate: "2026-12-31" });
    expect(row()).toMatchObject({ target_amount_cents: 900_000, contribution_cents: 200_000 });

    update({ funded: 200_000, target: null, targetDate: null });
    expect(row()).toMatchObject({ contribution_month: null, contribution_cents: 0 });
  });
});

describe("reserve planned-expense links", () => {
  it("creates a goal linked to one eligible planned expense", () => {
    const statement = createReserveStatement({
      id: "linked-goal",
      name: "Car replacement",
      fundedAmountCents: 100_000,
      targetAmountCents: 600_000,
      targetDate: "2026-11-30",
      linkedPlannedTransactionId: "expense-once",
      note: "",
      contributionMonth: "2026-09",
      now,
    });
    expect(db.prepare(statement.sql).run(...statement.args).changes).toBe(1);
    expect(db.prepare("SELECT linked_planned_transaction_id FROM reserves WHERE id = 'linked-goal'").get())
      .toMatchObject({ linked_planned_transaction_id: "expense-once" });
  });

  it("rejects missing, inactive, recurring, income, simple-reserve, and duplicate links", () => {
    const invalidIds = ["missing", "expense-inactive", "expense-recurring", "income-once"];
    invalidIds.forEach((linkedPlannedTransactionId, index) => {
      const statement = createReserveStatement({
        id: `invalid-${index}`, name: "Invalid", fundedAmountCents: 0,
        targetAmountCents: 100_000, targetDate: "2026-11-30", linkedPlannedTransactionId,
        note: "", contributionMonth: "2026-09", now,
      });
      expect(db.prepare(statement.sql).run(...statement.args).changes).toBe(0);
    });

    const simple = createReserveStatement({
      id: "simple", name: "Simple", fundedAmountCents: 0,
      targetAmountCents: null, targetDate: null, linkedPlannedTransactionId: "expense-once",
      note: "", contributionMonth: "2026-09", now,
    });
    expect(db.prepare(simple.sql).run(...simple.args).changes).toBe(0);

    insert({ target: 100_000, targetDate: "2026-11-30", linkedPlannedTransactionId: "expense-once" });
    const duplicate = createReserveStatement({
      id: "duplicate", name: "Duplicate", fundedAmountCents: 0,
      targetAmountCents: 100_000, targetDate: "2026-11-30", linkedPlannedTransactionId: "expense-once",
      note: "", contributionMonth: "2026-09", now,
    });
    expect(db.prepare(duplicate.sql).run(...duplicate.args).changes).toBe(0);
  });

  it("links, retains an inactive existing link, and unlinks atomically", () => {
    insert({ target: 600_000, targetDate: "2026-11-30" });
    expect(update({ funded: 0, linkedPlannedTransactionId: "expense-once" })).toBe(1);
    db.exec("UPDATE planned_transactions SET is_active = 0 WHERE id = 'expense-once'");
    expect(update({ funded: 10_000, linkedPlannedTransactionId: "expense-once" })).toBe(1);
    expect(row()).toMatchObject({ linked_planned_transaction_id: "expense-once" });
    expect(update({ funded: 10_000, linkedPlannedTransactionId: null })).toBe(1);
    expect(row()).toMatchObject({ linked_planned_transaction_id: null });
  });
});
