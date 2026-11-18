# AI advisory data boundary

`createRedactedFinancialSnapshot` in `shared/ai-advisor.ts` builds the versioned
`RedactedFinancialSnapshotV1` from the existing deterministic dashboard. It is
pure, has no database or network access, and selects each field explicitly.
The snapshot is frozen and detached from mutable dashboard arrays. It is **not**
a safe-to-spend recommendation; `availableToSpendCents` is the accounting fact
defined in `financial-semantics.md`.

## Schema version 1

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Literal `1` for future schema negotiation. |
| `currency` | Literal `EUR`; amounts are integer cents. |
| `asOfMonth` | Month only, `YYYY-MM`. |
| `currentCashCents` | Sum of active account balances. |
| `spentThisMonthCents` | Net cleared spending for the month. |
| `remainingIncomeCents`, `remainingExpensesCents` | Aggregate committed cash flow. |
| `protectedReservesCents` | Funded reserves and required goal contributions, adjusted for linked expense coverage. |
| `projectedMonthEndCents`, `availableToSpendCents` | Deterministic monthly calculation. |
| `projectionMonths[]` | Month and aggregate expected income, committed expenses, protected reserves, projected month-end, and available-to-spend amounts. |

The snapshot excludes account and transaction lists, individual planned
occurrences, descriptions, merchants, account identifiers, IBANs, addresses,
personal names, notes, exact transaction dates, and other free text. Changes to
the dashboard do not enter this payload unless a new, reviewed allowlist field
is added and the schema version is updated. Synthetic negative tests check the
serialized boundary for prohibited data.

`AiAdvisor` is a provider-neutral interface that accepts only the snapshot and
returns advisory text. `server/gemini-advisor.ts` implements an inert server-only
Gemini adapter; constructing it does not make a request. There is no endpoint,
UI integration, automatic request, or logging of payloads. Provider output is advisory
text only; it must not be interpreted as accounting commands or written to
balances, transactions, reserves, or plans. Any future UI should show the exact
payload before an optional external request and require an explicit action.

## Gemini adapter and deployment gate

`GeminiAdvisor` uses the official REST `generateContent` API without an SDK.
The server must inject both `apiKey` (from secret storage) and an explicit
`model` supporting structured JSON. No key is read from browser configuration.
The adapter never retries, switches models, enables billing, or falls back to a
paid service. Free-tier availability and quota are properties of the chosen
Google project/model, not something this adapter can guarantee. Check the
[current pricing and model availability](https://ai.google.dev/gemini-api/docs/pricing)
and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) before any
deployment; do not enable billing to circumvent the free-only constraint.

**Italy live rollout is blocked under the current free-only requirement.**
The [Gemini API terms](https://ai.google.dev/gemini-api/terms) require Paid
Services when making API Clients available to users in the EEA, Switzerland,
or the UK. Italy is in the EEA. The terms also apply Paid Services data-use
provisions to unpaid usage in those regions; that privacy distinction does not
remove the Paid Services rollout requirement. Outside those regions, unpaid
services can use submitted content and responses to improve Google products
and can involve human review. Redacted aggregates still describe a household's
finances. A compliant provider/billing/product decision must precede activation;
this implementation does not resolve the gate or activate a paid fallback.
Open Banking's existing provider/BBVA verification blocker remains unchanged.

At the egress boundary, runtime validation rejects unknown fields at every
schema level, invalid month strings, unsafe/noninteger cents, accessors,
custom prototypes, sparse arrays, and custom serialization. It does not
silently strip or rewrite a contaminated payload. The user-message text is
exactly `JSON.stringify(snapshot)` after validation, so the future preview and
confirmation flow must display that same snapshot serialization and invoke
the adapter only after explicit confirmation. The fixed system instruction
labels facts, recommendations, assumptions, and uncertainty; the adapter has
no database access, tools, or accounting mutation capability.

The request uses a header credential, a fixed HTTPS host, and rejects redirects.
A default 15-second deadline covers connection and response-body reading (a
server can explicitly set 1–120,000 milliseconds). Responses are limited to
64 KiB before parsing. Only a completed `STOP` candidate is accepted;
provider thought parts are discarded and final text must contain strict JSON
matching `AiAdvice`: a nonempty summary of at most 2,000 characters and at most
10 nonempty considerations of at most 1,000 characters each. Refusal, truncation,
invalid JSON/schema, and oversized output fail closed. Text remains untrusted
advice; a future UI must render it as text, not HTML or executable commands.

`GeminiAdviceError.code` distinguishes `invalid_snapshot`, `configuration`,
`timeout`, `rate_limit` (HTTP 429), `authentication` (401/403), `provider`, and
`invalid_response`. Error messages contain no provider body, input payload,
credential, or raw transport error. A later authenticated consent endpoint
can map these codes to recoverable UI states. Tests use synthetic snapshots
and mocked fetch only; no provider request is made by tests or on startup.

Protocol references: [generateContent REST API](https://ai.google.dev/api/generate-content),
[structured output](https://ai.google.dev/gemini-api/docs/structured-output),
and [API keys](https://ai.google.dev/gemini-api/docs/api-key).
