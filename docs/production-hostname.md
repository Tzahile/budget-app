# Free production hosting and hostname

The Val Town deployment was a test environment. Start the replacement with a
fresh database initialized from the application's schema migrations. The new
deployment can launch independently of the old trigger.

## Evaluate free hosting

Run the first synthetic pilot on a free Node service with Turso/libSQL. Node can
use the existing ExcelJS parser and avoids Workers Free's per-request CPU limit.
Select the stack only if the actual host and database meet the tests below
within their free quotas. Workers with D1 is a separate candidate that requires
changes to import processing and queries.

Use a provider's free HTTPS hostname by default. An existing owner-controlled
domain is optional if it adds zero cost. Keep hosting, storage, authentication
and TLS at zero cost, without paid features, automatic upgrades or
billable overages. Prefer plans that do not require a payment method. Recheck plan eligibility before launching. If no
candidate passes within these constraints, defer launch.

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
libSQL engine and region are available together on the free plan. Verify
OAuth after a cold start. Review continued free availability before launch
following the announced acquisition by Supabase. [Turso pricing](https://turso.tech/pricing),
[locations](https://turso.tech/blog/turso-cloud-now-runs-in-singapore-and-frankfurt),
[TypeScript SDK reference](https://github.com/tursodatabase/turso-docs/blob/main/sdk/ts/reference.mdx),
and [acquisition announcement](https://turso.tech/blog/turso-is-joining-supabase).

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

### Deno Deploy

Deno Deploy is scheduled to shut down in April 2027, which rules it out for a
durable production hostname. Its managed PostgreSQL and Deno KV options would
also require a storage adaptation for the app's SQLite schema. The Val Town
authentication and asset helpers still need replacement on a Deno host.
[Deno announcement](https://deno.com/blog/cloudflare),
[Deno Deploy docs](https://docs.deno.com/deploy/) and
[database docs](https://docs.deno.com/deploy/reference/databases/).

### Existing owner-operated host

If the owner already runs an always-on, maintainable host with persistent
storage, a single Node.js 24/Hono process can keep SQLite on disk. The
[synthetic browser harness](browser-tests.md) already runs Hono against Node
SQLite. Confirm existing HTTPS reachability, access for the household,
sufficient disk and memory, private off-host backups, recovery after a
restart and who owns OS patches. Power, connectivity and storage are the
owner's responsibility. This is a free candidate only if it needs no new
hardware, subscription, domain purchase or other incremental operating cost.

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

1. Use a separate free test deployment and database. Initialize its schema from
   empty using the application's migrations and load only synthetic fixtures.
   Test XLSX files near the 500 KB compressed and 8 MB expanded limits, including
   a 2,000-row sheet and a workbook with up to 20 sheets. Run preview and import
   end to end and verify an oversized workbook is rejected without committed
   rows. Measure startup, CPU, memory, request duration and database traffic
   under the actual free-plan limits.
2. Against the candidate's real database and adapter, force a late failure in a
   grouped transaction. Verify the whole batch, balance changes and ingestion
   history roll back. Retry and confirm no duplicate rows, correct integer-cent
   balances and consistent Europe/Rome dates. Compare the synthetic records,
   totals and migration ledger after a host restart and again after a redeploy.
3. Confirm HTTPS, cold-start sign-in and access controls on the test deployment
   using the checks below. Keep the test deployment and database credentials
   separate from those used at launch.

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
   Replace `getOAuthUserData` and `oauthMiddleware` and configure the
   authorized household members as explicitly approved issuer/subject pairs.
   Require a fresh sign-in. Preserve host-scoped secure session cookies,
   `/api/session` and the same-origin mutation checks in
   [`server/security.ts`](../server/security.ts). Configure the canonical
   origin privately on the destination and verify that the request received
   behind TLS termination agrees with it. Use forwarded headers only from the
   configured trusted proxy.
4. Keep build and deployment configuration in Git. Require `CI / Validate`
   on pull requests and deploy the tested GitHub `main` revision, recording
   its SHA. Store identity settings, callback origins and secrets in provider
   configuration. Put no real URLs, identities, credentials or financial data in Git
   or workflow output.

## Initialize and verify production

1. Create a separate empty production database on the qualified free plan.
   Run the existing [schema migrations](database-migrations.md) and verify the
   expected migration versions, tables, indexes and foreign keys. Confirm that
   financial tables start empty, with only schema-managed defaults where
   applicable. Rerun migrations and confirm the schema and ledger are unchanged.
   For SQLite on disk, verify persistent storage and use
   `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. For a hosted database,
   use the provider's supported equivalents.
2. Deploy the tested revision to the chosen hostname and verify valid HTTPS,
   the app shell, same-origin asset loading and an anonymous `/api/session`
   response with both `authenticated` and `authorized` false. Check that the
   login callback returns to the exact canonical HTTPS origin, an approved
   household account can sign in, an unapproved account is denied and sign-out
   clears the session.
3. Check that anonymous requests to `/api/data` and `/api/export` return 401
   and that signed-in unapproved requests return 403, without financial
   content. In the synthetic test deployment, confirm same-origin writes
   succeed and foreign-origin writes are rejected. If using a custom domain,
   disable default and preview hosts where supported and verify unexpected hosts
   cannot reach protected routes. Record the deployed Git SHA and the check
   results without account details or financial values.
   [Render domain controls](https://render.com/docs/custom-domains) and
   [Workers preview domain controls](https://developers.cloudflare.com/workers/previews/custom-domains/).
4. Share the verified hostname with the household and retire the legacy Val
   Town deployment workflow through a reviewed pull request. If an old bookmark
   needs a redirect and the configuration window is still open, set it only
   after verifying the replacement and disable path and query forwarding. Val
   Town redirect settings become read-only on December 10, 2026, and hosted apps
   stop on January 10, 2027.
   [Val Town migration guide](https://docs.val.town/migration) and
   [redirect schedule](https://docs.val.town/migration/redirects).
