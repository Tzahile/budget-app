# Financial calculation semantics

BudgetApp stores money as integer minor units (EUR cents). Floating-point
amounts are never persisted or used in calculations.

## Dates and month boundary

- User-entered financial dates are calendar dates in `YYYY-MM-DD` format.
- “Today” and month boundaries use the household time zone `Europe/Rome`.
- A planned item's `nextDate` is its earliest unpaid occurrence. Items due today
  or overdue remain unpaid until explicitly marked paid or received.

## Current cash

`current cash` is the sum of the current balances of active accounts. Account
balances are current cleared balances, not opening balances. Creating a manual
transaction changes its account balance in the same SQLite batch. Editing or
deleting that transaction applies the exact inverse balance adjustment.

Inactive accounts are excluded from current cash.

Editing an account never changes its balance. To align BudgetApp with a bank,
the user records a reconciliation with the actual cleared balance, household
calendar date, and optional note. The reconciliation atomically captures the
previous balance, actual balance, and exact difference before updating the
account. A zero-difference reconciliation is retained as an audit checkpoint.
Reconciliation differences are not transactions: they are excluded from
income, spending, planned cash flow, and projections.

## Transactions

- Income is stored as a positive amount.
- Expenses are stored as a negative amount.
- Refunds are positive cash movements and reduce “spent this month”, never
  below zero.
- Pending transactions do not count as spent. They also do not change a current
  balance until cleared.
- Transfers between owned active accounts use two linked, cleared manual
  transaction legs with a shared transfer group: a negative leg in the source
  account and an equal positive leg in the destination. They change individual
  account balances but are excluded from household income and spending. A
  transfer is created, edited, or deleted as one atomic group; its legs cannot
  be independently changed or deleted.
- Imports use the same canonical transaction model as future bank syncs. A
  repeated source record is identified deterministically and is never applied a
  second time. Imported rows retain a bounded source identifier and a minimal
  audit marker, but never raw credentials or bank connection secrets.
- Every ingestion attempt has durable row-level outcomes. Runs containing an
  invalid or ambiguous row are all-or-none failures: valid-looking siblings do
  not change transactions or balances. Retrying an explicit request key returns
  the original audit run; corrected data uses a new key.

## Planned items

Planned items do not change account balances. Every unpaid occurrence through
the last day of the month contributes to remaining expected income or remaining
committed expenses, including overdue occurrences.

Marking an occurrence paid or received atomically:

1. creates a cleared transaction;
2. changes the selected account balance;
3. advances the planned item's next date, or deactivates a one-off/ended item.

Each completion also stores an immutable audit record with the exact unpaid
recurrence state from before and after completion. Only the latest completion
of an otherwise unchanged planned item is adjustable. This eligibility is
derived by the server and enforced again atomically, so a stale browser cannot
undo a newer completion or overwrite a later edit.
Adjustment requests also include the effective transaction ID displayed to the
user. The atomic claim must still match that ID, preventing two correction or
undo requests based on the same version from both succeeding.

Undo voids (but does not delete) the original transaction, reverses its exact
account balance effect, and restores the captured unpaid date and active state.
Correction voids the current effective transaction and creates one linked
replacement with the corrected date, account, and amount. The recurrence
remains advanced. A corrected completion remains adjustable, so another
correction appends to the audit chain and undo reverses the latest effective
transaction. History exposes both the immutable original and current effective
record.
Voided transactions are excluded from account activity and dashboard totals;
completion history remains available for audit.

Monthly and yearly recurrences that target an invalid day are clamped to the
last day of the target month.

## Reserves and dashboard equation

Reserves represent money that still exists in account balances but is protected
from normal spending. They never reduce current cash or projected balance.

A reserve may optionally be a goal with a target amount and target date. Its
funded amount is already protected. At the start of each household month, the
shortfall is divided across the current month through the target month,
inclusive, and rounded up to a whole cent. Net increases to the funded amount
during that month count toward that fixed monthly contribution, so recording a
contribution cannot create a second contribution for the same month. Partial
increases reduce what is still required; decreases restore it, down to the
month-start funded baseline. In the next month the current funded amount becomes
the new baseline and a new contribution is calculated.

Creating a goal, or converting a simple reserve into one, treats its initial
funded amount as preexisting money rather than a contribution for that month.
Editing a goal's target amount or date recalculates the schedule from the same
month-start baseline and preserves funding already added that month. Removing a
goal clears its monthly progress. A goal due this month or overdue requires its
full remaining shortfall. Completed, overfunded, inactive, and non-goal reserves
require no contribution. The amount still required this month is protected from
available-to-spend, but it does not change the account balance until the user updates
the funded amount.

```text
projected month-end = current cash + remaining expected income - remaining committed expenses
gross protection    = funded active reserves + required goal contributions this month
protected reserves  = gross protection - linked coverage due this month
available to spend  = projected month-end - protected reserves
```

Available to spend may be negative; it is not clamped to zero. It is a
deterministic accounting result, not a recommendation that the amount is safe
to spend. Advisory safe-to-spend guidance is a separate, optional future
feature: it may account for uncertainty, buffers, income stability, and other
judgment, but must never alter this calculation or any accounting data.

## Multi-month projection

The dashboard also projects the current partial month plus the following five
calendar months. Each month starts with the prior projected month-end cash,
then applies only unpaid planned income and expenses due in that month. Past
cleared transactions are already represented by current account balances and
are never applied again.

The projection simulates the monthly contributions needed to meet active goal
deadlines, and shows the resulting protected amount separately from projected
cash. A linked one-off reserve is consumed in the simulation when its planned
expense occurs, so it does not remain protected in subsequent forecast months.
This is a deterministic cash-flow forecast, not an AI recommendation or a
promise that the displayed available amount is safe to spend.

An active target-date reserve may be linked one-to-one to an active, one-off
planned expense. The planned expense remains fully included in projected
month-end cash, because paying it will reduce an account balance. When that
expense is due this month or overdue, its linked goal protection overlaps the
expense rather than creating a second available-to-spend deduction:

```text
linked coverage     = min(planned expense, funded reserve + contribution still required)
protected reserves  = gross protected reserves - linked coverage
```

Unlinked goals are unchanged. A partial goal covers only its protected amount;
protection beyond the expense remains reserved. Inactive goals or planned items
create no overlap. Deleting a planned item unlinks it automatically, while an
inactive linked item keeps the association for later reactivation. Changing a
linked item away from a one-off expense unlinks it.
