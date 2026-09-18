# Open Banking adapter architecture and provider evaluation

Status: design decision, 2026-09-18. This describes the boundary to build
before a regulated Open Banking provider is selected. It does **not** implement
a PSD2 connection, collect bank credentials, or make a provider API call.

## Decision

BudgetApp will connect only through a regulated EU account-information
aggregator. The browser receives a provider-hosted consent/authorization URL;
the user authenticates only on the provider/bank pages. BudgetApp never asks
for, receives, logs, or stores bank credentials, SCA codes, access tokens, or
refresh tokens in the browser.

The application owns a provider-neutral interface and canonical ingestion
boundary. A provider adapter owns provider-specific identifiers, authorization
URLs, token handling, pagination, error mapping, and webhook/polling details.
The existing CSV adapter and every provider adapter submit the same normalized
transaction input to the existing idempotent ingestion path.

## Scope and non-goals

- Read-only account, balance, and transaction ingestion.
- Explicit user-initiated connect, reconnect, and sync only. No automatic
  dashboard request calls a provider.
- No payment initiation, card credentials, screen scraping, direct PSD2 bank
  integration, or direct collection of banking credentials.
- A failed or incomplete sync never changes already-ingested transactions or
  account balances.

## Provider-neutral boundary

The future server-only interface is intentionally small. Values use integer
minor units and ISO dates, matching the current canonical model.

```ts
type OpenBankingProvider = "gocardless-bank-account-data" | "tink" | string;

type ProviderConnection = {
  provider: OpenBankingProvider;
  providerConnectionId: string;
  institutionId: string;
  institutionName: string;
  countryCode: string;
  consentExpiresAt?: string;
};

type StartConsentInput = {
  institutionId: string;
  redirectUri: string;
  state: string; // opaque, one-time, server-validated; not a provider secret
};

type StartConsentResult = { authorizationUrl: string };

type NormalizedBankAccount = {
  providerAccountId: string;
  displayName?: string;
  currency: string;
  ibanLast4?: string;
};

type NormalizedBankTransaction = {
  providerTransactionId?: string;
  bookingDate: string;
  valueDate?: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "booked";
  description?: string;
  counterpartyName?: string;
  rawReference: Record<string, string | number | boolean | null>;
};

interface OpenBankingAdapter {
  beginConsent(input: StartConsentInput): Promise<StartConsentResult>;
  completeConsent(input: { code?: string; state: string }): Promise<ProviderConnection>;
  listAccounts(connection: ProviderConnection): Promise<NormalizedBankAccount[]>;
  listTransactions(input: {
    connection: ProviderConnection;
    account: NormalizedBankAccount;
    from: string;
    to: string;
  }): Promise<NormalizedBankTransaction[]>;
  revokeConsent(connection: ProviderConnection): Promise<void>;
}
```

`rawReference` is a strictly allowlisted diagnostic envelope (for example,
provider transaction ID, booking status, and pagination cursor). It must never
contain a full raw provider response, an IBAN, access token, merchant
description, or credentials. Full provider payloads are not persisted.

## Canonical normalization and idempotency

For each fetched transaction, the adapter maps provider fields to the existing
canonical ingestion input:

| Canonical field | Provider mapping rule |
| --- | --- |
| source | Stable `open_banking:<provider>` value |
| source external ID | `providerTransactionId` when present |
| account | Account bound to this connection and provider account ID |
| amount / currency / dates / pending state | Normalized values above, with amounts in minor units |
| description | Provider description only for the authenticated household; never log it |
| audit marker | Connection ID, provider transaction ID, and import/sync run ID only |

Identity remains `source + account + source external ID`. If the provider does
not supply a stable transaction ID, derive the current ingestion fallback tuple
and record a `weakIdentity` flag in the sync run. A weak identity must not
silently merge ambiguous transactions; it requires a documented reconciliation
path. Provider revisions update the matching canonical record only when the
stable provider ID matches. Pending and booked forms must be linked rather than
counted twice.

The ingestion service validates and normalizes a complete page before its
transactional SQLite batch. It creates the sync/import run and all accepted
canonical transaction writes together, just as CSV imports do. Transfer
matching runs after canonical ingestion; it never changes source amount or
identity.

## Consent, secrets, and callback security

1. The user selects an institution from a freshly fetched provider catalog.
2. The server creates a one-time connection attempt with user ID, provider,
   selected institution ID, callback URI, expiry, and cryptographically random
   state. State is single-use and bound to the authenticated user.
3. The browser redirects to the provider authorization URL. It never sees
   provider client secrets or refresh/access tokens.
4. The callback verifies state, expected redirect URI, authenticated user
   binding, and expiry before exchanging any code server-side.
5. Provider tokens/connection secrets are stored only in Val Town secret
   storage or encrypted server-side storage, never in SQLite audit rows,
   client responses, logs, source control, test fixtures, or screenshots.
6. Disconnect revokes provider consent where supported and deletes local
   provider secrets; it preserves canonical transactions and audit history.

The current same-origin mutation policy also applies to connect, callback
finalization, sync, and disconnect endpoints. Callback routes use the provider
verification mechanism and do not accept user-supplied provider identifiers.

## Connection and sync state

Connection state is separate from one sync attempt:

| Connection state | Meaning | Permitted next action |
| --- | --- | --- |
| `consent_pending` | Consent redirect issued; no usable connection | Complete or expire |
| `connected` | Consent valid; manual sync allowed | Sync, reconnect, disconnect |
| `reauth_required` | Consent/token expired or provider requested SCA | Reconnect or disconnect |
| `disconnected` | Local secrets revoked/deleted | Start a new connection |
| `error` | Non-recoverable provider/configuration error | Inspect safe error, reconnect/disconnect |

Each `IngestionRun` for Open Banking records `provider`, connection ID,
account ID, requested date range, started/finished timestamps, inserted,
updated, duplicate, and rejected counts, plus a safe error code. It never
stores authorization codes, tokens, full provider payloads, merchant text, or
IBANs. Sync state is `started`, `succeeded`, `partial`, or `failed`; a failed
run makes no canonical writes. A partial run records its completed cursor/range
and is visible to the user before retrying.

## Provider evaluation: Italy and BBVA

No provider is selected by this issue. Coverage changes and provider institution
catalogs are account/contract dependent, so marketing country coverage is not
proof that a particular bank connection works.

**BBVA Italy result, verified 2026-09-18: not yet eligible to claim support.**
BBVA's own Italian site confirms the relevant institution is `Banco Bilbao
Vizcaya Argentaria, S.A., succursale italiana`, but it does not publish a
public third-party aggregator compatibility assertion. The candidate providers'
official institution catalogs are authenticated/dynamic rather than a stable
public list. Therefore BudgetApp must not label BBVA Italy as supported until a
candidate provider returns that exact Italian institution from its live Italy
catalog and a sandbox/production-consented test successfully reads accounts and
booked transactions. This is an explicit verification gate, not an assumption
from BBVA Spain or generic Italy coverage.

Evaluate each regulated candidate against this acceptance matrix and archive
the dated result in the implementation issue:

| Gate | Required evidence |
| --- | --- |
| Regulatory role | Current authorisation/registration and contractual suitability for account-information access in Italy |
| BBVA Italy discoverability | Live provider catalog result containing the Italian legal/entity/institution record, country `IT`, and immutable institution ID |
| Functional test | User-consented sandbox or non-production test: account list, balance, booked transactions, pagination, and reconnect behavior |
| Data quality | Stable transaction ID, booked/pending distinction, booking/value dates, currency, and historical range adequate for BudgetApp |
| Consent lifecycle | Redirect/callback, SCA/reauth, expiry, revoke/disconnect, and safe error codes documented and testable |
| Privacy and cost | EU processing/DPA terms, retention/subprocessors, pricing/free-tier constraints, rate limits, and webhook/polling model |

Candidate documentation to review at implementation time:

- [GoCardless Bank Account Data documentation](https://developer.gocardless.com/bank-account-data/overview/)
- [Tink documentation](https://docs.tink.com/)
- [TrueLayer Data API documentation](https://docs.truelayer.com/docs/data-api-overview)
- [BBVA Italy legal identity](https://www.bbva.it/general/informazioni-legali.html)
- [European Commission PSD2 overview](https://finance.ec.europa.eu/consumer-finance-and-payments/payment-services/payment-services_en)

These are primary provider/regulator/bank sources, checked on 2026-09-18. The
first selected provider must be re-checked against its live catalog immediately
before implementation because coverage and consent flows change.

## Follow-up implementation dependencies

1. Add encrypted server-side provider-secret storage and a migration for
   `bank_connections` / consent attempts, with access limited to the account
   owner.
2. Add the provider catalog, consent callback, disconnect, and manual sync API
   routes with origin/state/callback validation and rate limits.
3. Implement one adapter after the provider evaluation gate passes BBVA Italy.
4. Extend canonical ingestion for provider revisions and pending-to-booked
   linking; cover idempotency, pagination, retries, and no-write failures with
   synthetic fixtures only.
5. Add a connection/sync UI showing source, last successful sync, consent
   expiry, redacted errors, and reconnect/disconnect controls.
6. Add operational runbooks for provider outage, consent expiry, deletion, and
   data-export requests.
