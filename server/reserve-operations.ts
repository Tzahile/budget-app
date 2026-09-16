export interface SqlStatement {
  sql: string;
  args: (string | number | null)[];
}

interface ReserveWriteInput {
  id: string;
  name: string;
  fundedAmountCents: number;
  targetAmountCents: number | null;
  targetDate: string | null;
  linkedPlannedTransactionId: string | null;
  note: string;
  now: string;
}

export function createReserveStatement(input: ReserveWriteInput & { contributionMonth: string }): SqlStatement {
  return {
    sql: `INSERT INTO reserves
      (id, name, amount_cents, target_amount_cents, target_date, contribution_month,
        contribution_cents, linked_planned_transaction_id, currency, note, is_active, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 0, ?, 'EUR', ?, 1, ?, ?
      WHERE ? IS NULL OR (
        ? IS NOT NULL AND ? IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM planned_transactions
          WHERE id = ? AND kind = 'expense' AND recurrence = 'once' AND is_active = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM reserves WHERE linked_planned_transaction_id = ?
        )
      )`,
    args: [
      input.id,
      input.name,
      input.fundedAmountCents,
      input.targetAmountCents,
      input.targetDate,
      input.targetAmountCents == null ? null : input.contributionMonth,
      input.linkedPlannedTransactionId,
      input.note,
      input.now,
      input.now,
      input.linkedPlannedTransactionId,
      input.targetAmountCents,
      input.targetDate,
      input.linkedPlannedTransactionId,
      input.linkedPlannedTransactionId,
    ],
  };
}

/**
 * Updates a reserve and atomically records the net funded increase for the
 * current household month. Existing funded money becomes the baseline when a
 * simple reserve is first converted to a goal.
 */
export function updateReserveStatement(input: {
  id: string;
  name: string;
  fundedAmountCents: number;
  targetAmountCents: number | null;
  targetDate: string | null;
  linkedPlannedTransactionId: string | null;
  note: string;
  isActive: boolean;
  contributionMonth: string;
  now: string;
}): SqlStatement {
  return {
    sql: `UPDATE reserves SET
      name = ?,
      contribution_cents = CASE
        WHEN ? IS NULL OR ? IS NULL THEN 0
        WHEN target_amount_cents IS NULL OR target_date IS NULL THEN 0
        ELSE MAX(0,
          CASE WHEN contribution_month = ? THEN contribution_cents ELSE 0 END
          + (? - amount_cents)
        )
      END,
      contribution_month = CASE WHEN ? IS NULL OR ? IS NULL THEN NULL ELSE ? END,
      amount_cents = ?, target_amount_cents = ?, target_date = ?, linked_planned_transaction_id = ?, note = ?,
      is_active = ?, updated_at = ?, is_demo = 0
      WHERE id = ? AND (
        ? IS NULL OR (
          ? IS NOT NULL AND ? IS NOT NULL
          AND (
            linked_planned_transaction_id = ?
            OR (
              EXISTS (
                SELECT 1 FROM planned_transactions
                WHERE id = ? AND kind = 'expense' AND recurrence = 'once' AND is_active = 1
              )
              AND NOT EXISTS (
                SELECT 1 FROM reserves
                WHERE linked_planned_transaction_id = ? AND id <> ?
              )
            )
          )
        )
      )`,
    args: [
      input.name,
      input.targetAmountCents,
      input.targetDate,
      input.contributionMonth,
      input.fundedAmountCents,
      input.targetAmountCents,
      input.targetDate,
      input.contributionMonth,
      input.fundedAmountCents,
      input.targetAmountCents,
      input.targetDate,
      input.linkedPlannedTransactionId,
      input.note,
      Number(input.isActive),
      input.now,
      input.id,
      input.linkedPlannedTransactionId,
      input.targetAmountCents,
      input.targetDate,
      input.linkedPlannedTransactionId,
      input.linkedPlannedTransactionId,
      input.id,
    ],
  };
}
