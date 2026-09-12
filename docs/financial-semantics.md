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

## Transactions

- Income is stored as a positive amount.
- Expenses are stored as a negative amount.
- Refunds are positive cash movements and reduce “spent this month”, never
  below zero.
- Pending transactions do not count as spent. They also do not change a current
  balance until cleared.
- Transfers use two linked transaction legs with a shared transfer group. They
  change individual account balances but are excluded from household income and
  spending. The model supports this now; the transfer-entry UI is deferred.

## Planned items

Planned items do not change account balances. Every unpaid occurrence through
the last day of the month contributes to remaining expected income or remaining
committed expenses, including overdue occurrences.

Marking an occurrence paid or received atomically:

1. creates a cleared transaction;
2. changes the selected account balance;
3. advances the planned item's next date, or deactivates a one-off/ended item.

Monthly and yearly recurrences that target an invalid day are clamped to the
last day of the target month.

## Reserves and dashboard equation

Reserves represent money that still exists in account balances but is protected
from normal spending. They never reduce current cash or projected balance.

```text
projected month-end = current cash + remaining expected income - remaining committed expenses
safe to spend       = projected month-end - active protected reserves
```

Safe to spend may be negative; it is not clamped to zero.
