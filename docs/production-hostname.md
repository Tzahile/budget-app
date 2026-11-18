# Production hostname and migration

Val Town becomes read-only for code and redirect configuration on December 10,
2026. Hosted apps stop running on January 10, 2027. Use the existing trigger
during the transition and plan the durable hostname around a domain the
household controls. Finish any changes to the old app or its redirects before
the December deadline. [Val Town migration guide](https://docs.val.town/migration)
and [redirect schedule](https://docs.val.town/migration/redirects).

## Verify the current deployment

In Val Town, open the project and branch recorded in `.vt/state.json`. Copy the
HTTPS URL of the `index.http.ts` HTTP trigger on the default branch. The
[file metadata API](https://sdk.val.town/api/resources/vals/subresources/files/methods/retrieve)
also exposes this URL as `links.endpoint`. Keep the real origin in private
operator records. GitHub `main` owns the deployed code and
[`deploy.yml`](../.github/workflows/deploy.yml) owns the trigger setup.

Set `APP_ORIGIN` locally to the copied HTTPS origin, without a trailing slash.
From a clean terminal, make anonymous GET requests without following redirects.

```sh
curl -q -fsS --max-time 15 "${APP_ORIGIN}/" | grep -Fq '<title>BudgetApp</title>'
curl -q -fsS --max-time 15 "${APP_ORIGIN}/api/session"
curl -q -sS --max-time 15 -o /dev/null -w '%{http_code}\n' "${APP_ORIGIN}/auth/login"
```

Expect the BudgetApp page, a 200 session response with `authenticated` and
`authorized` both false, and an OAuth redirect. Inspect that redirect locally
without following it. Its decoded callback should return to
`${APP_ORIGIN}/auth/callback`. Keep its Location header private because it can
contain OAuth state. If any check fails, inspect the last deployment and the
trigger's execution logs in the provider dashboard before relying on the URL.
The current provider URL remains tied to its Val Town trigger.

## Proposed replacement

Use an owner-controlled HTTPS subdomain such as `budget.example.com` and keep
DNS access separate from the app host. The proposed first target is a single
Node.js 24/Hono container on Render with local SQLite on a paid persistent disk.
This keeps the existing SQLite schema and transaction model. The synthetic
browser harness already runs the Hono routes against Node SQLite. A production
adapter still needs to preserve `db.execute` results, atomic `db.batch`
operations, foreign keys and the migration ledger in
[`server/migrations.ts`](../server/migrations.ts). Cloudflare Workers with D1
would also provide hosted SQLite semantics and a custom domain, with a
Workers/D1 adapter and separate compatibility tests for writes and migrations.
The Render disk is single-instance and brief deploy downtime is expected.
[Render persistent disks](https://render.com/docs/disks),
[Render custom domains](https://render.com/docs/custom-domains), and
[Val Town's D1 migration guide](https://docs.val.town/migration/cloudflare/migrate-sqlite).

Before provisioning production, implement and verify these changes on synthetic
data through a pull request.

1. Extract the reusable Hono routes from [`index.http.ts`](../index.http.ts).
   Add a production Node entry point and SQLite adapter. Put the database and its
   journal files under the persistent mount. Verify the database survives a
   service restart and redeploy.
2. Build the React assets with the app and serve them from the same origin.
   Replace Val Town's `__immutable` URL helpers, remove its runtime scripts and
   module imports, and update the CSP to match the new assets. Point `/source`
   at the GitHub source.
3. Use a supported OpenID Connect provider and register the exact
   `https://budget.example.com/auth/callback` URI, substituting the operator's
   real hostname in the provider settings. Replace
   `getOAuthUserData` and `oauthMiddleware` and map the current Val Town
   owner and family allowlist to explicitly approved issuer/subject pairs.
   Require a fresh sign-in. Preserve host-scoped secure session cookies,
   `/api/session` and the same-origin mutation checks in
   [`server/security.ts`](../server/security.ts). Configure the canonical
   origin privately on the destination and verify that the request received
   behind TLS termination agrees with it. Use forwarded headers only from the
   configured trusted proxy.
4. Keep build and deployment configuration in Git. Require `CI / Validate`
   on pull requests and deploy the tested GitHub `main` revision, recording
   its SHA. Store identity settings, callback origins and secrets in provider
   configuration. Put no real URLs, identities, credentials or backups in Git
   or workflow output.

## Export, verify and cut over

1. Rehearse a full restore into a fresh SQLite file with synthetic data. For
   production, the repository owner should first confirm access to the
   **val-scoped** SQLite admin and take a protected backup before the service
   shuts down. Use the [Val Town SQLite admin SQL dump](https://docs.val.town/reference/std/sqlite/admin)
   and verify that it contains all required schema objects, rows and migration
   history. The app's [JSON backup](backup-format.md) is a useful independent
   copy, but excludes internal fields and has no restore endpoint. Keep both
   artifacts outside Git, CI and chat.
2. Schedule a write freeze for Val Town, including any enabled automated
   writers. Export a fresh SQL dump after the freeze. Restore it to an empty
   SQLite file with errors treated as fatal. Require `PRAGMA integrity_check`
   to return `ok` and `PRAGMA foreign_key_check` to return zero rows. Compare
   table counts, migration versions and per-account balances in integer cents
   with the source. Verify that date-only values and Europe/Rome month
   boundaries produce the same results in the rehearsal. Upload the verified
   database privately and confirm its checksum before enabling the new app.
3. Bind the domain in Render, set the owner-controlled DNS record and wait
   for a valid TLS certificate. Verify the public app shell, asset loading and
   the anonymous session as above. The operator should confirm that an approved
   account can sign in and an unapproved account gets no household access.
   Verify valid same-origin writes and rejection of a foreign origin in the
   synthetic environment. On the final hostname, confirm sign-in returns to
   the canonical origin, the session and assets use that origin, and sign-out
   clears the session. Record status, test result and Git SHA without account
   details or financial values. Enable writes on only the new host.
4. For an optional old `val.run` bookmark redirect, wait until the replacement
   is verified. A redirect immediately diverts traffic from the old trigger
   and becomes permanent on December 10. If using it, disable path and query
   forwarding so stale OAuth callback parameters stay off the new origin.
   Keep the old redirect off while rollback to the old trigger is still needed.
   [Val Town redirect behavior](https://docs.val.town/migration/redirects).

## Rollback

Keep both the last verified Git SHA and final source backup available to the
operator. Before the new host accepts any writes, a failed cutover can return
users to the previously verified HTTPS URL while Val Town still serves it.
Restore the previous DNS record if it was changed, restore the previous login
configuration and verify the previous app and OAuth flow before lifting its
write freeze. Val Town code can only be rolled back before December 10. Use a
revert through GitHub `main` and its deploy workflow for a Val Town code rollback.

After the new host accepts writes, freeze them and preserve a fresh target
backup first. Roll back code through a revert on `main` only after checking that
the last good revision can read the current schema. If reverting needs a
database restore or switching the writer, reconcile post-cutover writes before
reopening service. After January 10, rollback requires a known-good deployment
and compatible database on the new host.
