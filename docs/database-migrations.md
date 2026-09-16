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
