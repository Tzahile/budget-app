# Database migrations

`server/migrations.ts` is the only place that changes the production SQLite
schema. Migrations are ordered by immutable positive integer versions. Each
version contains SQL statements and a short diagnostic name.

At startup, `ensureSchema()` creates the migration ledger when necessary and
applies missing versions in ascending order. A migration's SQL and its
`schema_migrations` record run in one transactional SQLite batch. A failure
therefore rolls back both the schema changes and the version marker. Concurrent
cold starts accept a failure only when the same version marker became visible,
meaning another request completed that immutable migration.

## Adding a migration

1. Append one entry to `migrations`; never edit or renumber an applied entry.
2. Use deterministic SQLite SQL. Do not inspect live rows to decide which
   schema should exist.
3. Preserve existing household data and use integer cents for money.
4. Put every required schema statement in the migration's transactional batch.
5. Add a synthetic upgrade fixture covering the previous schema version and a
   failure/rollback case when the migration has multiple dependent statements.
6. Run `npm run check` and the documented Deno module check.

The initial schema intentionally represents version 1. Fresh databases follow
the same version-by-version path as upgrades, preventing a separate fresh
schema definition from drifting away from production migrations.

Version 9 adds source-neutral ingestion history. `imports` is the run-level
record, while `ingestion_items` contains one accepted, duplicate, error, or
ambiguous outcome for each non-empty source position. The optional retry key is
unique within an account and source. Run creation, item history, accepted
transactions, and balance effects are committed together; failed validation or
ambiguity runs commit audit history only.


Version 13 adds currency guards without rewriting existing amounts or codes.
New codes must use three uppercase letters. Denomination changes are rejected;
linked transactions, plans and reserves must use the same currency as their
account or obligation. Existing unsupported data remains exportable, and the
calculation/view boundaries reject it rather than combining or relabeling it.

## Version 16: optional Android notification source

Versions 14 and 15 are reserved for Open Banking. The migration runner checks
each version individually, so this feature can deploy while those versions are
pending. When both land, retain the reviewed Open Banking backup projections
and format version with schema version 16.

Preserves every existing import source while extending its constraint with
`android_notification`. Adds a private request fingerprint and a partial unique
index for notification delivery IDs across the household. Notification IDs
identify delivery retries, never bank transactions. An import insert trigger
requires an active account for new notification runs. A transaction insert trigger
rejects possible notification/statement overlaps (same account and signed amount
within three calendar days) within the atomic ingestion batch. It does not alter
existing transactions or balances. Export projections were reviewed at schema 16;
request fingerprints and delivery retry keys remain excluded.
