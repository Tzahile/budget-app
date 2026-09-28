import type { MigrationStatement } from "./migrations.ts";

/** Bank posting dates can differ between owned accounts. Keep this narrow to limit false positives. */
export const INGESTED_TRANSFER_DATE_TOLERANCE_DAYS = 3;

export interface TransferDetectionTransaction {
  id: string;
  accountId: string;
  occurredOn: string;
  amountCents: number;
}

export interface IngestedTransferPair {
  outgoingTransactionId: string;
  incomingTransactionId: string;
}

export function detectIngestedTransferPairs(
  transactions: readonly TransferDetectionTransaction[],
  dateToleranceDays = INGESTED_TRANSFER_DATE_TOLERANCE_DAYS,
): IngestedTransferPair[] {
  if (!Number.isSafeInteger(dateToleranceDays) || dateToleranceDays < 0) {
    throw new Error("date tolerance must be a non-negative integer");
  }
  const outgoing = transactions.filter((transaction) => transaction.amountCents < 0);
  const incoming = transactions.filter((transaction) => transaction.amountCents > 0);
  const pairs: IngestedTransferPair[] = [];
  for (const debit of outgoing) {
    for (const credit of incoming) {
      if (debit.accountId === credit.accountId) continue;
      if (-debit.amountCents !== credit.amountCents) continue;
      if (calendarDayDistance(debit.occurredOn, credit.occurredOn) > dateToleranceDays) continue;
      pairs.push({ outgoingTransactionId: debit.id, incomingTransactionId: credit.id });
    }
  }
  return pairs;
}

export function insertTransferCandidateStatements(input: {
  pairs: readonly IngestedTransferPair[];
  now: string;
  createId?: () => string;
}): MigrationStatement[] {
  const createId = input.createId ?? (() => crypto.randomUUID());
  return input.pairs.map((pair) => ({
    sql: `INSERT OR IGNORE INTO ingested_transfer_candidates
      (id, outgoing_transaction_id, incoming_transaction_id, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)`,
    args: [createId(), pair.outgoingTransactionId, pair.incomingTransactionId, input.now],
  }));
}

export function decideTransferCandidateStatements(input: {
  candidateId: string;
  decision: "confirm" | "reject" | "defer";
  transferGroupId: string;
  now: string;
}): MigrationStatement[] {
  if (input.decision === "confirm") {
    return [
      {
        sql: `UPDATE ingested_transfer_candidates
          SET status = 'confirmed', decided_at = ?, transfer_group_id = ?
          WHERE id = ? AND status IN ('pending', 'deferred')
            AND EXISTS (
              SELECT 1 FROM transactions outgoing
              JOIN transactions incoming ON incoming.id = incoming_transaction_id
              WHERE outgoing.id = outgoing_transaction_id
                AND outgoing.source = 'import' AND incoming.source = 'import'
                AND outgoing.status = 'cleared' AND incoming.status = 'cleared'
                AND outgoing.kind = 'expense' AND incoming.kind = 'income'
                AND outgoing.account_id <> incoming.account_id
                AND outgoing.amount_cents = -incoming.amount_cents
                AND outgoing.transfer_group_id IS NULL AND incoming.transfer_group_id IS NULL
            )`,
        args: [input.now, input.transferGroupId, input.candidateId],
      },
      {
        sql: `UPDATE transactions SET kind = 'transfer', transfer_group_id = ?, updated_at = ?
          WHERE id IN (
            SELECT outgoing_transaction_id FROM ingested_transfer_candidates WHERE id = ? AND transfer_group_id = ?
            UNION ALL
            SELECT incoming_transaction_id FROM ingested_transfer_candidates WHERE id = ? AND transfer_group_id = ?
          )`,
        args: [input.transferGroupId, input.now, input.candidateId, input.transferGroupId, input.candidateId, input.transferGroupId],
      },
      {
        sql: `UPDATE ingested_transfer_candidates SET status = 'rejected', decided_at = ?
          WHERE id <> ? AND status IN ('pending', 'deferred') AND (
            outgoing_transaction_id IN (
              SELECT outgoing_transaction_id FROM ingested_transfer_candidates WHERE id = ?
              UNION ALL SELECT incoming_transaction_id FROM ingested_transfer_candidates WHERE id = ?
            ) OR incoming_transaction_id IN (
              SELECT outgoing_transaction_id FROM ingested_transfer_candidates WHERE id = ?
              UNION ALL SELECT incoming_transaction_id FROM ingested_transfer_candidates WHERE id = ?
            )
          )`,
        args: [input.now, input.candidateId, input.candidateId, input.candidateId, input.candidateId, input.candidateId],
      },
    ];
  }
  const status = input.decision === "reject" ? "rejected" : "deferred";
  return [{
    sql: `UPDATE ingested_transfer_candidates SET status = ?, decided_at = ?, transfer_group_id = NULL
      WHERE id = ? AND status IN ('pending', 'deferred')`,
    args: [status, input.now, input.candidateId],
  }];
}

function calendarDayDistance(left: string, right: string): number {
  const toDay = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.abs(toDay(left) - toDay(right)) / 86_400_000;
}
