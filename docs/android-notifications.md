# Optional Android notification ingestion API foundation

This web-phase feature implements a normalized adapter and authenticated submission
path. It does **not** install a native Android listener, parse bank notifications,
obtain notification access, or provide background sync/device authentication.
A later Android client must let the user opt in to notification access, parse locally,
show the normalized values and privacy disclosure, and obtain explicit confirmation
before submission. No bank-specific package or notification format is assumed.

## Independent gate and authentication

`BUDGET_APP_ANDROID_NOTIFICATIONS_ENABLED` must equal the literal `true` in the
server environment to enable either endpoint. It defaults to disabled; clearing
it blocks previews and confirmations immediately. Disabling does not delete
previously confirmed ledger entries or import history.

Both endpoints sit behind the existing Val Town OAuth session, household allowlist,
same-origin `Origin` check and `X-BudgetApp-Request: 1` header. A future native
client must establish a supported authenticated session flow separately; it cannot
upload from a bare background listener or bypass the browser-origin protections.
No bearer token/device pairing flow is added by this issue.

## Contract and confirmation

`POST /api/notifications/android/preview` accepts `{ "event": EVENT }` with JSON
content type. It validates an active local account and returns the normalized
`event`, a generic canonical transaction and a disclosure. It writes nothing.

`POST /api/notifications/android/confirm` accepts
`{ "event": EVENT, "confirmed": true }`. The client must show exactly that event
and require a new deliberate confirmation before sending it. The endpoint returns
201 for a new import or 200 for an exact successful retry. Missing/false/nonboolean
confirmation fails. No dashboard load, refresh, scheduler or provider call submits
notifications automatically. There is no notification collection UI in this phase.

Synthetic `EVENT` example:

```json
{
  "schemaVersion": 1,
  "eventId": "c9326366-3d46-4b40-9d03-874315e25e42",
  "accountId": "2f76b5bd-5f04-4bca-a062-c8c244f82642",
  "date": "2026-10-30",
  "amountCents": -1234,
  "currency": "EUR",
  "kind": "expense"
}
```

`eventId` is a **random delivery UUID generated on-device and retained for retries**,
not an Android notification key, bank reference or bank transaction ID. `accountId`
is an existing opaque local BudgetApp account UUID selected by the user. `date` is
the user-verified booked date in `YYYY-MM-DD`; no timestamp/timezone guessing occurs.
Only nonzero safe integer cents are accepted. Expenses must be negative; income
and refunds positive. The current adapter accepts EUR only. Raw text, titles,
merchant names, descriptions, package identifiers, bank/account/card identifiers,
notes and any extra fields are rejected. Requests have a 2,000-byte limit.

Notifications may represent authorizations, pending payments, reversals or partial
information. The user must verify the settled amount, date and kind. Confirmation
creates **one cleared transaction** and changes the chosen account's balance. It
must not be used to import unverified pending authorizations. The adapter cannot
infer transfers; existing transfer-review workflows apply to confirmed imports.

## Canonical ingestion and duplicate policy

The adapter supplies only a generic `Android notification expense/income/refund`
description plus bounded `{adapter, schemaVersion}` audit metadata. It uses the
same transactional canonical pipeline as CSV/XLSX and bank integrations. Import
history and Activity filters label the source `android_notification`.

The delivery UUID is a retry key, never canonical `externalId`. Exact successful
retries return the existing run with no second balance mutation. The UUID is unique
across local accounts; changing reviewed data or moving the same delivery to another
account returns a conflict. A private SHA-256 fingerprint binds all normalized
reviewed fields to that delivery ID, including failed import attempts. Corrections
need a fresh delivery UUID after resolving the failed run.

A notification cannot prove an economic transaction identity. The backend therefore
rejects **possible overlaps**: an imported transaction in the same account with the
same signed amount within three calendar days, when either side is a notification.
This works in both directions, including later CSV/XLSX/provider imports with a
bank ID or different description. It records a failed run with row-level ambiguity;
it does not silently skip or merge the rows. A database insert guard closes the
concurrent cross-adapter race and rolls back the losing batch. Ordinary repeated
notification fingerprints remain conservative ambiguities rather than trusted IDs.

The three-day window is a conservative heuristic, not bank reconciliation. It can
block legitimate repeated purchases and cannot establish identity across arbitrary
posting delays or changed amounts. Review overlapping sources before importing,
and resolve conflicts with account reconciliation/corrections rather than retrying
under new IDs to force acceptance. No automated bank-linking claim is made.

## Privacy and validation

Server error messages use fixed summaries; raw notification content is never
accepted, logged, stored or sent to AI. Delivery retry IDs and request fingerprints
are internal and excluded from versioned backups, as is raw audit metadata. Portable
financial rows and the bounded source label remain in backups. Only synthetic data
is used in tests. The adapter makes no bank/provider/network requests.
