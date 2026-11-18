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
The current provider URL remains tied to its Val Town trigger. Treat a trigger
returning 500 as unavailable for fallback. Confirm recovery with the operator
before relying on it.

## Evaluate free hosting

Pilot a free Node service with remote SQLite first because it can use the
existing ExcelJS parser and avoids Workers Free's per-request CPU limit.
Select it only if import latency, memory, persistence and external database
traffic fit the free plans. Keep Workers with D1 as a separate candidate
requiring changes to import processing and queries.

If an owner-controlled domain is already available, use a subdomain such as
`budget.example.com` for a portable HTTPS origin. Otherwise use a free provider
hostname for evaluation and leave the portable hostname decision open. Domain
registration and renewal can cost money. Keep the evaluation on free plans
with no payment method, paid features or automatic upgrades.

### Cloudflare Workers Free and D1

Workers Free allows 100,000 requests per day, 10 ms CPU per request, 128 MB of
memory and a 64 MiB uncompressed Worker bundle. D1 has no egress charge.
D1 Free allows 500 MB per database and 5 GB per account, 5 million rows
read and 100,000 rows written per day, and 7 days of point-in-time recovery.
D1 limits individual statements to 100 KB and 100 bound parameters. Free
invocations allow 50 queries, with a batch counting as one query for that
limit. BudgetApp's identity lookup binds up to 500 values per statement, so
a 101-row import can exceed D1's parameter limit. Adapt the lookup to use at
most 100 bindings per statement without splitting an atomic financial write.
See [the ingestion lookup](../server/repository.ts#L264-L268). Cloudflare
advertises no card to start on its developer platform. Use `workers.dev` for
evaluation or a custom hostname on an active Cloudflare zone if the owner
approves the DNS setup.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers and D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Cloudflare developer plans](https://www.cloudflare.com/plans/developer-platform/),
and [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

D1 can be created with an EU database jurisdiction. The Worker still handles
requests globally on this free plan, so this choice needs separate approval
for processing financial request bodies at the edge. Node compatibility covers
only a subset of APIs. The ExcelJS workbook parse and OAuth callback need tests
against the real Workers runtime and CPU limit.
[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/),
[Cloudflare regional services](https://developers.cloudflare.com/data-localization/),
and [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

### Render Free with hosted Turso/libSQL

Render Free supports Docker or Node, managed TLS and custom domains without a
card. Its free service has 0.1 CPU, 512 MB RAM and 750 running hours per
workspace per month. It sleeps after 15 idle minutes and takes about a minute
to wake. Hobby includes 5 GB outbound bandwidth per month and 500 standard
build minutes per month. Render can suspend a free service for high
service-initiated traffic, including calls to an external database. Its
filesystem is ephemeral and its free Postgres expires after 30 days. Choose
Frankfurt for the Node service if evaluating EU deployment.
[Render free plan](https://render.com/docs/free),
[compute limits](https://render.com/articles/from-side-project-to-production-scaling-your-first-app),
[Docker signup](https://render.com/hosting/docker),
[bandwidth](https://render.com/docs/outbound-bandwidth),
[build minutes](https://render.com/docs/build-pipeline), and
[regions](https://render.com/docs/regions).

Turso Cloud lists a no-card free plan with 5 GB storage, 500 million reads and
10 million writes measured in rows per month, and one day of point-in-time
restore. Evaluate a libSQL database using a server-side database token. Turso
offers EU locations including Frankfurt and Dublin. Confirm the selected
libSQL engine and region are available together on the free plan. Rehearse
OAuth across a cold restart and keep an independent backup. Review continued
free availability before cutover following the announced acquisition by
Supabase. [Turso pricing](https://turso.tech/pricing),
[locations](https://turso.tech/blog/turso-cloud-now-runs-in-singapore-and-frankfurt),
[TypeScript SDK reference](https://github.com/tursodatabase/turso-docs/blob/main/sdk/ts/reference.mdx),
and [acquisition announcement](https://turso.tech/blog/turso-is-joining-supabase).

### Existing owner-operated host

If the owner already runs an always-on, maintainable host with persistent
storage, a single Node.js 24/Hono process can keep SQLite on disk. The
[synthetic browser harness](browser-tests.md) already runs Hono against Node
SQLite. Confirm existing HTTPS reachability, access for the household,
sufficient disk and memory, private off-host backups, recovery after a
restart and who owns OS patches. Power, connectivity and storage are the
owner's responsibility. This is a free candidate only if it needs no new
hardware, subscription or domain purchase.

### Local XLSX measurement

A single Chromium run against the Node.js 24 harness on `main` at
`46e09a7` imported all 2,000 synthetic rows from a 30-column workbook
(384 KB compressed, 7.49 MB expanded), with zero duplicates or ambiguities.
Metadata, preview and commit requests each took about 24–30 seconds of Node
process CPU and 26–35 seconds elapsed. The Node process peaked at 496 MiB
RSS, including Vite and in-memory SQLite and excluding Chromium. A warm
20-row workbook used 32–45 ms of process CPU per request. These local
measurements flag request duration and memory headroom for the free Node
pilot. Provider runtime measurements and remote SQLite behavior still
need verification.

### Synthetic pass criteria

1. On a provider-hosted free test deployment, submit valid synthetic XLSX
   workbooks near the 500 KB compressed and 8 MB expanded limits, including a
   2,000-row sheet and a workbook with up to 20 sheets. Run preview and import
   end to end. Check startup, CPU, memory, request duration, database usage
   and cold OAuth login where applicable within the actual plan limits. Include an oversized workbook rejection without
   committed rows.
2. Against the candidate's real database and adapter, restore a fresh
   synthetic database and run a maximum-size import. Force a late failure in
   a grouped transaction and verify the whole batch, balance changes and
   ingestion history roll back. Retry successfully and confirm no duplicate
   rows, correct integer-cent balances and consistent Europe/Rome dates.
   Verify data survives host redeploy. Eliminate candidates that cannot pass
   within free limits. If no option passes, preserve the backup and return the
   hosting choice to the owner.

## Implement the selected port

Before provisioning production, implement and verify these changes through a
pull request.

1. Extract the reusable Hono routes from [`index.http.ts`](../index.http.ts).
   Add the selected runtime entry point and database adapter. Preserve
   `db.execute` results, atomic `db.batch` operations, foreign keys and the
   migration ledger in [`server/migrations.ts`](../server/migrations.ts). For
   local SQLite, keep the database and its journal files on persistent disk.
2. Build the React assets with the app and serve them from the same origin.
   Replace Val Town's `__immutable` URL helpers, remove its runtime scripts and
   module imports, and update the CSP to match the new assets. Point `/source`
   at the GitHub source. Keep the Hono home route, `/api/*` and `/auth/*`
   on the runtime. If using Workers Static Assets, test that an asset or SPA
   fallback cannot intercept those routes.
   [Workers asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).
3. Confirm an OpenID Connect provider supports this household's identities,
   permitted users and callback URLs on a free plan. Register the exact
   `https://budget.example.com/auth/callback` URI, substituting the operator's
   real hostname in the provider settings. Register staging separately.
   Replace `getOAuthUserData` and `oauthMiddleware` and map the current Val Town
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

1. The repository owner should take a protected SQL dump now using the
   [val-scoped SQLite admin](https://docs.val.town/reference/std/sqlite/admin),
   which is separate from the app's HTTP trigger. Verify that the dump contains
   schema objects, every table and the migration ledger. Keep this early backup
   even if the app trigger is unavailable. The app's
   [JSON backup](backup-format.md) is a useful independent copy when the app
   is healthy. It excludes internal fields and has no restore endpoint. Keep
   dumps and backups outside Git, CI and chat.
2. Deploy and verify an operator-controlled write gate on the old app through
   GitHub `main` **before December 10**. Val Town's code freeze leaves its
   SQLite writable. The current app has no write-freeze control. Rehearse
   toggling the gate and draining in-flight operations with synthetic data.
   Cover all database writers, including background jobs and lazy schema
   migrations. Verify how the gate can be toggled after the platform goes
   read-only. If that cannot be confirmed, close it before December 10
   and keep the source read-only until cutover. The current deployment
   workflow pushes on every merge to `main`. Before activating the cutover
   gate, change that workflow through a reviewed PR so it can deploy only
   an explicitly approved, tested `main` SHA during the transition. Record and verify the gated fallback SHA and retire the
   old push workflow after cutover. Confirm that merging later changes
   cannot overwrite the gated Val Town deployment.
3. Qualify the destination's restore method with synthetic data using the
   applicable restore and validation steps below. For D1 or libSQL, verify
   failure behavior using an isolated, empty database and require an
   all-or-nothing promotion. If an import leaves partial data, discard that
   database and repeat against a fresh one.
   [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
4. After the synthetic restore passes, close the source write gate if it is
   still open, stop other writers, wait for in-flight writes to finish, and
   confirm the source rejects new writes. Keep the destination write gate
   closed. Take a **new SQL dump** from the val-scoped SQLite admin. Verify
   the export completed and privately record its origin, timestamp, schema
   version, file size and SHA-256 checksum. Keep the early and final originals
   separately protected and verify the final checksum again before restore.
   Use the new dump as the production restore source. Retain the early dump
   as a fallback.
5. Restore from the verified final dump using the rehearsed method. For D1 or
   libSQL, import into a new isolated database and bind the app only after
   verification. For disk-based SQLite, restore into a fresh staging file on
   the destination filesystem with errors treated as fatal. Stop the app and
   close all database connections before replacement. Checkpoint WAL files
   and close cleanly, verifying no outstanding WAL state. Preserve the old database
   and any matching `-wal` and `-shm` companions together, and keep those
   sidecars out of the replacement. Verify the staged checksum after upload,
   sync the staged file, then atomically rename it on the same filesystem
   and sync the containing directory. [SQLite WAL guidance](https://www.sqlite.org/wal.html).
6. For disk restores require `PRAGMA integrity_check` to return `ok` and
   `PRAGMA foreign_key_check` to return zero rows. For hosted restores use
   provider-supported integrity and foreign-key checks. For all targets,
   compare table counts and deterministic per-table hashes over rows ordered
   by primary key and encoded with the same types. Compare schema, indexes,
   migration versions and per-account balances in integer cents with the
   source before binding traffic. Keep row hashes and comparison output
   private. Preserve app metadata, import retry keys and provenance. Any
   intentional transformation or exclusion requires a documented reason and
   a verified equivalent. Verify that date-only values and Europe/Rome
   month boundaries match in rehearsal.
7. Bind the chosen hostname and wait for valid TLS. Verify the app shell,
   asset loading and anonymous session as above. The operator should confirm
   approved sign-in and denial for an unapproved account. Check anonymous and
   unapproved requests to `/api/data` and `/api/export` return 401 and 403
   respectively without financial content. In synthetic rehearsal verify
   same-origin writes and rejection of a foreign origin. On the final
   hostname confirm the callback, session and assets use the canonical
   origin, and signing out clears the session. If using a custom domain,
   disable the default and preview hosts where supported and make the
   app reject unexpected hosts before auth or database work. Confirm the
   alternate hosts cannot serve protected routes.
   [Render domain controls](https://render.com/docs/custom-domains) and
   [Workers preview domain controls](https://developers.cloudflare.com/workers/previews/custom-domains/).
   Record status, result and Git SHA without account details or financial
   values. Open only the destination write gate after confirming the
   source still rejects writes.
8. For an optional old `val.run` bookmark redirect, wait until the replacement
   is verified. A redirect immediately diverts traffic from the old trigger
   and becomes permanent on December 10. If using it, disable path and query
   forwarding so stale OAuth callback parameters stay off the new origin.
   Keep the old redirect off while rollback to the old trigger is still needed.
   [Val Town redirect behavior](https://docs.val.town/migration/redirects).

## Rollback

Keep both the last verified Git SHA and final source backup available to the
operator. Before the destination accepts writes, keep both sides gated during
rollback. Use Val Town as a fallback only after the operator verifies the
gated SHA, TLS, app routes and OAuth on the old origin. Restore its DNS or
login configuration if changed, then reopen only the source write gate.
If the old origin still returns 500 or its gate cannot be safely reopened,
keep both sides gated and recover from the verified backup on an approved
host. Val Town code rollback requires a revert through GitHub `main` and
its deploy workflow before December 10.

After the destination accepts writes, freeze it and preserve a fresh backup.
Treat the destination database as authoritative. Roll back app code through a
revert on `main` only after confirming the last good revision can read the
current schema. Switch database authority only if a reverse restore has been
rehearsed and all post-cutover writes reconcile. Keep both gates closed during
that verification, then open the gate only for the verified writer. After
January 10, rollback requires a compatible known-good deployment and database
off Val Town.
