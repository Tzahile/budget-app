# BudgetApp

A private household cash-flow web app built with Val Town, TypeScript, React,
Hono and val-scoped Val Town SQLite.

The dashboard answers what cash exists now, what is still expected or
committed this month, what is protected, and what remains safe to spend.

## MVP features

- Val Town OAuth with owner/family allowlisting
- accounts and current balances
- manual income and expenses with edit/delete balance reversal
- recurring and one-off planned income/expenses
- mark planned items paid/received
- protected reserves
- projected month-end and safe-to-spend dashboard
- responsive mobile/desktop React UI
- explicit synthetic demo dataset
- pure financial calculation tests

All persisted money uses integer EUR cents. See
[`docs/financial-semantics.md`](docs/financial-semantics.md) for the exact
calculation rules and [`ROADMAP.md`](ROADMAP.md) for deferred imports, Open
Banking and React Native work.

## Local checks

```sh
npm ci
npm run check
```

The deployed module graph can also be checked with Deno:

```sh
deno check --allow-import=esm.town,esm.sh --node-modules-dir=manual index.ts frontend/index.tsx
```

No real financial data, statements or credentials belong in this repository.

## Deployment

GitHub `main` is the source of truth. `.github/workflows/deploy.yml` tests the
app and runs `vt push` on every push.

Initial setup:

1. Create the Val from this checkout with the official `vt` CLI. Commit the
   generated `.vt/state.json`; it contains project identity, not the token.
2. Store a val read/write token as the GitHub Actions secret
   `VAL_TOWN_API_KEY`.
3. Optionally set `BUDGET_APP_ALLOWED_USERS` in the Val Town environment to a
   comma-separated list of additional family Val Town usernames. The val owner
   is always allowed.
4. Push to `main`; the workflow tests and deploys the exact Git revision.

Never edit production code only in the Val Town web editor: the next GitHub
deployment intentionally overwrites it.
