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
returns advisory text. A future user-triggered adapter can implement it for a
remote or private model. No adapter, endpoint, automatic request, logging of
payloads, or provider credentials are added here. Provider output is advisory
text only; it must not be interpreted as accounting commands or written to
balances, transactions, reserves, or plans. Any future UI should show the exact
payload before an optional external request and require an explicit action.
