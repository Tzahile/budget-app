export type MigrationValue = string | number | null;

export type MigrationStatement = string | { sql: string; args: MigrationValue[] };

export interface MigrationResult {
  rows: Array<Record<string, unknown>>;
}

export interface MigrationDatabase {
  execute(statement: MigrationStatement): Promise<MigrationResult>;
  batch(statements: MigrationStatement[]): Promise<unknown>;
}

export interface Migration {
  version: number;
  name: string;
  statements: MigrationStatement[];
}

const initialSchema: MigrationStatement[] = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'cash')),
    currency TEXT NOT NULL DEFAULT 'EUR',
    balance_cents INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE planned_transactions (
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
  `CREATE TABLE transactions (
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
  `CREATE UNIQUE INDEX transactions_import_identity_idx
    ON transactions(import_identity) WHERE import_identity IS NOT NULL`,
  `CREATE INDEX transactions_date_idx ON transactions(date)`,
  `CREATE TABLE reserves (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'EUR',
    note TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE imports (
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
  `CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const migrations: readonly Migration[] = [
  { version: 1, name: "initial schema", statements: initialSchema },
  {
    version: 2,
    name: "demo data provenance",
    statements: [
      "ALTER TABLE accounts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))",
      "ALTER TABLE transactions ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))",
      "ALTER TABLE planned_transactions ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))",
      "ALTER TABLE reserves ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))",
    ],
  },
  {
    version: 3,
    name: "planned completion audit",
    statements: [
      "ALTER TABLE planned_transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE planned_transactions ADD COLUMN latest_completion_id TEXT",
      "ALTER TABLE transactions ADD COLUMN corrected_from_transaction_id TEXT REFERENCES transactions(id) ON DELETE RESTRICT",
      "ALTER TABLE transactions ADD COLUMN voided_at TEXT",
      `CREATE TABLE planned_completions (
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
      "CREATE INDEX planned_completions_plan_idx ON planned_completions(planned_transaction_id, created_at DESC)",
    ],
  },
  {
    version: 4,
    name: "account balance reconciliation",
    statements: [
      `CREATE TABLE account_reconciliations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        date TEXT NOT NULL,
        previous_balance_cents INTEGER NOT NULL,
        actual_balance_cents INTEGER NOT NULL,
        difference_cents INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX account_reconciliations_account_date_idx ON account_reconciliations(account_id, date DESC, created_at DESC)",
    ],
  },
  {
    version: 5,
    name: "reserve goals",
    statements: [
      "ALTER TABLE reserves ADD COLUMN target_amount_cents INTEGER CHECK (target_amount_cents IS NULL OR target_amount_cents > 0)",
      "ALTER TABLE reserves ADD COLUMN target_date TEXT CHECK ((target_amount_cents IS NULL) = (target_date IS NULL))",
    ],
  },
  {
    version: 6,
    name: "reserve monthly contribution progress",
    statements: [
      "ALTER TABLE reserves ADD COLUMN contribution_month TEXT CHECK (contribution_month IS NULL OR length(contribution_month) = 7)",
      "ALTER TABLE reserves ADD COLUMN contribution_cents INTEGER NOT NULL DEFAULT 0 CHECK (contribution_cents >= 0)",
    ],
  },
  {
    version: 7,
    name: "reserve planned obligation links",
    statements: [
      "ALTER TABLE reserves ADD COLUMN linked_planned_transaction_id TEXT REFERENCES planned_transactions(id) ON DELETE SET NULL",
      `CREATE UNIQUE INDEX reserves_linked_planned_idx
        ON reserves(linked_planned_transaction_id) WHERE linked_planned_transaction_id IS NOT NULL`,
    ],
  },
  {
    version: 8,
    name: "canonical ingestion runs",
    statements: [
      "ALTER TABLE imports ADD COLUMN source TEXT NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'open_banking'))",
      "ALTER TABLE imports ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT",
      "CREATE INDEX imports_account_created_idx ON imports(account_id, created_at DESC)",
    ],
  },
  {
    version: 10,
    name: "ingested internal transfer candidates",
    statements: [
      `CREATE TABLE ingested_transfer_candidates (
        id TEXT PRIMARY KEY,
        outgoing_transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        incoming_transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deferred', 'confirmed', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        transfer_group_id TEXT,
        UNIQUE(outgoing_transaction_id, incoming_transaction_id),
        CHECK (outgoing_transaction_id <> incoming_transaction_id),
        CHECK ((status = 'confirmed') = (transfer_group_id IS NOT NULL))
      )`,
      "CREATE INDEX ingested_transfer_candidates_status_idx ON ingested_transfer_candidates(status, created_at)",
    ],
  },
];

export async function migrateDatabase(
  database: MigrationDatabase,
  orderedMigrations: readonly Migration[] = migrations,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  validateMigrationOrder(orderedMigrations);
  await database.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  for (const migration of orderedMigrations) {
    const applied = await database.execute({
      sql: "SELECT 1 FROM schema_migrations WHERE version = ?",
      args: [migration.version],
    });
    if (applied.rows.length) continue;

    const record: MigrationStatement = {
      sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      args: [migration.version, now()],
    };
    try {
      // Val Town SQLite batches are transactional. Keeping the marker in the
      // same batch prevents a failed migration from appearing as applied.
      await database.batch([...migration.statements, record]);
    } catch (error) {
      // Another cold start may have committed while this request was waiting.
      // Version numbers are immutable, so its committed marker is authoritative.
      const concurrent = await database.execute({
        sql: "SELECT 1 FROM schema_migrations WHERE version = ?",
        args: [migration.version],
      });
      if (concurrent.rows.length) continue;
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}

function validateMigrationOrder(orderedMigrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of orderedMigrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new Error("Database migrations must have unique ascending positive integer versions");
    }
    if (!migration.name.trim() || migration.statements.length === 0) {
      throw new Error(`Database migration ${migration.version} must have a name and statements`);
    }
    previous = migration.version;
  }
}
