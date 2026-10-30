# Open Banking operations

## Provider decision and external acceptance gate (2026-10-31)

The preferred candidate for new personal use is Enable Banking. Its public
[Italy market page](https://enablebanking.com/docs/markets/it/) lists BBVA IT and its
[terms](https://enablebanking.com/terms/) describe personal use of the account holder's
own linked accounts. These public statements are not proof that this user's production
application can connect to BBVA Italy. Follow the provider's
[linked-account onboarding](https://enablebanking.com/docs/api/linked-accounts/).
No paid plan, contract, bank account link or provider activation is created by this code.
GoCardless remains an explicit alternate for existing eligible application accounts;
its current onboarding/eligibility must be checked rather than assuming old free signup
instructions still apply.

Both candidate adapters use the same consent, canonical ingestion, reconciliation
and deterministic accounting boundary. Provider selection is explicit; failures never
fall back to another provider, model or paid service. API behavior follows the
[official Enable Banking API reference](https://enablebanking.com/docs/api/reference/).

## Deployment configuration and first consent test

Store secrets only in Val Town's server environment. Never paste them into an issue,
PR, frontend configuration, screenshot, log or source file.

For Enable Banking, register a **production** personal application, link only your own
accounts through the provider control panel, and configure:

- `BUDGET_APP_BANK_PROVIDER=enable-banking`
- `BUDGET_APP_ENABLE_BANKING_APP_ID`: the provider's application UUID.
- `BUDGET_APP_ENABLE_BANKING_PRIVATE_KEY`: the server-only PKCS#8 RSA PEM private key
  corresponding to the application's registered public certificate. The client signs
  short-lived RS256 JWTs; the key is never sent to the provider or browser.
- `BUDGET_APP_ENABLE_BANKING_ASPSP_NAME=BBVA`: the exact Italian ASPSP name from the
  authenticated catalog. The adapter also requires country IT, personal AIS access and
  a credential-free redirect method. Banks requiring unsupported PSU headers are excluded.
- Register the exact deployed HTTPS callback `<app-origin>/api/bank/callback` in the
  provider dashboard. Authorization state is transmitted separately, not stored in this URL.

`BUDGET_APP_BANK_SYNC_VERIFIED` defaults to unset/disabled. It is an **operator preflight
flag**, not a claim that live acceptance is finished. Set it to literal `true` only after
reviewing current terms/pricing and the application's authenticated BBVA Italy catalog;
this permits the initial user-consented test. It must not be interpreted as evidence of
a successful bank sync. The live acceptance checklist below is separate and remains
incomplete until observed. Clearing the flag blocks new consent and existing sync;
disconnection remains available. The current catalog is checked again before consent.

For the GoCardless alternate, explicitly select
`BUDGET_APP_BANK_PROVIDER=gocardless-bank-account-data`, configure
`BUDGET_APP_GOCARDLESS_SECRET_ID`, `BUDGET_APP_GOCARDLESS_SECRET_KEY`, and the authenticated
`BUDGET_APP_BBVA_ITALY_INSTITUTION_ID`, then perform the same operator preflight.
Do not create direct bank credentials or PSD2 connections.

## Live acceptance checklist — not yet completed

All live steps use the private deployment and bank/provider pages; no real payload
becomes a test fixture, screenshot or repository artifact.

1. Confirm the production application is eligible for personal own-account access,
   that current terms/pricing fit the project, and authenticated catalog coverage is BBVA IT.
2. The user starts consent while signed in to BudgetApp, verifies the provider/bank
   pages, completes SCA themselves and returns to the same authenticated callback session.
3. Verify account list and booked EUR balance; explicitly sync complete booked transactions.
   Confirm dashboard cash and imported history against the bank privately.
4. Repeat sync: no duplicate transactions or balance changes. Test a later incremental sync.
5. Reconnect through a new provider session: local account IDs and cash must remain the same;
   no duplicate household account or repeated transactions. Verify expiry/re-auth behavior.
6. Disconnect: provider session deletion succeeds, later sync is blocked and local history remains.
7. Record only non-sensitive pass/fail evidence and dates in the issue. Keep PR #52 draft
   until these checks and GitHub CI pass. No synthetic test substitutes for live acceptance.

## Recovery

- **Consent expired or bank requests SCA:** mark the connection as requiring
  reauthorization and ask the user to reconnect through the provider. Do not
  retry authorization without a user action.
- **Provider outage or rate limit:** show a safe error code, leave previously
  ingested transactions and balances intact, and retry only on a later explicit
  user action. Do not treat a partial provider response as a complete snapshot.
- **Ambiguous identity:** review the ingestion run. A transaction without a
  stable provider ID must not be silently merged or discarded.
- **Disconnect:** revoke/delete the provider requisition when possible and
  disable further sync. Preserve the local transaction and ingestion history.
  A provider failure during revocation should leave an explicit error state for
  retry, rather than claiming the connection is disconnected.
- **Data export/deletion:** export canonical transactions and redacted ingestion
  history through the household's normal data process. Deleting a connection
  does not delete historical financial records; handle a separate deletion
  request explicitly.

Use synthetic fixtures for tests. Never capture a real consent callback or
provider payload in a test fixture.

## Reconnect and snapshot guarantees

A complete connection snapshot stages account links, transactions, transfer candidates
and booked balance checkpoints in one SQLite batch. A later-account validation or
write failure rolls back the entire snapshot. A connection revision is checked at
commit, so a concurrent disconnect or competing sync invalidates stale work.

A normalized GoCardless account IBAN is hashed with the provider and institution
before storage; the raw IBAN and provider account name are not persisted by this
flow. The hash maps new requisitions/account IDs to the existing local account.
Reconnection supersedes the old local connection and retains transaction identity,
including pending-to-booked revisions. Missing stable identity blocks sync. Legacy
links created without an identity must be verified before reconnecting; the app
never guesses a mapping from names or balances. Provider identifiers, consent state,
identity hashes and connection revision guards are excluded from portable backups.
Only the consent-state digest and exact callback origin/path are stored; the raw
callback state is not duplicated in stored redirect URLs.
