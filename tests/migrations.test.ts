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

    expect(versions()).toEqual([1, 2, 3]);
    expect(columns("accounts")).toContain("is_demo");
    expect(columns("planned_transactions")).toEqual(expect.arrayContaining(["revision", "latest_completion_id", "is_demo"]));
    expect(columns("transactions")).toEqual(expect.arrayContaining(["corrected_from_transaction_id", "voided_at", "is_demo"]));
    expect(tableExists("planned_completions")).toBe(true);
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

    expect(versions()).toEqual([1, 2, 3]);
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

  it("rolls back the statements and marker when a migration fails", async () => {
    await migrateDatabase(database, migrations, () => appliedAt);
    const broken: Migration = {
      version: 4,
      name: "synthetic broken migration",
      statements: ["CREATE TABLE should_roll_back (id TEXT PRIMARY KEY)", "THIS IS NOT SQL"],
    };

    await expect(migrateDatabase(database, [...migrations, broken], () => appliedAt))
      .rejects.toThrow("Database migration 4 (synthetic broken migration) failed");
    expect(tableExists("should_roll_back")).toBe(false);
    expect(versions()).toEqual([1, 2, 3]);
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
