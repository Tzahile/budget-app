import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateDatabase,
  migrations,
  type Migration,
  type MigrationDatabase,
  type MigrationStatement,
  type MigrationValue,
} from "../server/migrations.ts";

let sqlite: DatabaseSync;
let database: MigrationDatabase;
const appliedAt = "2026-09-16T08:00:00.000Z";

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  database = {
    async execute(statement) {
      const { sql, args } = normalize(statement);
      const prepared = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
        return { rows: prepared.all(...args) as Array<Record<string, unknown>> };
      }
      prepared.run(...args);
      return { rows: [] };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          const { sql, args } = normalize(statement);
          sqlite.prepare(sql).run(...args);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
});

afterEach(() => sqlite.close());

describe("database migrations", () => {
  it("brings a fresh database to the latest schema", async () => {
    await migrateDatabase(database, migrations, () => appliedAt);

    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(columns("accounts")).toContain("is_demo");
    expect(columns("planned_transactions")).toEqual(expect.arrayContaining(["revision", "latest_completion_id", "is_demo"]));
    expect(columns("transactions")).toEqual(expect.arrayContaining(["corrected_from_transaction_id", "voided_at", "is_demo"]));
    expect(tableExists("planned_completions")).toBe(true);
    expect(tableExists("account_reconciliations")).toBe(true);
    expect(columns("reserves")).toEqual(expect.arrayContaining([
      "target_amount_cents", "target_date", "contribution_month", "contribution_cents",
      "linked_planned_transaction_id",
    ]));
    expect(columns("imports")).toEqual(expect.arrayContaining(["source", "account_id"]));
    expect(tableExists("ingested_transfer_candidates")).toBe(true);
  });

  it("upgrades a version-one database without changing existing household data", async () => {
    await migrateDatabase(database, migrations.slice(0, 1), () => appliedAt);
    sqlite.prepare(`INSERT INTO accounts
      (id, name, type, currency, balance_cents, is_active, created_at, updated_at)
      VALUES (?, ?, 'checking', 'EUR', ?, 1, ?, ?)`)
      .run("account-legacy", "Household current", 123_456, appliedAt, appliedAt);
    sqlite.prepare(`INSERT INTO planned_transactions
      (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count,
       next_date, end_date, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'expense', 58100, 'EUR', 'monthly', 1, '2026-10-01', NULL, 1, ?, ?)`)
      .run("plan-legacy", "account-legacy", "Synthetic mortgage", appliedAt, appliedAt);

    await migrateDatabase(database, migrations, () => appliedAt);

    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(sqlite.prepare("SELECT name, balance_cents, is_demo FROM accounts WHERE id = ?")
      .get("account-legacy")).toMatchObject({ name: "Household current", balance_cents: 123_456, is_demo: 0 });
    expect(sqlite.prepare("SELECT description, revision, is_demo FROM planned_transactions WHERE id = ?")
      .get("plan-legacy")).toMatchObject({ description: "Synthetic mortgage", revision: 0, is_demo: 0 });
  });

  it("runs every migration once", async () => {
    await migrateDatabase(database, migrations, () => appliedAt);
    await migrateDatabase(database, migrations, () => "2026-09-16T09:00:00.000Z");

    expect(sqlite.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all())
      .toEqual(migrations.map((migration) => ({ version: migration.version, applied_at: appliedAt })));
  });

  it("upgrades existing reserves to optional goals without changing funded money", async () => {
    await migrateDatabase(database, migrations.slice(0, 4), () => appliedAt);
    sqlite.prepare(`INSERT INTO reserves
      (id, name, amount_cents, currency, note, is_active, created_at, updated_at, is_demo)
      VALUES ('reserve-legacy', 'Emergency buffer', 300000, 'EUR', '', 1, ?, ?, 0)`)
      .run(appliedAt, appliedAt);

    await migrateDatabase(database, migrations, () => appliedAt);

    expect(sqlite.prepare(`SELECT amount_cents, target_amount_cents, target_date,
        contribution_month, contribution_cents
      FROM reserves WHERE id = 'reserve-legacy'`).get()).toMatchObject({
      amount_cents: 300_000,
      target_amount_cents: null,
      target_date: null,
      contribution_month: null,
      contribution_cents: 0,
    });
  });

  it("upgrades an existing goal without treating its funded balance as a current-month contribution", async () => {
    await migrateDatabase(database, migrations.slice(0, 5), () => appliedAt);
    sqlite.prepare(`INSERT INTO reserves
      (id, name, amount_cents, target_amount_cents, target_date, currency, note,
        is_active, created_at, updated_at, is_demo)
      VALUES ('goal-legacy', 'November goal', 200000, 600000, '2026-11-30',
        'EUR', '', 1, ?, ?, 0)`)
      .run(appliedAt, appliedAt);

    await migrateDatabase(database, migrations, () => appliedAt);

    expect(sqlite.prepare(`SELECT amount_cents, contribution_month, contribution_cents
      FROM reserves WHERE id = 'goal-legacy'`).get()).toMatchObject({
      amount_cents: 200_000,
      contribution_month: null,
      contribution_cents: 0,
    });
  });

  it("enforces one goal per planned obligation and clears links when the obligation is deleted", async () => {
    await migrateDatabase(database, migrations, () => appliedAt);
    sqlite.prepare(`INSERT INTO planned_transactions
      (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count,
        next_date, end_date, is_active, created_at, updated_at)
      VALUES ('planned-car', NULL, 'Car payment', 'expense', 600000, 'EUR', 'once', 1,
        '2026-11-30', NULL, 1, ?, ?)`).run(appliedAt, appliedAt);
    const insertReserve = sqlite.prepare(`INSERT INTO reserves
      (id, name, amount_cents, target_amount_cents, target_date, contribution_month,
        contribution_cents, linked_planned_transaction_id, currency, note, is_active,
        created_at, updated_at, is_demo)
      VALUES (?, ?, 0, 600000, '2026-11-30', '2026-09', 0, 'planned-car',
        'EUR', '', 1, ?, ?, 0)`);
    insertReserve.run("goal-car", "Car goal", appliedAt, appliedAt);

    expect(() => insertReserve.run("goal-duplicate", "Duplicate", appliedAt, appliedAt))
      .toThrow(/unique/i);
    sqlite.prepare("DELETE FROM planned_transactions WHERE id = 'planned-car'").run();
    expect(sqlite.prepare("SELECT linked_planned_transaction_id FROM reserves WHERE id = 'goal-car'").get())
      .toMatchObject({ linked_planned_transaction_id: null });
  });

  it("rolls back the statements and marker when a migration fails", async () => {
    await migrateDatabase(database, migrations, () => appliedAt);
    const broken: Migration = {
      version: 11,
      name: "synthetic broken migration",
      statements: ["CREATE TABLE should_roll_back (id TEXT PRIMARY KEY)", "THIS IS NOT SQL"],
    };

    await expect(migrateDatabase(database, [...migrations, broken], () => appliedAt))
      .rejects.toThrow("Database migration 11 (synthetic broken migration) failed");
    expect(tableExists("should_roll_back")).toBe(false);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
  });
});

function normalize(statement: MigrationStatement): { sql: string; args: MigrationValue[] } {
  return typeof statement === "string" ? { sql: statement, args: [] } : statement;
}

function versions(): number[] {
  return sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    .map((row) => Number((row as Record<string, unknown>).version));
}

function columns(table: string): string[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => String((row as Record<string, unknown>).name));
}

function tableExists(table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
