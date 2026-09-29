# BudgetApp

A private household cash-flow web app built with Val Town, TypeScript, React,
Hono and val-scoped Val Town SQLite.

The dashboard answers what cash exists now, what is still expected or
committed this month, what is protected, and what is deterministically
available to spend.

## MVP features

- Val Town OAuth with owner/family allowlisting
- accounts and current balances
- manual income, expenses, and owned-account transfers with edit/delete balance reversal
- recurring and one-off planned income/expenses
- mark planned items paid/received, then safely undo or correct the latest completion
- protected reserves and target-date sinking funds linked safely to one-off planned expenses
- projected month-end, deterministic available-to-spend, and six-month cash-flow dashboard
- responsive mobile/desktop React UI
- explicit synthetic demo dataset
- guarded demo cleanup: only a fully provenance-marked demo dataset can be removed, after typing `DELETE DEMO DATA`
- pure financial calculation tests
- canonical transaction ingestion with validated CSV and XLSX adapters, atomic row-level history, and retry-safe import runs
- CSV/XLSX import in Activity with column mapping, row preview, explicit date/decimal formats, and editable saved profiles
- explicit review of detected owned-account transfers from imported transactions
- authenticated versioned JSON backup download of canonical and audit data
- documented provider-neutral Open Banking architecture, consent boundary, and
  BBVA Italy coverage verification gate

All persisted money uses integer EUR cents. See
[`docs/financial-semantics.md`](docs/financial-semantics.md) for the exact
calculation rules, [`docs/database-migrations.md`](docs/database-migrations.md)
for schema-change conventions,
[`docs/backup-format.md`](docs/backup-format.md) for backup format and exclusions,
[`docs/open-banking-architecture.md`](docs/open-banking-architecture.md) for
the Open Banking integration boundary, and [`ROADMAP.md`](ROADMAP.md) for
remaining Open Banking and React Native work.

## Local checks

```sh
npm ci
npm run check
```

The deployed module graph can also be checked with Deno:

```sh
deno check --no-lock --allow-import=esm.town,esm.sh index.http.ts frontend/index.tsx
```

No real financial data, statements or credentials belong in this repository.

## CSV and XLSX import

In **Activity → Import bank CSV or XLSX**, choose an account and file. For XLSX,
select the worksheet containing transactions; the same saved CSV mapping profiles
also apply to XLSX. Map date,
description, and either a signed amount or separate positive debit/credit
columns. Optionally map bank transaction ID and status. Choose the source date
format and decimal separator, then preview rows. Any invalid row blocks import;
the preview shows row numbers and safe error summaries. Save a mapping profile
to reuse, edit, or delete it later. The server still routes valid rows through
canonical ingestion, including duplicate handling and transfer detection.
XLSX supports up to 500 KB compressed, 20 worksheets, 2,000 rows per sheet,
30 columns per sheet, and 8 MB total uncompressed ZIP contents. Encrypted,
corrupt, and formula-containing workbooks are rejected; export values instead.

## Deployment

GitHub `main` is the source of truth. `.github/workflows/deploy.yml` tests the
app and runs `vt push` on every push.

Initial setup:

1. Store a val read/write token as the GitHub Actions secret
   `VAL_TOWN_API_KEY`.
2. Push to `main`. The first workflow run creates the public-code `budget-app`
   val, deploys it and commits its non-secret `.vt/state.json` project identity.
   Financial API routes remain protected by OAuth and owner allowlisting.
3. Optionally set `BUDGET_APP_ALLOWED_USERS` in the Val Town environment to a
   comma-separated list of additional family Val Town usernames. The val owner
   is always allowed.
4. Later pushes test and deploy the exact Git revision.

Never edit production code only in the Val Town web editor: the next GitHub
deployment intentionally overwrites it.
