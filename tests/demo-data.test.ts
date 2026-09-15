import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  classifyDemoData,
  demoCleanupStatements,
  demoProvenanceMigrationSql,
  demoSeedStatements,
  demoStateQuery,
  isDuplicateIsDemoColumnError,
  type SqlStatement,
} from "../server/demo-data.ts";
import { canCleanupDemoData } from "../shared/types.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, currency TEXT, balance_cents INTEGER,
      is_active INTEGER, created_at TEXT, updated_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE planned_transactions (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), description TEXT,
      kind TEXT, amount_cents INTEGER, currency TEXT, recurrence TEXT, interval_count INTEGER, next_date TEXT,
      end_date TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), date TEXT,
      amount_cents INTEGER, currency TEXT, description TEXT, kind TEXT, status TEXT, source TEXT, external_id TEXT,
      import_identity TEXT, transfer_group_id TEXT, planned_transaction_id TEXT REFERENCES planned_transactions(id),
      raw_metadata TEXT, created_at TEXT, updated_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE reserves (id TEXT PRIMARY KEY, name TEXT, amount_cents INTEGER, currency TEXT, note TEXT,
      is_active INTEGER, created_at TEXT, updated_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return db;
}

function executeBatch(db: DatabaseSync, statements: SqlStatement[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...(statement.args ?? []));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function state(db: DatabaseSync) {
  const row = db.prepare(demoStateQuery()).get() as { total_count: number; demo_count: number };
  return classifyDemoData(row.total_count, row.demo_count);
}

function seed(db: DatabaseSync, claimToken = "claim-1"): void {
  executeBatch(db, demoSeedStatements({
    claimToken,
    checkingId: `${claimToken}-checking`,
    savingsId: `${claimToken}-savings`,
    transactionId: `${claimToken}-transaction`,
    salaryId: `${claimToken}-salary`,
    mortgageId: `${claimToken}-mortgage`,
    reserveId: `${claimToken}-reserve`,
    now: "2026-09-15T00:00:00.000Z",
    monthStart: "2026-09-01",
    salaryDate: "2026-09-17",
    mortgageDate: "2026-09-19",
  }));
}

describe("demo data lifecycle", () => {
  it("classifies an empty database and leaves repeated cleanup harmless", () => {
    const db = database();
    expect(state(db)).toBe("empty");
    executeBatch(db, demoCleanupStatements("cleanup-1", "2026-09-15T00:00:00.000Z"));
    executeBatch(db, demoCleanupStatements("cleanup-2", "2026-09-15T00:00:01.000Z"));
    expect(state(db)).toBe("empty");
  });

  it("marks every seeded row and removes a demo-only dataset", () => {
    const db = database();
    seed(db);
    expect(state(db)).toBe("demo-only");
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE is_demo = 1").get()).toEqual({ count: 2 });

    executeBatch(db, demoCleanupStatements("cleanup-1", "2026-09-15T00:01:00.000Z"));
    expect(state(db)).toBe("empty");
    expect(db.prepare("SELECT value FROM app_metadata WHERE key = 'demo_seed_claim'").get()).toBeUndefined();
  });

  it("blocks cleanup when demo data is mixed with a real or unmarked row", () => {
    const db = database();
    seed(db);
    db.prepare(`INSERT INTO reserves
      (id, name, amount_cents, currency, note, is_active, created_at, updated_at)
      VALUES ('real', 'Real reserve', 100, 'EUR', '', 1, 'now', 'now')`).run();
    expect(state(db)).toBe("real-or-mixed");

    executeBatch(db, demoCleanupStatements("cleanup-1", "2026-09-15T00:01:00.000Z"));
    expect(state(db)).toBe("real-or-mixed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM reserves").get()).toEqual({ count: 2 });
  });

  it("makes repeated serialized seed attempts idempotent", () => {
    const db = database();
    seed(db, "winner");
    seed(db, "loser");
    seed(db, "third");

    expect(state(db)).toBe("demo-only");
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT value FROM app_metadata WHERE key = 'demo_seed_claim'").get()).toEqual({ value: "winner" });
  });

  it("atomically reclaims a stale seed claim when every entity row was manually deleted", () => {
    const db = database();
    seed(db, "stale");
    db.exec("DELETE FROM transactions; DELETE FROM planned_transactions; DELETE FROM reserves; DELETE FROM accounts;");
    expect(state(db)).toBe("empty");

    seed(db, "replacement");

    expect(state(db)).toBe("demo-only");
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT value FROM app_metadata WHERE key = 'demo_seed_claim'").get()).toEqual({ value: "replacement" });
  });

  it("recognizes and cleans demo-only remnants even when no account remains", () => {
    const db = database();
    db.prepare(`INSERT INTO reserves
      (id, name, amount_cents, currency, note, is_active, created_at, updated_at, is_demo)
      VALUES ('demo-reserve', 'Demo remnant', 100, 'EUR', '', 1, 'now', 'now', 1)`).run();

    expect(state(db)).toBe("demo-only");
    expect(canCleanupDemoData(state(db))).toBe(true);
    executeBatch(db, demoCleanupStatements("cleanup-remnant", "2026-09-15T00:02:00.000Z"));
    expect(state(db)).toBe("empty");
  });
});

describe("demo provenance migration race", () => {
  it("accepts only the exact duplicate-column race and rejects unrelated failures", () => {
    expect(isDuplicateIsDemoColumnError(new Error("duplicate column name: is_demo"))).toBe(true);
    expect(isDuplicateIsDemoColumnError(new Error("database is locked"))).toBe(false);
    expect(isDuplicateIsDemoColumnError(new Error("duplicate column name: another_column"))).toBe(false);
  });

  it("marks legacy rows as real by default during upgrade", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts (id) VALUES ('legacy')");
    db.exec(demoProvenanceMigrationSql("accounts"));

    expect(db.prepare("SELECT is_demo FROM accounts WHERE id = 'legacy'").get()).toEqual({ is_demo: 0 });
    expect(() => db.prepare("UPDATE accounts SET is_demo = 2 WHERE id = 'legacy'").run()).toThrow();
  });
});
