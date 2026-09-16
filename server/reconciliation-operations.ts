export interface SqlStatement {
  sql: string;
  args: (string | number | null)[];
}

export function reconcileAccountStatements(input: {
  reconciliationId: string;
  accountId: string;
  actualBalanceCents: number;
  date: string;
  note: string;
  now: string;
}): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO account_reconciliations
        (id, account_id, date, previous_balance_cents, actual_balance_cents,
          difference_cents, note, created_at)
        SELECT ?, id, ?, balance_cents, ?, ? - balance_cents, ?, ?
        FROM accounts
        WHERE id = ? AND is_active = 1`,
      args: [
        input.reconciliationId,
        input.date,
        input.actualBalanceCents,
        input.actualBalanceCents,
        input.note,
        input.now,
        input.accountId,
      ],
    },
    {
      sql: `UPDATE accounts
        SET balance_cents = ?, updated_at = ?, is_demo = 0
        WHERE id = ? AND is_active = 1
          AND EXISTS (
            SELECT 1 FROM account_reconciliations
            WHERE id = ? AND account_id = accounts.id
              AND previous_balance_cents = accounts.balance_cents
          )`,
      args: [
        input.actualBalanceCents,
        input.now,
        input.accountId,
        input.reconciliationId,
      ],
    },
  ];
}
