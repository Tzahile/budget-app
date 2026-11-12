# Synthetic browser regressions

`npm run test:e2e` runs six scenarios on desktop Chromium (1280 × 900) and
phone Chromium (Pixel 7). Install the pinned dependencies with `npm ci`, then
run `npx playwright install --with-deps chromium` once for your environment.
`npm run test:e2e:ui` opens the local runner for diagnosis. Node 24 is required
for the harness's built-in SQLite adapter, matching CI.

These are browser-to-database tests: the harness imports the production React
`App`, HTTP handler, repository, migrations, validation, and financial logic.
It replaces only Val Town OAuth, file URLs, and SQLite with the existing test
adapters. React and Twind are bundled locally, so the browser never depends on
remote JavaScript or a live deployed app. The pinned Twind preset predates the
production 950 color utilities; the harness supplies their matching palette
values. Its optional TypeScript peer ranges are overridden to the repository's
existing TypeScript version rather than downgrading the application compiler.

The test-only server binds to `127.0.0.1:4180`. A synthetic cookie selects the
mock OAuth identity; absent and unauthorized cookies exercise the real API
authorization middleware. This behavior exists only in `e2e/harness`; no
production authentication bypass or reset route is added. A loopback-only,
header-guarded reset endpoint clears all financial/audit rows between tests
while preserving applied migrations. A single Playwright worker prevents
concurrent resets, and the database lives only in process memory. Do not point
this harness at a persistent or production database.

## Coverage

| Scenario | Independently asserted results |
| --- | --- |
| Expense/refund create, edit, delete | Starting €1,000 becomes €975 after a €25 expense, €960 after correction to €40, €970 after a €10 refund, €975 after refund correction to €15; deletions restore €1,000 and zero net spending. |
| Owned transfer create, edit, delete | Household cash remains €1,200 and spending remains zero; both account balances follow €100 and €150 transfers and restore after deletion. |
| Planned completion, correction, undo | A €100 unpaid bill leaves €900 available; completion reduces cash to €900 without another commitment deduction; correction to €80 gives €920; undo restores €1,000 cash and the €100 commitment. |
| Reserve and goal | €100 funded protects that amount; a €300 current-month goal leaves €700 available while cash remains €1,000; deleting the goal restores €1,000 available. |
| CSV/XLSX ingestion | A synthetic €12.50 expense changes cash/spending once; the same external ID in XLSX is a duplicate; malformed dates block import without changing totals. |
| Authentication/allowlisting | Browser sign-in and unauthorized states render correctly; protected financial reads and mutations return 401/403. |

Assertions use literal expected amounts, not the production calculator to
derive expected answers. Both viewport projects exercise actual dialogs,
actions, and responsive views and check document overflow. Unexpected browser
runtime errors fail tests. Browser requests are restricted to loopback; fixtures,
uploads, reports, screenshots and traces contain synthetic data only.

**Mock bank-sync browser coverage remains deferred.** The current `main`
has no bank connection/sync UI, and Open Banking retains its provider/BBVA
coverage blocker. These tests do not add a fake production bank integration,
activate a blocked provider, or import code from an unmerged draft. Add a
mocked bank-sync browser scenario when that reviewed UI lands. Existing
canonical-ingestion tests continue to cover normalization and idempotency.

## CI and diagnostics

The existing required `CI / Validate` job runs the complete unit/integration
suite, typecheck, lint, browser installation, these browser scenarios, and
Deno module checks. A failing browser scenario fails the same required gate;
there is no separate optional check. Failure-only HTML reports, screenshots,
and traces are uploaded for seven days and excluded from Git. Locally inspect
`playwright-report/` or use `npx playwright show-trace <trace.zip>`.

For environments with a preinstalled compatible Chromium binary, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its absolute path. CI leaves this unset
and uses Playwright's pinned browser. The harness starts as a child of the
Playwright invocation so server and browser share localhost, including in
environments that isolate network access per command. No external credentials,
bank services, production data, or provider requests are needed.
