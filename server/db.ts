import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { demoEntityTables, demoProvenanceMigrationSql, isDuplicateIsDemoColumnError } from "./demo-data.ts";

export const db = sqlite;

let initialized: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  initialized ??= migrate().catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}

async function migrate(): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'cash')),
      currency TEXT NOT NULL DEFAULT 'EUR',
      balance_cents INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS planned_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      recurrence TEXT NOT NULL CHECK (recurrence IN ('once', 'weekly', 'monthly', 'yearly')),
      interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
      next_date TEXT NOT NULL,
      end_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      description TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'refund', 'transfer')),
      status TEXT NOT NULL CHECK (status IN ('cleared', 'pending')),
      source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'planned')),
      external_id TEXT,
      import_identity TEXT,
      transfer_group_id TEXT,
      planned_transaction_id TEXT REFERENCES planned_transactions(id) ON DELETE SET NULL,
      raw_metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS transactions_import_identity_idx
      ON transactions(import_identity) WHERE import_identity IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date)`,
    `CREATE TABLE IF NOT EXISTS planned_completions (
      id TEXT PRIMARY KEY,
      planned_transaction_id TEXT NOT NULL REFERENCES planned_transactions(id) ON DELETE RESTRICT,
      transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
      correction_transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
      occurrence_date TEXT NOT NULL,
      previous_next_date TEXT NOT NULL,
      previous_is_active INTEGER NOT NULL CHECK (previous_is_active IN (0, 1)),
      completed_next_date TEXT NOT NULL,
      completed_is_active INTEGER NOT NULL CHECK (completed_is_active IN (0, 1)),
      completed_revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'undone', 'corrected')),
      operation_token TEXT,
      last_operation_token TEXT,
      created_at TEXT NOT NULL,
      adjusted_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS planned_completions_plan_idx ON planned_completions(planned_transaction_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS reserves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      note TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    {
      sql: `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
      args: [1, new Date().toISOString()],
    },
  ]);
  await applyDemoProvenanceMigration();
  await applyPlannedCompletionMigration();
}

async function applyDemoProvenanceMigration(): Promise<void> {
  const applied = await db.execute("SELECT 1 FROM schema_migrations WHERE version = 2");
  if (applied.rows.length) return;

  for (const table of demoEntityTables) {
    try {
      await db.execute(demoProvenanceMigrationSql(table));
    } catch (error) {
      // Concurrent cold starts can both observe an unapplied migration. Only the
      // exact, recoverable duplicate-column outcome is safe to accept.
      if (!isDuplicateIsDemoColumnError(error)) throw error;
    }
  }

  await db.execute({
    sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)",
    args: [new Date().toISOString()],
  });
}

async function applyPlannedCompletionMigration(): Promise<void> {
  await addColumnIfMissing("planned_transactions", "revision", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("planned_transactions", "latest_completion_id", "TEXT");
  await addColumnIfMissing("transactions", "corrected_from_transaction_id", "TEXT REFERENCES transactions(id) ON DELETE RESTRICT");
  await addColumnIfMissing("transactions", "voided_at", "TEXT");
  await addColumnIfMissing("planned_completions", "last_operation_token", "TEXT");
  await db.execute({
    sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    args: [3, new Date().toISOString()],
  });
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  const columns = await db.execute(`PRAGMA table_info(${table})`);
  if (columns.rows.some((row) => String(row.name) === column)) return;
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}
