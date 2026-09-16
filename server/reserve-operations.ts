export interface SqlStatement {
  sql: string;
  args: (string | number | null)[];
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
      amount_cents = ?, target_amount_cents = ?, target_date = ?, note = ?,
      is_active = ?, updated_at = ?, is_demo = 0
      WHERE id = ?`,
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
      input.note,
      Number(input.isActive),
      input.now,
      input.id,
    ],
  };
}
