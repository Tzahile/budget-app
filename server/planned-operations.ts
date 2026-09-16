export interface SqlStatement {
  sql: string;
  args: (string | number | null)[];
}

export interface PlannedSnapshot {
  id: string;
  revision: number;
  accountId: string | null;
  description: string;
  kind: "income" | "expense";
  amountCents: number;
  recurrence: "once" | "weekly" | "monthly" | "yearly";
  intervalCount: number;
  nextDate: string;
  endDate: string | null;
  isActive: boolean;
}

export const PLANNED_COMPLETIONS_QUERY = `SELECT c.*,
  t.id AS effective_id, t.account_id AS effective_account_id, t.date AS effective_date,
  t.amount_cents AS effective_amount_cents, t.currency AS effective_currency,
  t.description AS effective_description, t.kind AS effective_kind, t.status AS effective_status,
  t.source AS effective_source, t.transfer_group_id AS effective_transfer_group_id,
  t.planned_transaction_id AS effective_planned_transaction_id,
  t.corrected_from_transaction_id AS effective_corrected_from_transaction_id,
  t.voided_at AS effective_voided_at, t.created_at AS effective_created_at, t.updated_at AS effective_updated_at,
  original.id AS original_id, original.account_id AS original_account_id, original.date AS original_date,
  original.amount_cents AS original_amount_cents, original.currency AS original_currency,
  original.description AS original_description, original.kind AS original_kind, original.status AS original_status,
  original.source AS original_source, original.transfer_group_id AS original_transfer_group_id,
  original.planned_transaction_id AS original_planned_transaction_id,
  original.corrected_from_transaction_id AS original_corrected_from_transaction_id,
  original.voided_at AS original_voided_at, original.created_at AS original_created_at,
  original.updated_at AS original_updated_at,
  CASE WHEN c.status IN ('completed', 'corrected') AND p.latest_completion_id = c.id
    AND p.revision = c.completed_revision AND p.next_date = c.completed_next_date
    AND p.is_active = c.completed_is_active AND t.id IS NOT NULL THEN 1 ELSE 0 END AS adjustable
  FROM planned_completions c
  JOIN planned_transactions p ON p.id = c.planned_transaction_id
  JOIN transactions original ON original.id = c.transaction_id
  LEFT JOIN transactions t ON t.id = COALESCE(c.correction_transaction_id, c.transaction_id)
    AND t.voided_at IS NULL
  ORDER BY c.created_at DESC`;

export function completePlannedStatements(input: {
  item: PlannedSnapshot;
  completionId: string;
  transactionId: string;
  targetAccountId: string;
  actualDate: string;
  nextDate: string;
  remainsActive: boolean;
  now: string;
}): SqlStatement[] {
  const { item, completionId, transactionId, targetAccountId, actualDate, nextDate, remainsActive, now } = input;
  const signedAmount = item.kind === "expense" ? -item.amountCents : item.amountCents;
  const completedRevision = item.revision + 1;
  return [
    {
      sql: `UPDATE planned_transactions SET next_date = ?, is_active = ?, revision = revision + 1,
        latest_completion_id = ?, updated_at = ?, is_demo = 0
        WHERE id = ? AND revision = ? AND next_date = ? AND is_active = 1`,
      args: [nextDate, Number(remainsActive), completionId, now, item.id, item.revision, item.nextDate],
    },
    {
      sql: `INSERT INTO transactions
        (id, account_id, date, amount_cents, currency, description, kind, status, source,
         planned_transaction_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'EUR', ?, ?, 'cleared', 'planned', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM planned_transactions WHERE id = ? AND latest_completion_id = ? AND revision = ?)`,
      args: [transactionId, targetAccountId, actualDate, signedAmount, item.description, item.kind, item.id, now, now,
        item.id, completionId, completedRevision],
    },
    {
      sql: `INSERT INTO planned_completions
        (id, planned_transaction_id, transaction_id, occurrence_date, previous_next_date, previous_is_active,
         completed_next_date, completed_is_active, completed_revision, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?
        WHERE EXISTS (SELECT 1 FROM planned_transactions WHERE id = ? AND latest_completion_id = ? AND revision = ?)
          AND EXISTS (SELECT 1 FROM transactions WHERE id = ?)`,
      args: [completionId, item.id, transactionId, item.nextDate, item.nextDate, Number(item.isActive), nextDate,
        Number(remainsActive), completedRevision, now, item.id, completionId, completedRevision, transactionId],
    },
    {
      sql: `UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0
        WHERE id = ? AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ?)`,
      args: [signedAmount, now, targetAccountId, completionId],
    },
  ];
}

const claimSql = `UPDATE planned_completions SET operation_token = ?
  WHERE id = ? AND COALESCE(correction_transaction_id, transaction_id) = ?
    AND status IN ('completed', 'corrected') AND operation_token IS NULL
    AND EXISTS (
      SELECT 1 FROM planned_transactions p
      WHERE p.id = planned_completions.planned_transaction_id
        AND p.latest_completion_id = planned_completions.id
        AND p.revision = planned_completions.completed_revision
        AND p.next_date = planned_completions.completed_next_date
        AND p.is_active = planned_completions.completed_is_active
    )
    AND EXISTS (SELECT 1 FROM transactions t
      WHERE t.id = COALESCE(planned_completions.correction_transaction_id, planned_completions.transaction_id)
        AND t.voided_at IS NULL)`;

export function undoPlannedStatements(input: { completionId: string; expectedEffectiveTransactionId: string; token: string; now: string }): SqlStatement[] {
  const { completionId, expectedEffectiveTransactionId, token, now } = input;
  return [
    { sql: claimSql, args: [token, completionId, expectedEffectiveTransactionId] },
    {
      sql: `UPDATE accounts SET balance_cents = balance_cents -
        (SELECT amount_cents FROM transactions WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?)) , updated_at = ?, is_demo = 0
        WHERE id = (SELECT account_id FROM transactions WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?))
          AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)`,
      args: [completionId, now, completionId, completionId, token],
    },
    {
      sql: `UPDATE transactions SET voided_at = ?, updated_at = ?, is_demo = 0
        WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?)
          AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)`,
      args: [now, now, completionId, completionId, token],
    },
    {
      sql: `UPDATE planned_transactions SET
        next_date = (SELECT previous_next_date FROM planned_completions WHERE id = ?),
        is_active = (SELECT previous_is_active FROM planned_completions WHERE id = ?),
        revision = revision + 1, latest_completion_id = NULL, updated_at = ?, is_demo = 0
        WHERE id = (SELECT planned_transaction_id FROM planned_completions WHERE id = ?)
          AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)`,
      args: [completionId, completionId, now, completionId, completionId, token],
    },
    {
      sql: `UPDATE planned_completions SET status = 'undone', adjusted_at = ?, last_operation_token = ?, operation_token = NULL
        WHERE id = ? AND operation_token = ?`,
      args: [now, token, completionId, token],
    },
  ];
}

export function correctPlannedStatements(input: {
  completionId: string;
  expectedEffectiveTransactionId: string;
  correctionTransactionId: string;
  token: string;
  accountId: string;
  date: string;
  amountCents: number;
  now: string;
}): SqlStatement[] {
  const { completionId, expectedEffectiveTransactionId, correctionTransactionId, token, accountId, date, amountCents, now } = input;
  return [
    { sql: claimSql, args: [token, completionId, expectedEffectiveTransactionId] },
    {
      sql: `UPDATE accounts SET balance_cents = balance_cents -
        (SELECT amount_cents FROM transactions WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?)), updated_at = ?, is_demo = 0
        WHERE id = (SELECT account_id FROM transactions WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?))
          AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)`,
      args: [completionId, now, completionId, completionId, token],
    },
    {
      sql: `UPDATE transactions SET voided_at = ?, updated_at = ?, is_demo = 0
        WHERE id = (SELECT COALESCE(correction_transaction_id, transaction_id) FROM planned_completions WHERE id = ?)
          AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)`,
      args: [now, now, completionId, completionId, token],
    },
    {
      sql: `INSERT INTO transactions
        (id, account_id, date, amount_cents, currency, description, kind, status, source,
         planned_transaction_id, corrected_from_transaction_id, created_at, updated_at)
        SELECT ?, ?, ?, CASE WHEN t.kind = 'expense' THEN -? ELSE ? END, t.currency, t.description, t.kind,
          'cleared', 'planned', t.planned_transaction_id, t.id, ?, ?
        FROM planned_completions c JOIN transactions t
          ON t.id = COALESCE(c.correction_transaction_id, c.transaction_id)
        WHERE c.id = ? AND c.operation_token = ?`,
      args: [correctionTransactionId, accountId, date, amountCents, amountCents, now, now, completionId, token],
    },
    {
      sql: `UPDATE accounts SET balance_cents = balance_cents +
        (SELECT amount_cents FROM transactions WHERE id = ?), updated_at = ?, is_demo = 0
        WHERE id = ? AND EXISTS (SELECT 1 FROM planned_completions WHERE id = ? AND operation_token = ?)
          AND EXISTS (SELECT 1 FROM transactions WHERE id = ?)`,
      args: [correctionTransactionId, now, accountId, completionId, token, correctionTransactionId],
    },
    {
      sql: `UPDATE planned_completions SET status = 'corrected', correction_transaction_id = ?, adjusted_at = ?,
        last_operation_token = ?, operation_token = NULL
        WHERE id = ? AND operation_token = ?`,
      args: [correctionTransactionId, now, token, completionId, token],
    },
  ];
}
