import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileAccountStatements, type SqlStatement } from "../server/reconciliation-operations.ts";

let db: DatabaseSync;
const now = "2026-09-16T10:00:00.000Z";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL, is_active INTEGER NOT NULL,
      updated_at TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE account_reconciliations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      date TEXT NOT NULL,
      previous_balance_cents INTEGER NOT NULL,
      actual_balance_cents INTEGER NOT NULL,
      difference_cents INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO accounts (id, balance_cents, is_active, updated_at, is_demo) VALUES (?, ?, 1, ?, 1)")
    .run("account-a", 100_000, now);
  db.prepare("INSERT INTO accounts (id, balance_cents, is_active, updated_at, is_demo) VALUES (?, ?, 0, ?, 0)")
    .run("account-inactive", 50_000, now);
});

afterEach(() => db.close());

function batch(statements: SqlStatement[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...statement.args);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reconcile(actualBalanceCents: number, id = "reconciliation-1"): void {
  batch(reconcileAccountStatements({
    reconciliationId: id,
    accountId: "account-a",
    actualBalanceCents,
    date: "2026-09-16",
    note: "Synthetic bank check",
    now,
  }));
}

function accountBalance(id = "account-a"): number {
  return Number((db.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(id) as Record<string, unknown>).balance_cents);
}

function audit(id = "reconciliation-1"): Record<string, unknown> {
  return db.prepare("SELECT * FROM account_reconciliations WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("account reconciliation SQL batch", () => {
  it("records a positive difference and updates the account exactly", () => {
    reconcile(125_000);

    expect(accountBalance()).toBe(125_000);
    expect(audit()).toMatchObject({
      previous_balance_cents: 100_000,
      actual_balance_cents: 125_000,
      difference_cents: 25_000,
      date: "2026-09-16",
      note: "Synthetic bank check",
    });
    expect(db.prepare("SELECT is_demo FROM accounts WHERE id = 'account-a'").get()).toMatchObject({ is_demo: 0 });
  });

  it("records a negative difference without creating a transaction", () => {
    reconcile(72_500);

    expect(accountBalance()).toBe(72_500);
    expect(audit()).toMatchObject({
      previous_balance_cents: 100_000,
      actual_balance_cents: 72_500,
      difference_cents: -27_500,
    });
  });

  it("retains a zero-difference audit checkpoint", () => {
    reconcile(100_000);

    expect(accountBalance()).toBe(100_000);
    expect(audit()).toMatchObject({
      previous_balance_cents: 100_000,
      actual_balance_cents: 100_000,
      difference_cents: 0,
    });
  });

  it("derives before and difference after a nearby balance mutation and preserves later mutations", () => {
    db.exec("UPDATE accounts SET balance_cents = balance_cents + 5_000 WHERE id = 'account-a'");
    reconcile(120_000);
    db.exec("UPDATE accounts SET balance_cents = balance_cents - 2_000 WHERE id = 'account-a'");

    expect(audit()).toMatchObject({
      previous_balance_cents: 105_000,
      actual_balance_cents: 120_000,
      difference_cents: 15_000,
    });
    expect(accountBalance()).toBe(118_000);
  });

  it("does not reconcile an inactive or missing account", () => {
    batch(reconcileAccountStatements({
      reconciliationId: "inactive-attempt",
      accountId: "account-inactive",
      actualBalanceCents: 60_000,
      date: "2026-09-16",
      note: "",
      now,
    }));
    batch(reconcileAccountStatements({
      reconciliationId: "missing-attempt",
      accountId: "missing",
      actualBalanceCents: 60_000,
      date: "2026-09-16",
      note: "",
      now,
    }));

    expect(accountBalance("account-inactive")).toBe(50_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_reconciliations").get()).toMatchObject({ count: 0 });
  });
});
