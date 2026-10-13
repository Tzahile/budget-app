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
returns advisory text. The server-only Gemini adapter in
`server/gemini-advisor.ts` implements it; private providers can implement the
same contract. No API route, UI activation, automatic request, or payload
logging is added. Provider output is advisory
text only; it must not be interpreted as accounting commands or written to
balances, transactions, reserves, or plans. Any future UI should show the exact
payload before an optional external request and require an explicit action.


## Gemini server adapter (#37)

`GeminiAiAdvisor` uses the fixed `gemini-2.5-flash:generateContent` endpoint.
It needs no SDK or additional dependencies. Import it from server code only;
provide `apiKey` from a Val Town server secret named `GEMINI_API_KEY` when the
confirmation flow is implemented. Never send that secret to the browser or
include it in URLs, source files, snapshots, logs, or displayed errors. The key
is sent only in the `x-goog-api-key` request header. Redirects fail closed.

Before network access the adapter checks the complete runtime snapshot allowlist,
month format, schema/currency, safe integer cents, and a maximum of 120 projection
months. Unknown or identifying fields are rejected, including nested ones;
serialization uses detached plain objects. Requests contain this snapshot and
fixed instructions separating deterministic accounting facts from conservative,
assumption-based buffer/safe-spending guidance. No tools, grounding, accounting
mutations, automatic retries, or background requests are enabled.

The structured response is bounded to 64 KiB and must finish normally. Blocked,
truncated, malformed or oversized responses fail closed. Advice is plain text:
a summary (1–2000 characters) and at most ten considerations (1–1000 characters
each). Provider text remains untrusted; the future UI must render it as text,
never HTML or accounting commands. The default 15-second deadline covers both
fetch and response body reading and aborts/cancels pending work. Typed errors
expose only stable codes: `missing_configuration`, `invalid_snapshot`, `timeout`,
`rate_limited`, `provider_error`, and `invalid_response`; provider error bodies
and transport exceptions are never propagated.

### Account setup, quotas and privacy

Official documentation checked on **2026-10-13**:

- [Model pricing](https://ai.google.dev/gemini-api/docs/pricing) lists a free tier
  for Gemini 2.5 Flash. Quotas vary by project; inspect them in AI Studio rather
  than assuming a fixed request allowance. A 429 produces `rate_limited` with
  no automatic retry or fallback that could incur charges.
- [Structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
  documents Gemini 2.5 Flash JSON schema output. Runtime validation remains
  necessary even when a response schema is requested.
- [Gemini API terms](https://ai.google.dev/gemini-api/terms), effective March 23,
  2026, require Paid Services for API clients available to EEA, Switzerland or
  UK users. Gemini API Paid Services require an active billing account. Thus
  free-tier model support does **not** establish zero-cost eligibility for this
  Italy-based household; future activation must resolve account/provider terms
  without enabling billing or incurring charges automatically.

The same terms distinguish data handling: ordinary Unpaid Services may use
inputs/outputs for product improvement and human review; EEA/Switzerland/UK
receive the Paid Services data-handling terms even for unpaid quota. Paid
Services do not use prompts/responses for product improvement but retain them
for limited safety/legal purposes. Redacted aggregate figures can still be
sensitive; redaction is not a guarantee of anonymity.

This issue adds an unwired adapter only. **#36** must show the exact outgoing
snapshot, disclose the provider/privacy implications, and require explicit user
confirmation before invoking it. Dashboard load/refresh must never call it.
No live provider request or real financial data is used by tests. Open Banking
remains subject to its existing blocker and is unaffected.
