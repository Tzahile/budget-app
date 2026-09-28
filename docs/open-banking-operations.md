# Open Banking operations

The GoCardless Bank Account Data adapter is a candidate for read-only EU account
information. Before enabling a live connection, verify the provider's current
Italy institution catalog contains **BBVA Italy** (the Italian branch, not BBVA
Spain), check the account-information service terms and price, and complete a
user-consented test of accounts, balances, booked transactions, and reconnection.
Country-level coverage alone is insufficient. Keep the UI unavailable until the
catalog confirms the institution and the required configuration exists.

## Configuration

Set provider secrets in the deployment secret store, never in source control or
client configuration. `BUDGET_APP_GOCARDLESS_SECRET_ID` and
`BUDGET_APP_GOCARDLESS_SECRET_KEY` are application credentials. The bank login
and SCA flow takes place only on the provider/bank pages. The Val Town owner
and explicitly allowed users remain the only BudgetApp users.

Set `BUDGET_APP_BBVA_ITALY_INSTITUTION_ID` only after the live catalog and
consented functional test confirm the exact Italian institution. Runtime
catalog membership is checked again before issuing a consent link. An unset
ID leaves the connection control unavailable.

Use an exact deployed HTTPS origin for the redirect. The callback must return
to the same Val Town session that began consent. A one-time, short-lived state
is bound to the username and requisition. Do not include credentials, tokens,
account IDs, IBANs, or transaction details in URLs, logs, screenshots, or
support tickets.

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
