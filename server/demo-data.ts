import type { DemoDataState } from "../shared/types.ts";

export interface SqlStatement {
  sql: string;
  args?: (string | number | null)[];
}

export const demoEntityTables = ["accounts", "transactions", "planned_transactions", "reserves"] as const;
export type DemoEntityTable = typeof demoEntityTables[number];

export function demoProvenanceMigrationSql(table: DemoEntityTable): string {
  return `ALTER TABLE ${table} ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))`;
}

export function demoStateQuery(): string {
  return `SELECT
    (${demoEntityTables.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(" + ")}) AS total_count,
    (${demoEntityTables.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE is_demo = 1)`).join(" + ")}) AS demo_count`;
}

export function classifyDemoData(totalCount: number, demoCount: number): DemoDataState {
  if (totalCount === 0) return "empty";
  return totalCount === demoCount ? "demo-only" : "real-or-mixed";
}

export function isDuplicateIsDemoColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name:\s*is_demo/i.test(error.message);
}

export function demoSeedStatements(input: {
  claimToken: string;
  checkingId: string;
  savingsId: string;
  transactionId: string;
  salaryId: string;
  mortgageId: string;
  reserveId: string;
  now: string;
  monthStart: string;
  salaryDate: string;
  mortgageDate: string;
}): SqlStatement[] {
  const ownsClaim = `EXISTS (
    SELECT 1 FROM app_metadata WHERE key = 'demo_seed_claim' AND value = ?
  )`;
  const allEntitiesEmpty = demoEntityTables.map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(" AND ");
  return [
    {
      sql: `DELETE FROM app_metadata WHERE key = 'demo_seed_claim' AND ${allEntitiesEmpty}`,
    },
    {
      sql: `INSERT OR IGNORE INTO app_metadata (key, value, updated_at)
        SELECT 'demo_seed_claim', ?, ?
        WHERE ${allEntitiesEmpty}`,
      args: [input.claimToken, input.now],
    },
    {
      sql: `INSERT INTO accounts
        (id, name, type, currency, balance_cents, is_active, created_at, updated_at, is_demo)
        SELECT ?, 'Main account', 'checking', 'EUR', 284500, 1, ?, ?, 1 WHERE ${ownsClaim}`,
      args: [input.checkingId, input.now, input.now, input.claimToken],
    },
    {
      sql: `INSERT INTO accounts
        (id, name, type, currency, balance_cents, is_active, created_at, updated_at, is_demo)
        SELECT ?, 'Savings', 'savings', 'EUR', 620000, 1, ?, ?, 1 WHERE ${ownsClaim}`,
      args: [input.savingsId, input.now, input.now, input.claimToken],
    },
    {
      sql: `INSERT INTO transactions
        (id, account_id, date, amount_cents, currency, description, kind, status, source,
          transfer_group_id, planned_transaction_id, created_at, updated_at, is_demo)
        SELECT ?, ?, ?, -8650, 'EUR', 'Synthetic household shop', 'expense', 'cleared', 'manual',
          NULL, NULL, ?, ?, 1 WHERE ${ownsClaim}`,
      args: [input.transactionId, input.checkingId, input.monthStart, input.now, input.now, input.claimToken],
    },
    {
      sql: `INSERT INTO planned_transactions
        (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count,
          next_date, end_date, is_active, created_at, updated_at, is_demo)
        SELECT ?, ?, 'Synthetic salary', 'income', 280000, 'EUR', 'monthly', 1,
          ?, NULL, 1, ?, ?, 1 WHERE ${ownsClaim}`,
      args: [input.salaryId, input.checkingId, input.salaryDate, input.now, input.now, input.claimToken],
    },
    {
      sql: `INSERT INTO planned_transactions
        (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count,
          next_date, end_date, is_active, created_at, updated_at, is_demo)
        SELECT ?, ?, 'Mortgage', 'expense', 58100, 'EUR', 'monthly', 1,
          ?, NULL, 1, ?, ?, 1 WHERE ${ownsClaim}`,
      args: [input.mortgageId, input.checkingId, input.mortgageDate, input.now, input.now, input.claimToken],
    },
    {
      sql: `INSERT INTO reserves
        (id, name, amount_cents, currency, note, is_active, created_at, updated_at, is_demo)
        SELECT ?, 'Emergency buffer', 300000, 'EUR', 'Protected from normal spending', 1, ?, ?, 1
        WHERE ${ownsClaim}`,
      args: [input.reserveId, input.now, input.now, input.claimToken],
    },
  ];
}

export function demoCleanupStatements(claimToken: string, now: string): SqlStatement[] {
  const hasAnyRows = demoEntityTables.map((table) => `EXISTS (SELECT 1 FROM ${table})`).join(" OR ");
  const hasRealRows = demoEntityTables.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE is_demo = 0)`).join(" OR ");
  const ownsClaim = `EXISTS (
    SELECT 1 FROM app_metadata WHERE key = 'demo_cleanup_claim' AND value = ?
  )`;
  return [
    {
      sql: `INSERT OR IGNORE INTO app_metadata (key, value, updated_at)
        SELECT 'demo_cleanup_claim', ?, ?
        WHERE (${hasAnyRows}) AND NOT (${hasRealRows})`,
      args: [claimToken, now],
    },
    { sql: `DELETE FROM transactions WHERE is_demo = 1 AND ${ownsClaim}`, args: [claimToken] },
    { sql: `DELETE FROM planned_transactions WHERE is_demo = 1 AND ${ownsClaim}`, args: [claimToken] },
    { sql: `DELETE FROM reserves WHERE is_demo = 1 AND ${ownsClaim}`, args: [claimToken] },
    { sql: `DELETE FROM accounts WHERE is_demo = 1 AND ${ownsClaim}`, args: [claimToken] },
    {
      sql: `DELETE FROM app_metadata
        WHERE key = 'demo_seed_claim' AND ${ownsClaim}`,
      args: [claimToken],
    },
    {
      sql: "DELETE FROM app_metadata WHERE key = 'demo_cleanup_claim' AND value = ?",
      args: [claimToken],
    },
  ];
}
