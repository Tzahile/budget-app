# Architecture

BudgetApp is one Val Town project and one deployment:

- `index.http.ts`: Hono HTTP entrypoint, authorization, validation, API routes.
- `frontend/`: client-side React 18 UI based on Val Town's official React +
  Hono starter conventions. Assets use immutable versioned URLs.
- `server/`: idempotent SQLite schema and transactional repository operations.
- `shared/`: canonical domain types and pure cash-flow calculations.
- `tests/`: local Vitest coverage for financial rules.

Val Town's val-scoped SQLite database is the only persistence layer. The app
uses Val Town OAuth, then permits only the val owner plus usernames explicitly
listed in the `BUDGET_APP_ALLOWED_USERS` Val Town environment variable.

All API mutations require both a same-origin `Origin` header and the custom
`X-BudgetApp-Request` header. Inputs are length-bounded, type-checked and passed
to SQLite as query parameters. Financial rows and secrets are not logged.

Future import and sync adapters normalize into the canonical `Transaction`
shape. `external_id`, deterministic `import_identity`, raw metadata, import
history and transfer grouping already have schema support.

Synthetic demo records carry durable row-level provenance. Seed and cleanup
operations use SQLite batch claims so serialized concurrent requests remain
idempotent. Cleanup proceeds only when every stored entity row is demo-marked;
legacy, real, or mixed datasets are never bulk-deleted.

SQLite schema changes use ordered, transactional migrations with a persistent
version ledger. Fresh installs and upgrades follow the same migration path; see
[`database-migrations.md`](database-migrations.md) for the required conventions.
