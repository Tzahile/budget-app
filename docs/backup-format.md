# Backup export format

An authorized household user can click **Download backup** or send an
authenticated `GET /api/export`. The response is a JSON attachment with
`Cache-Control: no-store` and a dated `budgetapp-backup-YYYY-MM-DD.json` name.
It contains sensitive household finances: store it in a protected location.
No export contents are logged by the server.

The root object has `format: "budgetapp-backup"`, `formatVersion: 1`,
`schemaVersion: 10`, an ISO UTC `exportedAt` timestamp, and `data`.
`data` maps database table names to arrays of rows sorted by `id`. Column names
are the original snake_case schema names, nullable values remain `null`,
booleans are SQLite `0` or `1`, and money remains integer EUR cents.
Date-only fields remain `YYYY-MM-DD` and household date semantics use
Europe/Rome. IDs and relations are retained for later migration/import tooling.
All tables and the schema version are read in one SQLite statement, yielding a
consistent read snapshot while other requests may write.

Version 1 includes all rows (no dashboard pagination or voided-row filtering)
from `accounts`, `planned_transactions`, `transactions`, `reserves`,
`planned_completions`, `account_reconciliations`, `imports`, `ingestion_items`,
and `ingested_transfer_candidates`. Explicit columns are listed in
`server/backup.ts`; new migrations must review the projection and increment
`formatVersion` if the artifact changes. A schema version mismatch blocks
export until that review. This is an export artifact; a restore/import endpoint
is not part of version 1.

The export excludes the internal `app_metadata` table, import retry keys,
transaction `raw_metadata`, and all provider credentials, tokens, consent
secrets, and unreviewed future sync tables. The portable ingestion identities,
source, run summary, item decisions, reconciliation records, and transfer
decisions remain in the artifact. When Open Banking storage is introduced,
provider-neutral account mapping and safe sync checkpoints must be explicitly
reviewed and added in a later format version; encrypted provider secrets stay
excluded.
