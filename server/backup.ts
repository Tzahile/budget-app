import { db, ensureSchema } from "./db.ts";

/** A backup is a versioned data artifact, not a raw database or provider dump. */
export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_SCHEMA_VERSION = 11;

// Review these projections and increment the format version when the schema
// changes. In particular, never export tokens, raw provider payloads, or
// internal app_metadata claims through SELECT *.
export const BACKUP_TABLES = {
  accounts: "id, name, type, currency, balance_cents, is_active, created_at, updated_at, is_demo",
  planned_transactions: "id, account_id, description, kind, amount_cents, currency, recurrence, interval_count, next_date, end_date, is_active, created_at, updated_at, is_demo, revision, latest_completion_id",
  transactions: "id, account_id, date, amount_cents, currency, description, kind, status, source, external_id, import_identity, transfer_group_id, planned_transaction_id, created_at, updated_at, is_demo, corrected_from_transaction_id, voided_at",
  reserves: "id, name, amount_cents, currency, note, is_active, created_at, updated_at, is_demo, target_amount_cents, target_date, contribution_month, contribution_cents, linked_planned_transaction_id",
  planned_completions: "id, planned_transaction_id, transaction_id, correction_transaction_id, occurrence_date, previous_next_date, previous_is_active, completed_next_date, completed_is_active, completed_revision, status, operation_token, last_operation_token, created_at, adjusted_at",
  account_reconciliations: "id, account_id, date, previous_balance_cents, actual_balance_cents, difference_cents, note, created_at",
  imports: "id, filename, status, row_count, imported_count, duplicate_count, error_summary, created_at, completed_at, source, account_id, ambiguous_count, error_count",
  ingestion_items: "id, import_id, source_position, status, transaction_id, import_identity, error_code, error_summary, created_at",
  ingested_transfer_candidates: "id, outgoing_transaction_id, incoming_transaction_id, status, created_at, decided_at, transfer_group_id",
  csv_mapping_profiles: "id, name, mapping_json, created_at, updated_at",
} as const;

export type BackupTable = keyof typeof BACKUP_TABLES;
export type BackupData = { [K in BackupTable]: Array<Record<string, unknown>> };

export interface BudgetBackup {
  format: "budgetapp-backup";
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  data: BackupData;
}

export async function exportBackup(): Promise<BudgetBackup> {
  await ensureSchema();
  // Every table is read in one SQLite statement, giving the whole export one
  // read snapshot even if another request writes while it is being prepared.
  const projections = Object.entries(BACKUP_TABLES).map(([table, columns]) => {
    const names = columns.split(", ");
    const fields = names.map((name) => `'${name}', ${name}`).join(", ");
    return `(SELECT COALESCE(json_group_array(json_object(${fields})), '[]')
      FROM (SELECT ${columns} FROM ${table} ORDER BY id)) AS ${table}`;
  });
  const result = await db.execute(`SELECT
    (SELECT MAX(version) FROM schema_migrations) AS schema_version,
    ${projections.join(",\n    ")}`);
  const row = result.rows[0];
  const schemaVersion = Number(row?.schema_version);
  // A newly deployed migration must explicitly review portable fields before
  // its data can be downloaded; otherwise a backup could omit needed state.
  if (schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error("Backup schema needs review");

  const data = {} as BackupData;
  for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
    data[table] = JSON.parse(String(row[table])) as Array<Record<string, unknown>>;
  }
  return {
    format: "budgetapp-backup",
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    data,
  };
}
