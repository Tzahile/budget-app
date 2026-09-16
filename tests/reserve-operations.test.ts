import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateReserveStatement } from "../server/reserve-operations.ts";

let db: DatabaseSync;
const now = "2026-09-16T10:00:00.000Z";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reserves (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    target_amount_cents INTEGER, target_date TEXT, contribution_month TEXT,
    contribution_cents INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
  )`);
});

afterEach(() => db.close());

function insert(input: {
  funded?: number;
  target?: number | null;
  targetDate?: string | null;
  month?: string | null;
  contributed?: number;
} = {}): void {
  db.prepare(`INSERT INTO reserves
    (id, name, amount_cents, target_amount_cents, target_date, contribution_month,
      contribution_cents, note, is_active, updated_at)
    VALUES ('reserve-a', 'Goal', ?, ?, ?, ?, ?, '', 1, ?)`)
    .run(input.funded ?? 0, input.target ?? null, input.targetDate ?? null,
      input.month ?? null, input.contributed ?? 0, now);
}

function update(input: { funded: number; target?: number | null; targetDate?: string | null; month?: string }): void {
  const statement = updateReserveStatement({
    id: "reserve-a",
    name: "Goal",
    fundedAmountCents: input.funded,
    targetAmountCents: input.target === undefined ? 600_000 : input.target,
    targetDate: input.targetDate === undefined ? "2026-11-30" : input.targetDate,
    note: "",
    isActive: true,
    contributionMonth: input.month ?? "2026-09",
    now,
  });
  db.prepare(statement.sql).run(...statement.args);
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
