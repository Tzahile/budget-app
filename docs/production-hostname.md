# Production migration to Vercel Hobby

Deploy BudgetApp on Vercel Hobby with Node 24 LTS, Hono and its existing React UI. Use Turso
Free for hosted libSQL and GitHub OAuth for sign-in. The household will use the stable
project URL `https://<production-project>.vercel.app`. Val Town was a test deployment with
no data to migrate. Initialize an empty production database from the existing schema
migrations. [Vercel domains](https://vercel.com/docs/domains/working-with-domains) ·
[Node 24 support](https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions)

This stack is selected for [#23](https://github.com/Tzahile/budget-app/issues/23) and awaits
hosted qualification. Keep hosting, database, identity and hostname at $0. If the free tiers
cannot pass qualification, keep production closed and record the blocker in #23.

## Implementation order

1. **Runtime [#75](https://github.com/Tzahile/budget-app/issues/75).** Adapt the Hono
   routes in `index.http.ts` to a Vercel Node entry point. Build the existing React UI from
   `frontend/index.tsx` and replace the Val Town asset helpers and scripts in
   `frontend/root.tsx` with same-origin build assets, including styles and favicon. Route
   assets separately from `/api/*` and `/auth/*`, preserve browser contracts and security
   headers, and add the build to `CI / Validate`. Keep the Val Town entry buildable through
   rollout. [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)
2. **Database [#76](https://github.com/Tzahile/budget-app/issues/76).** Wire a server-side
   libSQL adapter into the runtime's database boundary in `server/db.ts`. Preserve the
   existing `execute` and atomic `batch` contracts, foreign keys, connection-sensitive
   `changes()`, integer cents and Europe/Rome dates. Apply `server/migrations.ts` in a
   controlled step before serving the new schema. Verify the migration ledger, empty
   financial tables on first setup, and safe repeated initialization. Keep an import's
   financial writes in a single atomic operation.
   [libSQL client transaction contract](https://tursodatabase.github.io/libsql-client-ts/interfaces/Client.html)
3. **Authentication [#74](https://github.com/Tzahile/budget-app/issues/74).** Replace Val
   Town OAuth at the Hono session and API middleware boundary. Use GitHub's authorization
   code flow with PKCE S256, one-time expiring state and exact callback URLs. Exchange the
   code server-side, obtain the user's numeric GitHub ID from `/user`, and discard the
   provider token. Request public identity only. The owner confirms which household members
   can use GitHub sign-in and configures their IDs privately. Check the allowlist on protected requests. Preserve
   same-origin write checks and use expiring session cookies with `Secure`, `HttpOnly`,
   host-only scope and an OAuth-compatible `SameSite` policy. Fail closed on invalid state,
   unexpected origins or missing settings.
   [GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
4. **Hosted qualification and launch [#77](https://github.com/Tzahile/budget-app/issues/77).** Start after #75, #76 and #74 are integrated. Verify with a stable HTTPS preview and
   synthetic data, then deploy the qualified revision from `main` to the production origin.

## Environment setup

The owner connects a personal Vercel Hobby project to GitHub and records the stable
production URL. Use the generated branch URL for a dedicated `staging` branch and deploy
the candidate `main` SHA there for hosted qualification. Provision distinct Turso databases
and database-scoped tokens, OAuth apps, session secrets and allowlists for staging and
production. Scope the production variables to Production and the staging variables to
the `staging` branch under Preview. Use local dependencies or test adapters for local tests.
Keep other previews isolated from the staging and production credentials.
[Vercel branch URLs](https://vercel.com/docs/deployments/generated-urls) ·
[Vercel environment variables](https://vercel.com/docs/environment-variables)

| Server setting | Staging example | Production example |
| --- | --- | --- |
| `APP_ORIGIN` | `https://<stable-staging-host>.vercel.app` | `https://<production-project>.vercel.app` |
| GitHub OAuth callback | `https://<stable-staging-host>.vercel.app/auth/github/callback` | `https://<production-project>.vercel.app/auth/github/callback` |
| `TURSO_DATABASE_URL` | `libsql://<staging-database>.turso.io` | `libsql://<production-database>.turso.io` |
| `TURSO_AUTH_TOKEN` | `<staging-database-token>` | `<production-database-token>` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `<staging-OAuth-app-credentials>` | `<production-OAuth-app-credentials>` |
| `SESSION_SECRET` | `<staging-session-secret>` | `<production-session-secret>` |
| `BUDGET_APP_ALLOWED_GITHUB_IDS` | `<approved-test-user-IDs>` | `<owner-approved-household-user-IDs>` |

These names and values are placeholders for the implementation. Register a GitHub OAuth app
per environment and configure the corresponding callback exactly. Store credentials, allowed
IDs and any other provider secrets as server-only settings. Keep tokens, OAuth codes,
identifiers and financial rows out of Git, browser bundles and qualification evidence.

## Hosted acceptance

Vercel Hobby with Fluid compute provides 2 GB of memory with 1 vCPU, a 300-second maximum
function invocation and 4 CPU-hours of active compute per month. The 4.5 MB limit applies to
request bodies and buffered responses. Vercel documents streaming for larger responses.
BudgetApp currently caps XLSX files at 500,000 bytes (about 667 KB in base64) and import
JSON at 1,100,000 bytes. The request fits on paper. Measure the work and response sizes on
the deployed stack. Turso Free currently includes 5 GB storage, 500 million rows read and 10
million rows written per month.
[Vercel function limits](https://vercel.com/docs/functions/limitations) ·
[Hobby usage](https://vercel.com/docs/plans/hobby) ·
[Vercel response streaming](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
· [Turso pricing](https://turso.tech/pricing)

Run `CI / Validate` and the desktop and phone browser regression suite for the candidate.
Then exercise the real Vercel deployment, Turso database and GitHub OAuth with synthetic
records:

- Load the same HTTPS URL on desktop and phone, including after a cold start. Check the UI,
  assets, security headers and absence of Val Town network calls. Verify the exact OAuth
  callback, sign-out and the app's allowlist decisions after GitHub sign-in. Requests to data
  and export return 401 anonymously and 403 for a signed-in nonmember. Verify same-origin
  mutations succeed and foreign-origin mutations fail.
- Upload, preview and commit a synthetic XLSX with 2,000 valid rows and a file size close to
  500,000 bytes. Verify exact counts, integer-cent balances and import history. Retry with
  the same key, including concurrent retries, and verify one committed run with no duplicate
  entries or balance changes.
- Induce a late database statement failure after an import batch starts writing in the
  disposable staging database. Verify rollback across transactions, balances, ingestion
  history/items and transfer candidates. Remove the test fault, retry, and verify exactly
  one committed import and the expected financial state.
- Download `/api/export` and validate the complete, private `budgetapp-backup` JSON
  attachment, format and schema versions, and projected records against the fixture. At the
  time of this plan the format is 3 and schema is 12. The current route buffers
  `JSON.stringify(backup)`. Repeat with a populated fixture that produces more than 4.5 MB
  of JSON and verify a complete download across the buffered response boundary. Use an
  authenticated streamed response if required, while preserving snapshot consistency and the
  existing backup format. Prevent caching of the attachment. A truncated export or provider
  payload error blocks launch.
- Read and export the same records after a fresh function instance and a redeploy. Compare
  schema version, IDs, counts and balances. Record the tested Git SHA, request and response
  sizes, statuses, elapsed times, observed Vercel compute/memory and Turso usage, and
  estimate monthly household use from those measurements. Confirm the free plans have
  headroom with paid features disabled.

## Production launch and rollback

1. Disable automatic production-domain assignment so releases can be gated. Deploy only the
   reviewed `main` SHA with passing `CI / Validate` and hosted acceptance. Confirm the
   production project uses its own empty Turso database and OAuth settings, apply the
   migrations through the controlled step, and verify the schema ledger and absence of
   fixture rows. Stage the exact build and promote it to the production HTTPS hostname after
   the release gate.
   [Vercel promotion](https://vercel.com/docs/deployments/promoting-a-deployment)
2. On the canonical production hostname, verify the HTTPS certificate, landing page and
   assets, exact OAuth callback, approved and denied access, anonymous API denial, and the
   authenticated empty dashboard and versioned export. Record the production deployment ID,
   Git SHA and schema version in #77. Then retire `.github/workflows/deploy.yml` and its
   `VAL_TOWN_API_KEY`, keep `CI / Validate`, and update the README deployment
   instructions. Close #23 only after production acceptance.
3. Before later releases, record the known-good deployment and check that its code and
   captured environment still work with the planned schema and credentials. Keep schema
   changes backward compatible across the rollback window. Vercel Hobby Instant Rollback
   restores only the immediately previous production deployment and its saved environment.
   Use it for code rollback only when the prior deployment remains compatible with the live
   database, credentials and access controls. Leave live data and migrations intact, verify
   HTTPS and access after rollback, and resume promotion with a reviewed and validated
   `main` revision. If this is the first launch or compatibility fails, keep the app closed
   to writes and roll forward with a validated fix.
   [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
