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

All financial API routes require a Val Town OAuth session and an allowlisted
username. API mutations also require both a same-origin `Origin` header and the
custom `X-BudgetApp-Request` header, preventing a third-party site from using a
browser's session cookie to change data. Mutation bodies must be JSON and are
streamed through a 32 KB hard byte limit, including requests without a reliable
`Content-Length`. Inputs are type-checked and passed to SQLite as query
parameters. Financial rows, request bodies, secrets, and underlying server
error text are not logged.

Every response is marked `Cache-Control: no-store`; the app also sends a
restrictive CSP, `frame-ancestors 'none'`, `nosniff`, same-origin referrer and
opener policies, and disables unused browser permissions. The Val Town OAuth
login/logout routes are intentionally handled by its middleware rather than the
application API.

CSV and future Open Banking adapters normalize into a source-neutral canonical
ingestion input before writing transactions. The CSV endpoint accepts an
explicit column mapping, validates every row before it writes anything, and
keeps a short row-number audit marker only. The ingestion path creates an import
run and imported transactions in one SQLite batch. A SHA-256 identity based on
the source, account, and source external ID (or a stable transaction tuple)
makes repeated imports idempotent; duplicate rows do not change balances.
Pending imported rows are stored but do not affect current balances until a
later sync/reconciliation flow clears them.

Synthetic demo records carry durable row-level provenance. Seed and cleanup
operations use SQLite batch claims so serialized concurrent requests remain
idempotent. Cleanup proceeds only when every stored entity row is demo-marked;
legacy, real, or mixed datasets are never bulk-deleted.

SQLite schema changes use ordered, transactional migrations with a persistent
version ledger. Fresh installs and upgrades follow the same migration path; see
[`database-migrations.md`](database-migrations.md) for the required conventions.
