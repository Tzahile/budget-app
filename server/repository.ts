import { addRecurrence, calculateDashboard, householdDate, requiredGoalContributionCents } from "../shared/finance.ts";
import {
  DEMO_CLEANUP_CONFIRMATION,
  type Account,
  type AccountReconciliation,
  type AppData,
  type DemoDataState,
  type IngestionRun,
  type IngestionRunItem,
  type IngestedTransferCandidate,
  type PlannedCompletion,
  type PlannedTransaction,
  type Reserve,
  type Transaction,
} from "../shared/types.ts";
import { db, ensureSchema } from "./db.ts";
import {
  classifyDemoData,
  demoCleanupStatements,
  demoSeedStatements,
  demoStateQuery,
} from "./demo-data.ts";
import {
  completePlannedStatements,
  correctPlannedStatements,
  PLANNED_COMPLETIONS_QUERY,
  undoPlannedStatements,
} from "./planned-operations.ts";
import { reconcileAccountStatements } from "./reconciliation-operations.ts";
import { createReserveStatement, updateReserveStatement } from "./reserve-operations.ts";
import {
  assessIngestionDuplicates,
  ingestionWritePlan,
  prepareCanonicalTransactions,
  rejectedIngestionWritePlan,
  type CanonicalTransactionInput,
  type IngestionRowError,
  type IngestionSource,
} from "./ingestion.ts";
import {
  decideTransferCandidateStatements,
  detectIngestedTransferPairs,
  insertTransferCandidateStatements,
  type TransferDetectionTransaction,
} from "./ingested-transfers.ts";

type Row = Record<string, unknown>;

export type BankConnectionStatus = "connected" | "reauth_required" | "disconnected" | "error";
export interface BankConnection {
  id: string;
  provider: string;
  institutionId: string;
  institutionName: string;
  countryCode: string;
  status: BankConnectionStatus;
  consentExpiresAt: string | null;
  lastSyncedAt: string | null;
  safeErrorCode: string | null;
  accounts: Array<{ accountId: string }>;
}

/** Store only a SHA-256 digest of the one-time callback state. */
export async function hashBankConsentState(state: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createBankConsentAttempt(input: {
  stateHash: string; ownerUsername: string; provider: string; institutionId: string;
  institutionName: string; providerRequisitionId: string; redirectUri: string; expiresAt: string;
}): Promise<void> {
  await ensureSchema();
  if (!/^[a-f0-9]{64}$/.test(input.stateHash)) throw new Error("Invalid consent state digest");
  await db.execute({
    sql: `INSERT INTO bank_consent_attempts (id, state_hash, owner_username, provider, institution_id,
      institution_name, provider_requisition_id, redirect_uri, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), input.stateHash, input.ownerUsername, input.provider, input.institutionId,
      input.institutionName, input.providerRequisitionId, input.redirectUri, input.expiresAt, new Date().toISOString()],
  });
}

/** One atomic claim prevents callback replay, including concurrent requests. */
export async function consumeBankConsentAttempt(input: {
  stateHash: string; ownerUsername: string; redirectUri: string;
}): Promise<{
  provider: string; institutionId: string; institutionName: string; providerRequisitionId: string;
} | null> {
  await ensureSchema();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE bank_consent_attempts SET consumed_at = ? WHERE state_hash = ? AND owner_username = ?
      AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > ?`,
    args: [now, input.stateHash, input.ownerUsername, input.redirectUri, now],
  });
  if (!result.rowsAffected) return null;
  const row = await one("SELECT * FROM bank_consent_attempts WHERE state_hash = ?", [input.stateHash]);
  if (!row) return null;
  return {
    provider: String(row.provider), institutionId: String(row.institution_id),
    institutionName: String(row.institution_name), providerRequisitionId: String(row.provider_requisition_id),
  };
}

export async function createBankConnection(input: {
  provider: string; providerConnectionId: string; institutionId: string;
  institutionName: string; countryCode: string; consentExpiresAt?: string | null;
}): Promise<string> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO bank_connections (id, provider, provider_connection_id, institution_id,
      institution_name, country_code, status, consent_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)`,
    args: [id, input.provider, input.providerConnectionId, input.institutionId,
      input.institutionName, input.countryCode, input.consentExpiresAt ?? null, now, now],
  });
  return id;
}

export async function listBankConnections(): Promise<BankConnection[]> {
  await ensureSchema();
  const [connections, links] = await Promise.all([
    db.execute("SELECT * FROM bank_connections ORDER BY created_at DESC"),
    db.execute("SELECT connection_id, provider_account_id, account_id FROM bank_account_links"),
  ]);
  return connections.rows.map((row) => ({
    id: String(row.id), provider: String(row.provider), institutionId: String(row.institution_id),
    institutionName: String(row.institution_name), countryCode: String(row.country_code),
    status: row.status as BankConnectionStatus,
    consentExpiresAt: row.consent_expires_at === null ? null : String(row.consent_expires_at),
    lastSyncedAt: row.last_synced_at === null ? null : String(row.last_synced_at),
    safeErrorCode: row.safe_error_code === null ? null : String(row.safe_error_code),
    accounts: links.rows.filter((link) => link.connection_id === row.id).map((link) => ({ accountId: String(link.account_id) })),
  }));
}

/** Internal provider identifier: never serialize this record into an HTTP response. */
export async function getBankConnectionForSync(id: string): Promise<{
  id: string; provider: string; providerConnectionId: string; status: BankConnectionStatus;
  consentExpiresAt: string | null;
} | null> {
  await ensureSchema();
  const row = await one("SELECT id, provider, provider_connection_id, status, consent_expires_at FROM bank_connections WHERE id = ?", [id]);
  return row ? {
    id: String(row.id), provider: String(row.provider), providerConnectionId: String(row.provider_connection_id),
    status: row.status as BankConnectionStatus,
    consentExpiresAt: row.consent_expires_at === null ? null : String(row.consent_expires_at),
  } : null;
}

/** Create the local account and provider link together; a retry returns the same account. */
export async function createLinkedBankAccount(input: {
  connectionId: string; providerAccountId: string; name: string;
}): Promise<string> {
  await ensureSchema();
  if (!input.providerAccountId || input.providerAccountId.length > 200 ||
      !input.name.trim() || input.name.length > 200) {
    throw Object.assign(new Error("Invalid bank account details"), { status: 400 });
  }
  const connection = await getBankConnectionForSync(input.connectionId);
  if (!connection || connection.status !== "connected" ||
      (connection.consentExpiresAt && connection.consentExpiresAt <= new Date().toISOString())) {
    throw conflict("Bank connection is unavailable");
  }
  const accountId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO accounts (id, name, type, currency, balance_cents, is_active, created_at, updated_at)
        SELECT ?, ?, 'checking', 'EUR', 0, 1, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM bank_account_links WHERE connection_id = ? AND provider_account_id = ?)`,
      args: [accountId, input.name.trim(), now, now,
        input.connectionId, input.providerAccountId],
    },
    {
      sql: `INSERT INTO bank_account_links (connection_id, provider_account_id, account_id, created_at)
        SELECT ?, ?, ?, ? WHERE changes() = 1`,
      args: [input.connectionId, input.providerAccountId, accountId, now],
    },
  ]);
  const link = await one("SELECT account_id FROM bank_account_links WHERE connection_id = ? AND provider_account_id = ?",
    [input.connectionId, input.providerAccountId]);
  if (!link) throw conflict("Bank account could not be linked");
  return String(link.account_id);
}

export async function markBankConnection(id: string, status: BankConnectionStatus, safeErrorCode?: string | null): Promise<void> {
  await ensureSchema();
  if (safeErrorCode && !/^[a-z_]{1,50}$/.test(safeErrorCode)) throw new Error("Invalid safe error code");
  const result = await db.execute({
    sql: "UPDATE bank_connections SET status = ?, safe_error_code = ?, updated_at = ? WHERE id = ?",
    args: [status, safeErrorCode ?? null, new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Bank connection");
}

export async function linkBankAccount(input: {
  connectionId: string; providerAccountId: string; accountId: string;
}): Promise<void> {
  await ensureSchema();
  await db.execute({
    sql: `INSERT INTO bank_account_links (connection_id, provider_account_id, account_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
      account_id = excluded.account_id WHERE account_id = excluded.account_id`,
    args: [input.connectionId, input.providerAccountId, input.accountId, new Date().toISOString()],
  });
}

export async function getAppData(asOfDate = householdDate()): Promise<AppData> {
  await ensureSchema();
  const monthStart = `${asOfDate.slice(0, 7)}-01`;
  const [accountResult, reconciliationResult, transactionResult, dashboardTransactionResult, plannedResult, completionResult, reserveResult, demoResult, transferCandidateResult] = await Promise.all([
    db.execute("SELECT * FROM accounts ORDER BY is_active DESC, name COLLATE NOCASE"),
    db.execute("SELECT * FROM account_reconciliations ORDER BY date DESC, created_at DESC LIMIT 500"),
    db.execute("SELECT * FROM transactions WHERE voided_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 500"),
    db.execute({ sql: "SELECT * FROM transactions WHERE voided_at IS NULL AND date BETWEEN ? AND ?", args: [monthStart, asOfDate] }),
    db.execute("SELECT * FROM planned_transactions ORDER BY is_active DESC, next_date, description COLLATE NOCASE"),
    db.execute(PLANNED_COMPLETIONS_QUERY),
    db.execute("SELECT * FROM reserves ORDER BY is_active DESC, name COLLATE NOCASE"),
    db.execute(demoStateQuery()),
    db.execute("SELECT * FROM ingested_transfer_candidates ORDER BY created_at DESC LIMIT 500"),
  ]);
  const accounts = accountResult.rows.map(mapAccount);
  const accountReconciliations = reconciliationResult.rows.map(mapReconciliation);
  const transactions = transactionResult.rows.map(mapTransaction);
  const dashboardTransactions = dashboardTransactionResult.rows.map(mapTransaction);
  const plannedTransactions = plannedResult.rows.map(mapPlanned);
  const plannedCompletions = completionResult.rows.map(mapCompletion);
  const reserves = reserveResult.rows.map((row) => mapReserve(row, asOfDate));
  const demoDataState = demoStateFromRow(demoResult.rows[0] as Row | undefined);
  return {
    accounts,
    accountReconciliations,
    transactions,
    ingestedTransferCandidates: transferCandidateResult.rows.map(mapIngestedTransferCandidate),
    plannedTransactions,
    plannedCompletions,
    reserves,
    demoDataState,
    dashboard: calculateDashboard({ asOfDate, accounts, transactions: dashboardTransactions, plannedTransactions, reserves }),
  };
}

export async function createAccount(input: {
  name: string;
  type: Account["type"];
  balanceCents: number;
}): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO accounts (id, name, type, currency, balance_cents, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'EUR', ?, 1, ?, ?)`,
    args: [crypto.randomUUID(), input.name, input.type, input.balanceCents, now, now],
  });
}

export async function updateAccount(id: string, input: {
  name: string;
  type: Account["type"];
  isActive: boolean;
}): Promise<void> {
  await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE accounts SET name = ?, type = ?, is_active = ?, updated_at = ?, is_demo = 0 WHERE id = ?`,
    args: [input.name, input.type, Number(input.isActive), new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Account");
}

export async function reconcileAccount(id: string, input: {
  actualBalanceCents: number;
  date: string;
  note: string;
}): Promise<void> {
  await ensureSchema();
  const reconciliationId = crypto.randomUUID();
  await db.batch(reconcileAccountStatements({
    reconciliationId,
    accountId: id,
    actualBalanceCents: input.actualBalanceCents,
    date: input.date,
    note: input.note,
    now: new Date().toISOString(),
  }));
  const created = await one("SELECT id FROM account_reconciliations WHERE id = ?", [reconciliationId]);
  if (created) return;
  const account = await one("SELECT is_active FROM accounts WHERE id = ?", [id]);
  if (!account) throw notFound("Account");
  throw conflict("Only active accounts can be reconciled");
}

export async function deleteAccount(id: string): Promise<void> {
  await ensureSchema();
  const result = await db.execute({ sql: "DELETE FROM accounts WHERE id = ?", args: [id] });
  requireChanged(result.rowsAffected, "Account");
}

export async function createTransaction(input: {
  accountId: string;
  date: string;
  amountCents: number;
  description: string;
  kind: "income" | "expense";
  source?: "manual" | "planned";
  plannedTransactionId?: string | null;
}): Promise<void> {
  await ensureSchema();
  const signedAmount = input.kind === "expense" ? -input.amountCents : input.amountCents;
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO transactions
        (id, account_id, date, amount_cents, currency, description, kind, status, source, planned_transaction_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'cleared', ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), input.accountId, input.date, signedAmount, input.description, input.kind,
        input.source ?? "manual", input.plannedTransactionId ?? null, now, now],
    },
    { sql: "UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [signedAmount, now, input.accountId] },
  ]);
}

/**
 * An owned-account transfer is represented by two cleared, manual legs that
 * share a group id. Keeping both legs as normal transactions makes account
 * activity and reconciliation traceable, while finance calculations can
 * exclude the `transfer` kind without guessing from descriptions.
 */
export async function createTransfer(input: {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  amountCents: number;
  description: string;
}): Promise<void> {
  await ensureSchema();
  await requireActiveDistinctAccounts(input.fromAccountId, input.toAccountId);
  const now = new Date().toISOString();
  const groupId = crypto.randomUUID();
  await db.batch(transferInsertStatements({ ...input, groupId, now }));
}

export async function updateTransfer(groupId: string, input: {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  amountCents: number;
  description: string;
}): Promise<void> {
  await ensureSchema();
  await requireActiveDistinctAccounts(input.fromAccountId, input.toAccountId);
  const legs = await transferLegs(groupId);
  const now = new Date().toISOString();
  await db.batch([
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [legs.from.amountCents, now, legs.from.accountId] },
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [legs.to.amountCents, now, legs.to.accountId] },
    { sql: "DELETE FROM transactions WHERE transfer_group_id = ?", args: [groupId] },
    ...transferInsertStatements({ ...input, groupId, now }),
  ]);
}

export async function deleteTransfer(groupId: string): Promise<void> {
  await ensureSchema();
  const legs = await transferLegs(groupId);
  const now = new Date().toISOString();
  await db.batch([
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [legs.from.amountCents, now, legs.from.accountId] },
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [legs.to.amountCents, now, legs.to.accountId] },
    { sql: "DELETE FROM transactions WHERE transfer_group_id = ?", args: [groupId] },
  ]);
}

/**
 * Persist normalized records from any adapter through one transactional path.
 * Repeating the same source records is a no-op for balances and transactions.
 */
export async function ingestTransactions(input: {
  accountId: string;
  filename: string;
  source: IngestionSource;
  transactions: readonly CanonicalTransactionInput[];
  rowErrors?: readonly IngestionRowError[];
  retryKey?: string | null;
  /** Internal bank sync context; verified by ingestBankAccountTransactions. */
  bankConnectionId?: string;
  bankBalanceCents?: number;
}): Promise<{
  importId: string;
  importedCount: number;
  duplicateCount: number;
  ambiguousCount: number;
  errorCount: number;
  replayed: boolean;
}> {
  await ensureSchema();
  const retryKey = normalizeRetryKey(input.retryKey);
  if (retryKey) {
    const previous = await one(
      "SELECT * FROM imports WHERE source = ? AND account_id = ? AND retry_key = ?",
      [input.source, input.accountId, retryKey],
    );
    if (previous) return replayIngestion(previous);
  }
  const rowErrors = input.rowErrors ?? [];
  if (!input.transactions.length && !rowErrors.length && input.bankBalanceCents === undefined) {
    throw Object.assign(new Error("No transactions or row errors to record"), { status: 400 });
  }
  const prepared = await prepareCanonicalTransactions({
    source: input.source, accountId: input.accountId, transactions: input.transactions,
  });
  const identities = prepared.map((transaction) => transaction.importIdentity);
  const existing = new Set<string>();
  const existingRows = new Map<string, Row>();
  for (const values of chunk(identities, 500)) {
    const result = await db.execute({
      sql: `SELECT id, import_identity, account_id, date, amount_cents, description, status,
        bank_connection_id, transfer_group_id FROM transactions
        WHERE import_identity IN (${values.map(() => "?").join(", ")})`,
      args: values,
    });
    for (const row of result.rows) {
      existing.add(String(row.import_identity));
      existingRows.set(String(row.import_identity), row);
    }
  }
  const assessments = assessIngestionDuplicates(prepared, existing);
  const bankRevisions: Array<{ transaction: typeof prepared[number]; previous: Row }> = [];
  if (input.bankConnectionId) {
    const seenBankIdentity = new Map<string, typeof prepared[number]>();
    for (const assessment of assessments) {
      const transaction = assessment.transaction;
      const prior = seenBankIdentity.get(transaction.importIdentity);
      if (prior && (prior.occurredOn !== transaction.occurredOn || prior.amountCents !== transaction.amountCents ||
          prior.description !== transaction.description || prior.status !== transaction.status)) {
        throw conflict("Bank transaction identity has conflicting details");
      }
      if (prior) continue;
      seenBankIdentity.set(transaction.importIdentity, transaction);
      if (assessment.decision !== "duplicate") continue;
      const previous = existingRows.get(transaction.importIdentity);
      if (!previous || previous.account_id !== input.accountId || previous.bank_connection_id !== input.bankConnectionId) {
        // Cross-source duplicates are safe only if all financial fields agree;
        // the bank cannot silently rewrite a CSV record or another connection.
        if (previous && previous.account_id === input.accountId && previous.date === transaction.occurredOn &&
            Number(previous.amount_cents) === transaction.amountCents && previous.description === transaction.description &&
            previous.status === transaction.status) continue;
        throw conflict("Bank transaction identity has conflicting details");
      }
      if (previous.date === transaction.occurredOn && Number(previous.amount_cents) === transaction.amountCents &&
          previous.description === transaction.description && previous.status === transaction.status) continue;
      if (previous.transfer_group_id !== null) throw conflict("A confirmed transfer needs review before bank revision");
      bankRevisions.push({ transaction, previous });
    }
  }
  const ambiguous = assessments.filter((assessment) => assessment.decision === "ambiguous");
  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  if (ambiguous.length || rowErrors.length) {
    // Failed runs are durable and inspectable, but never apply a subset of the
    // source rows. A corrected retry is a new run (or reuses its explicit key).
    const errorSummary = rejectedRunSummary(rowErrors.length, ambiguous.length);
    const plan = rejectedIngestionWritePlan({
      importId, accountId: input.accountId, filename: input.filename, source: input.source,
      transactions: prepared, assessments, rowErrors, errorSummary, retryKey, now,
      bankConnectionId: input.bankConnectionId,
    });
    const replayed = await writeIngestionPlan(plan.statements, retryKey, input);
    if (replayed) return replayed;
    throw Object.assign(new Error(errorSummary), {
      status: rowErrors.length ? 422 : 409,
      importId,
    });
  }
  const plan = ingestionWritePlan({
    importId, accountId: input.accountId, filename: input.filename, source: input.source,
    transactions: prepared, assessments, retryKey, now, bankConnectionId: input.bankConnectionId,
  });
  const eligible = await db.execute(`SELECT id, account_id, date, amount_cents FROM transactions
    WHERE source = 'import' AND status = 'cleared' AND kind IN ('income', 'expense')
      AND voided_at IS NULL AND transfer_group_id IS NULL`);
  const acceptedForDetection: TransferDetectionTransaction[] = assessments
    .filter((assessment) => assessment.decision === "accepted" && assessment.transaction.status !== "pending")
    .map(({ transaction }) => ({
      id: transaction.id,
      accountId: input.accountId,
      occurredOn: transaction.occurredOn,
      amountCents: transaction.amountCents,
    }));
  acceptedForDetection.push(...bankRevisions.filter(({ transaction }) => transaction.status !== "pending").map(({ transaction, previous }) => ({
    id: String(previous.id), accountId: input.accountId, occurredOn: transaction.occurredOn,
    amountCents: transaction.amountCents,
  })));
  const revisedIds = new Set(bankRevisions.map(({ previous }) => String(previous.id)));
  const existingForDetection: TransferDetectionTransaction[] = eligible.rows.map((row) => ({
    id: String(row.id), accountId: String(row.account_id), occurredOn: String(row.date), amountCents: Number(row.amount_cents),
  })).filter((transaction) => !revisedIds.has(transaction.id));
  plan.statements.push(...insertTransferCandidateStatements({
    pairs: detectIngestedTransferPairs([...existingForDetection, ...acceptedForDetection]),
    now,
  }));
  if (input.bankConnectionId) {
    for (const { transaction, previous } of bankRevisions) {
      plan.statements.push({
        sql: `UPDATE transactions SET date = ?, amount_cents = ?, description = ?, kind = ?, status = ?,
          raw_metadata = ?, updated_at = ? WHERE import_identity = ? AND bank_connection_id = ?`,
        args: [transaction.occurredOn, transaction.amountCents, transaction.description, transaction.kind,
          transaction.status ?? "cleared", transaction.metadataJson, now, transaction.importIdentity, input.bankConnectionId],
      });
      const previousCounted = previous.status === "cleared" ? Number(previous.amount_cents) : 0;
      const nextCounted = transaction.status === "cleared" ? transaction.amountCents : 0;
      if (nextCounted !== previousCounted) plan.statements.push({
        sql: "UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0 WHERE id = ?",
        args: [nextCounted - previousCounted, now, input.accountId],
      });
    }
    if (bankRevisions.length) plan.statements.push({
      sql: "UPDATE imports SET updated_count = ? WHERE id = ?",
      args: [bankRevisions.length, importId],
    });
    if (input.bankBalanceCents !== undefined) {
      const reconciliationId = crypto.randomUUID();
      // Provider balance is the authoritative checkpoint after the complete
      // transaction page has been ingested. This is one SQLite transaction.
      plan.statements.push({
        sql: `INSERT INTO account_reconciliations
          (id, account_id, date, previous_balance_cents, actual_balance_cents, difference_cents, note, created_at)
          SELECT ?, id, ?, balance_cents, ?, ? - balance_cents, 'Open Banking balance', ?
          FROM accounts WHERE id = ? AND is_active = 1 AND balance_cents <> ?`,
        args: [reconciliationId, householdDate(), input.bankBalanceCents, input.bankBalanceCents,
          now, input.accountId, input.bankBalanceCents],
      });
      plan.statements.push({
        sql: `UPDATE accounts SET balance_cents = ?, updated_at = ?, is_demo = 0
          WHERE id = ? AND EXISTS (SELECT 1 FROM account_reconciliations WHERE id = ?)`,
        args: [input.bankBalanceCents, now, input.accountId, reconciliationId],
      });
    }
    plan.statements.push({
      sql: "UPDATE bank_connections SET last_synced_at = ?, safe_error_code = NULL, updated_at = ? WHERE id = ? AND status = 'connected'",
      args: [now, now, input.bankConnectionId],
    });
  }
  const replayed = await writeIngestionPlan(plan.statements, retryKey, input);
  if (replayed) return replayed;
  return {
    importId,
    importedCount: plan.importedCount,
    duplicateCount: plan.duplicateCount,
    ambiguousCount: 0,
    errorCount: 0,
    replayed: false,
  };
}

/** A bank account can only sync through its connected, mapped provider link. */
export async function ingestBankAccountTransactions(input: {
  connectionId: string; accountId: string; provider: string;
  transactions: readonly CanonicalTransactionInput[];
  balanceCents?: number; retryKey?: string;
}): ReturnType<typeof ingestTransactions> {
  await ensureSchema();
  const connected = await one(`SELECT 1 FROM bank_connections c JOIN bank_account_links l
    ON l.connection_id = c.id JOIN accounts a ON a.id = l.account_id
    WHERE c.id = ? AND c.provider = ? AND l.account_id = ? AND c.status = 'connected'
      AND (c.consent_expires_at IS NULL OR c.consent_expires_at > ?)
      AND a.is_active = 1`, [input.connectionId, input.provider, input.accountId, new Date().toISOString()]);
  if (!connected) throw conflict("Bank connection is unavailable or account is not linked");
  if (input.balanceCents !== undefined && !Number.isSafeInteger(input.balanceCents)) {
    throw Object.assign(new Error("Bank balance must be integer cents"), { status: 400 });
  }
  return ingestTransactions({
    accountId: input.accountId, source: "open_banking", filename: "Open Banking sync",
    transactions: input.transactions, retryKey: input.retryKey,
    bankConnectionId: input.connectionId, bankBalanceCents: input.balanceCents,
  });
}

export async function getIngestionHistory(limit = 50): Promise<IngestionRun[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 50));
  const runs = await db.execute({
    sql: "SELECT * FROM imports ORDER BY created_at DESC, id DESC LIMIT ?",
    args: [safeLimit],
  });
  if (!runs.rows.length) return [];
  const ids = runs.rows.map((row) => String((row as Row).id));
  const itemResult = await db.execute({
    sql: `SELECT * FROM ingestion_items WHERE import_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY import_id, source_position`,
    args: ids,
  });
  const byRun = new Map<string, IngestionRunItem[]>();
  for (const itemRow of itemResult.rows) {
    const row = itemRow as Row;
    const items = byRun.get(String(row.import_id)) ?? [];
    items.push(mapIngestionItem(row));
    byRun.set(String(row.import_id), items);
  }
  return runs.rows.map((runRow) => mapIngestionRun(runRow as Row, byRun.get(String((runRow as Row).id)) ?? []));
}

async function writeIngestionPlan(
  statements: Parameters<typeof db.batch>[0],
  retryKey: string | null,
  input: { source: IngestionSource; accountId: string },
): Promise<ReturnType<typeof replayIngestion> | null> {
  try {
    await db.batch(statements);
    return null;
  } catch (error) {
    // Two requests with the same explicit retry key can race. The unique index
    // rolls back the losing batch, so returning the committed run is safe.
    if (retryKey && error instanceof Error && /constraint|unique/i.test(error.message)) {
      const previous = await one(
        "SELECT * FROM imports WHERE source = ? AND account_id = ? AND retry_key = ?",
        [input.source, input.accountId, retryKey],
      );
      if (previous) return replayIngestion(previous);
    }
    throw error;
  }
}

function replayIngestion(row: Row): {
  importId: string;
  importedCount: number;
  duplicateCount: number;
  ambiguousCount: number;
  errorCount: number;
  replayed: boolean;
} {
  if (row.status === "failed") {
    throw Object.assign(new Error(String(row.error_summary || "Ingestion failed")), {
      status: Number(row.error_count) > 0 ? 422 : 409,
      importId: String(row.id),
      replayed: true,
    });
  }
  return {
    importId: String(row.id),
    importedCount: Number(row.imported_count),
    duplicateCount: Number(row.duplicate_count),
    ambiguousCount: Number(row.ambiguous_count),
    errorCount: Number(row.error_count),
    replayed: true,
  };
}

function normalizeRetryKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw Object.assign(new Error("Retry key is invalid"), { status: 400 });
  }
  return normalized;
}

function rejectedRunSummary(errorCount: number, ambiguousCount: number): string {
  const parts: string[] = [];
  if (errorCount) parts.push(`${errorCount} invalid row${errorCount === 1 ? "" : "s"}`);
  if (ambiguousCount) parts.push(`${ambiguousCount} ambiguous row${ambiguousCount === 1 ? "" : "s"}`);
  return `Import blocked: ${parts.join(" and ")}`;
}

export async function decideIngestedTransferCandidate(
  id: string,
  decision: "confirm" | "reject" | "defer",
): Promise<void> {
  await ensureSchema();
  const existing = await one("SELECT status FROM ingested_transfer_candidates WHERE id = ?", [id]);
  if (!existing) throw notFound("Transfer candidate");
  if (existing.status === "confirmed" || existing.status === "rejected") {
    throw conflict("This transfer candidate has already been decided");
  }
  const transferGroupId = crypto.randomUUID();
  await db.batch(decideTransferCandidateStatements({
    candidateId: id, decision, transferGroupId, now: new Date().toISOString(),
  }));
  const updated = await one("SELECT status, transfer_group_id FROM ingested_transfer_candidates WHERE id = ?", [id]);
  const expectedStatus = decision === "confirm" ? "confirmed" : decision === "reject" ? "rejected" : "deferred";
  if (updated?.status !== expectedStatus) {
    throw conflict("Transfer candidate no longer matches eligible imported transactions");
  }
}

export async function updateTransaction(id: string, input: {
  accountId: string;
  date: string;
  amountCents: number;
  description: string;
  kind: "income" | "expense";
}): Promise<void> {
  await ensureSchema();
  const existing = await one("SELECT * FROM transactions WHERE id = ?", [id]);
  if (!existing) throw notFound("Transaction");
  if (existing.source !== "manual") throw conflict("Only manual transactions can be edited");
  if (existing.kind === "transfer") throw conflict("Edit transfers as one linked transfer");
  const oldAmount = Number(existing.amount_cents);
  const newAmount = input.kind === "expense" ? -input.amountCents : input.amountCents;
  const oldAccountId = String(existing.account_id);
  const now = new Date().toISOString();
  await db.batch([
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [oldAmount, now, oldAccountId] },
    { sql: "UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [newAmount, now, input.accountId] },
    {
      sql: `UPDATE transactions SET account_id = ?, date = ?, amount_cents = ?, description = ?, kind = ?, updated_at = ?, is_demo = 0 WHERE id = ?`,
      args: [input.accountId, input.date, newAmount, input.description, input.kind, now, id],
    },
  ]);
}

export async function deleteTransaction(id: string): Promise<void> {
  await ensureSchema();
  const existing = await one("SELECT * FROM transactions WHERE id = ?", [id]);
  if (!existing) throw notFound("Transaction");
  if (existing.source !== "manual") throw conflict("Only manual transactions can be deleted directly");
  if (existing.kind === "transfer") throw conflict("Delete transfers as one linked transfer");
  await db.batch([
    {
      sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?",
      args: [Number(existing.amount_cents), new Date().toISOString(), String(existing.account_id)],
    },
    { sql: "DELETE FROM transactions WHERE id = ?", args: [id] },
  ]);
}

export async function createPlanned(input: Omit<PlannedTransaction, "id" | "currency" | "createdAt" | "updatedAt">): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO planned_transactions
      (id, account_id, description, kind, amount_cents, currency, recurrence, interval_count, next_date, end_date, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), input.accountId, input.description, input.kind, input.amountCents, input.recurrence,
      input.intervalCount, input.nextDate, input.endDate, Number(input.isActive), now, now],
  });
}

export async function updatePlanned(id: string, input: Omit<PlannedTransaction, "id" | "currency" | "createdAt" | "updatedAt">): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `UPDATE planned_transactions SET account_id = ?, description = ?, kind = ?, amount_cents = ?, recurrence = ?,
        interval_count = ?, next_date = ?, end_date = ?, is_active = ?, revision = revision + 1,
        latest_completion_id = NULL, updated_at = ?, is_demo = 0 WHERE id = ?`,
      args: [input.accountId, input.description, input.kind, input.amountCents, input.recurrence, input.intervalCount,
        input.nextDate, input.endDate, Number(input.isActive), now, id],
    },
    {
      sql: `UPDATE reserves SET linked_planned_transaction_id = NULL, updated_at = ?
        WHERE linked_planned_transaction_id = ? AND (? <> 'expense' OR ? <> 'once')`,
      args: [now, id, input.kind, input.recurrence],
    },
  ]);
  if (!await one("SELECT id FROM planned_transactions WHERE id = ?", [id])) throw notFound("Planned transaction");
}

export async function completePlanned(id: string, actualDate: string, accountId?: string | null): Promise<void> {
  await ensureSchema();
  const row = await one("SELECT * FROM planned_transactions WHERE id = ?", [id]);
  if (!row) throw notFound("Planned transaction");
  const item = mapPlanned(row);
  if (!item.isActive) throw conflict("Planned transaction is inactive");
  const targetAccountId = accountId || item.accountId;
  if (!targetAccountId) throw conflict("Choose an account before marking this item paid");
  const nextDate = addRecurrence(item.nextDate, item.recurrence, item.intervalCount);
  const remainsActive = Boolean(nextDate && (!item.endDate || nextDate <= item.endDate));
  const now = new Date().toISOString();
  const completionId = crypto.randomUUID();
  await db.batch(completePlannedStatements({
    item: { ...item, revision: Number(row.revision ?? 0) }, completionId, transactionId: crypto.randomUUID(),
    targetAccountId, actualDate, nextDate: nextDate ?? item.nextDate, remainsActive, now,
  }));
  const created = await one("SELECT id FROM planned_completions WHERE id = ?", [completionId]);
  if (!created) throw conflict("This occurrence was already completed; refresh and try again");
}

export async function undoPlannedCompletion(completionId: string, expectedEffectiveTransactionId: string): Promise<void> {
  await ensureSchema();
  const token = crypto.randomUUID();
  await db.batch(undoPlannedStatements({ completionId, expectedEffectiveTransactionId, token, now: new Date().toISOString() }));
  await requireAdjustment(completionId, "undone", token);
}

export async function correctPlannedCompletion(completionId: string, input: {
  accountId: string;
  date: string;
  amountCents: number;
  expectedEffectiveTransactionId: string;
}): Promise<void> {
  await ensureSchema();
  const token = crypto.randomUUID();
  await db.batch(correctPlannedStatements({
    completionId, expectedEffectiveTransactionId: input.expectedEffectiveTransactionId,
    correctionTransactionId: crypto.randomUUID(), token,
    accountId: input.accountId, date: input.date, amountCents: input.amountCents, now: new Date().toISOString(),
  }));
  await requireAdjustment(completionId, "corrected", token);
}

async function requireAdjustment(id: string, expected: "undone" | "corrected", token: string): Promise<void> {
  const row = await one("SELECT status, last_operation_token FROM planned_completions WHERE id = ?", [id]);
  if (!row) throw notFound("Planned completion");
  if (row.status !== expected || row.last_operation_token !== token) {
    throw conflict("Only the latest unchanged completion can be adjusted");
  }
}

export async function deletePlanned(id: string): Promise<void> {
  await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM planned_transactions WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM planned_completions WHERE planned_transaction_id = ?)`,
    args: [id, id],
  });
  if (result.rowsAffected) return;
  const existing = await one("SELECT id FROM planned_transactions WHERE id = ?", [id]);
  if (!existing) throw notFound("Planned transaction");
  throw conflict("Completed planned items must be deactivated to preserve their audit history");
}

export async function deactivatePlanned(id: string): Promise<void> {
  await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE planned_transactions SET is_active = 0, revision = revision + 1,
      latest_completion_id = NULL, updated_at = ?, is_demo = 0 WHERE id = ?`,
    args: [new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Planned transaction");
}

export async function createReserve(input: {
  name: string;
  fundedAmountCents: number;
  targetAmountCents: number | null;
  targetDate: string | null;
  linkedPlannedTransactionId: string | null;
  note: string;
}): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const result = await executeReserveWrite(createReserveStatement({
    id: crypto.randomUUID(),
    ...input,
    contributionMonth: householdDate().slice(0, 7),
    now,
  }), input.linkedPlannedTransactionId);
  if (!result.rowsAffected) throw invalidReserveLink();
}

export async function updateReserve(id: string, input: {
  name: string;
  fundedAmountCents: number;
  targetAmountCents: number | null;
  targetDate: string | null;
  linkedPlannedTransactionId: string | null;
  note: string;
  isActive: boolean;
}): Promise<void> {
  await ensureSchema();
  const result = await executeReserveWrite(updateReserveStatement({
    id,
    ...input,
    contributionMonth: householdDate().slice(0, 7),
    now: new Date().toISOString(),
  }), input.linkedPlannedTransactionId);
  if (result.rowsAffected) return;
  if (!await one("SELECT id FROM reserves WHERE id = ?", [id])) throw notFound("Reserve");
  throw invalidReserveLink();
}

export async function deleteReserve(id: string): Promise<void> {
  await ensureSchema();
  const result = await db.execute({ sql: "DELETE FROM reserves WHERE id = ?", args: [id] });
  requireChanged(result.rowsAffected, "Reserve");
}

export async function seedDemoData(today = householdDate()): Promise<boolean> {
  await ensureSchema();
  const now = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  const { start } = (() => {
    const month = today.slice(0, 7);
    return { start: `${month}-01` };
  })();
  const day = (value: number) => `${today.slice(0, 8)}${String(value).padStart(2, "0")}`;
  const futureDay = Math.min(28, Number(today.slice(8, 10)) + 2);
  const checkingId = crypto.randomUUID();
  await db.batch(demoSeedStatements({
    claimToken,
    checkingId,
    savingsId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(),
    salaryId: crypto.randomUUID(),
    mortgageId: crypto.randomUUID(),
    reserveId: crypto.randomUUID(),
    now,
    monthStart: start,
    salaryDate: day(futureDay),
    mortgageDate: day(Math.min(28, futureDay + 2)),
  }));
  const claim = await one("SELECT value FROM app_metadata WHERE key = 'demo_seed_claim'", []);
  return claim?.value === claimToken;
}

export async function cleanupDemoData(confirmation: string): Promise<boolean> {
  if (confirmation !== DEMO_CLEANUP_CONFIRMATION) throw conflict(`Type ${DEMO_CLEANUP_CONFIRMATION} exactly to remove demo data`);
  await ensureSchema();
  const initialState = await getDemoDataState();
  if (initialState === "empty") return false;
  if (initialState !== "demo-only") throw conflict("Demo cleanup is blocked because this dataset contains real or unmarked data");

  const claimToken = crypto.randomUUID();
  await db.batch(demoCleanupStatements(claimToken, new Date().toISOString()));
  const finalState = await getDemoDataState();
  if (finalState !== "empty") throw conflict("Demo cleanup was blocked because the dataset changed");
  return true;
}

async function getDemoDataState(): Promise<DemoDataState> {
  const result = await db.execute(demoStateQuery());
  return demoStateFromRow(result.rows[0] as Row | undefined);
}

function demoStateFromRow(row: Row | undefined): DemoDataState {
  return classifyDemoData(Number(row?.total_count ?? 0), Number(row?.demo_count ?? 0));
}

async function one(sql: string, args: (string | number | null)[]): Promise<Row | null> {
  const result = await db.execute({ sql, args });
  return (result.rows[0] as Row | undefined) ?? null;
}

type TransferLeg = { id: string; accountId: string; amountCents: number };

async function requireActiveDistinctAccounts(fromAccountId: string, toAccountId: string): Promise<void> {
  if (fromAccountId === toAccountId) throw conflict("Choose two different active accounts");
  const result = await db.execute({
    sql: "SELECT id FROM accounts WHERE id IN (?, ?) AND is_active = 1",
    args: [fromAccountId, toAccountId],
  });
  if (result.rows.length !== 2) throw conflict("Transfers require two active accounts");
}

async function transferLegs(groupId: string): Promise<{ from: TransferLeg; to: TransferLeg }> {
  const result = await db.execute({
    sql: `SELECT id, account_id, amount_cents FROM transactions
      WHERE transfer_group_id = ? AND kind = 'transfer' AND source = 'manual' AND voided_at IS NULL`,
    args: [groupId],
  });
  const legs = result.rows.map((row) => ({ id: String(row.id), accountId: String(row.account_id), amountCents: Number(row.amount_cents) }));
  const from = legs.find((leg) => leg.amountCents < 0);
  const to = legs.find((leg) => leg.amountCents > 0);
  if (legs.length !== 2 || !from || !to || Math.abs(from.amountCents) !== to.amountCents) {
    throw conflict("Transfer is incomplete or cannot be changed");
  }
  return { from, to };
}

function transferInsertStatements(input: {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  amountCents: number;
  description: string;
  groupId: string;
  now: string;
}): { sql: string; args: (string | number | null)[] }[] {
  const insert = (id: string, accountId: string, amountCents: number) => ({
    sql: `INSERT INTO transactions
      (id, account_id, date, amount_cents, currency, description, kind, status, source, transfer_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'EUR', ?, 'transfer', 'cleared', 'manual', ?, ?, ?)`,
    args: [id, accountId, input.date, amountCents, input.description, input.groupId, input.now, input.now],
  });
  return [
    insert(crypto.randomUUID(), input.fromAccountId, -input.amountCents),
    insert(crypto.randomUUID(), input.toAccountId, input.amountCents),
    { sql: "UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [input.amountCents, input.now, input.fromAccountId] },
    { sql: "UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0 WHERE id = ?", args: [input.amountCents, input.now, input.toAccountId] },
  ];
}

function mapAccount(row: Row): Account {
  return {
    id: String(row.id), name: String(row.name), type: row.type as Account["type"], currency: String(row.currency),
    balanceCents: Number(row.balance_cents), isActive: Boolean(row.is_active), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapReconciliation(row: Row): AccountReconciliation {
  return {
    id: String(row.id), accountId: String(row.account_id), date: String(row.date),
    previousBalanceCents: Number(row.previous_balance_cents),
    actualBalanceCents: Number(row.actual_balance_cents),
    differenceCents: Number(row.difference_cents), note: String(row.note),
    createdAt: String(row.created_at),
  };
}

function mapTransaction(row: Row): Transaction {
  return {
    id: String(row.id), accountId: String(row.account_id), date: String(row.date), amountCents: Number(row.amount_cents),
    currency: String(row.currency), description: String(row.description), kind: row.kind as Transaction["kind"],
    status: row.status as Transaction["status"], source: row.source as Transaction["source"],
    transferGroupId: row.transfer_group_id == null ? null : String(row.transfer_group_id),
    plannedTransactionId: row.planned_transaction_id == null ? null : String(row.planned_transaction_id),
    correctedFromTransactionId: row.corrected_from_transaction_id == null ? null : String(row.corrected_from_transaction_id),
    voidedAt: row.voided_at == null ? null : String(row.voided_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapIngestionItem(row: Row): IngestionRunItem {
  return {
    id: String(row.id),
    sourcePosition: Number(row.source_position),
    status: row.status as IngestionRunItem["status"],
    transactionId: row.transaction_id == null ? null : String(row.transaction_id),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorSummary: row.error_summary == null ? null : String(row.error_summary),
  };
}

function mapIngestionRun(row: Row, items: IngestionRunItem[]): IngestionRun {
  return {
    id: String(row.id),
    accountId: row.account_id == null ? null : String(row.account_id),
    filename: String(row.filename),
    source: row.source as IngestionRun["source"],
    status: row.status as IngestionRun["status"],
    rowCount: Number(row.row_count),
    acceptedCount: Number(row.imported_count),
    duplicateCount: Number(row.duplicate_count),
    ambiguousCount: Number(row.ambiguous_count),
    errorCount: Number(row.error_count),
    errorSummary: row.error_summary == null ? null : String(row.error_summary),
    createdAt: String(row.created_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    items,
  };
}

function mapIngestedTransferCandidate(row: Row): IngestedTransferCandidate {
  return {
    id: String(row.id),
    outgoingTransactionId: String(row.outgoing_transaction_id),
    incomingTransactionId: String(row.incoming_transaction_id),
    status: row.status as IngestedTransferCandidate["status"],
    transferGroupId: row.transfer_group_id == null ? null : String(row.transfer_group_id),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
  };
}

function mapCompletion(row: Row): PlannedCompletion {
  const originalTransaction = mapTransaction({
    id: row.original_id, account_id: row.original_account_id, date: row.original_date,
    amount_cents: row.original_amount_cents, currency: row.original_currency,
    description: row.original_description, kind: row.original_kind, status: row.original_status,
    source: row.original_source, transfer_group_id: row.original_transfer_group_id,
    planned_transaction_id: row.original_planned_transaction_id,
    corrected_from_transaction_id: row.original_corrected_from_transaction_id,
    voided_at: row.original_voided_at, created_at: row.original_created_at, updated_at: row.original_updated_at,
  });
  const effectiveTransaction = row.effective_id == null ? null : mapTransaction({
    id: row.effective_id, account_id: row.effective_account_id, date: row.effective_date,
    amount_cents: row.effective_amount_cents, currency: row.effective_currency,
    description: row.effective_description, kind: row.effective_kind, status: row.effective_status,
    source: row.effective_source, transfer_group_id: row.effective_transfer_group_id,
    planned_transaction_id: row.effective_planned_transaction_id,
    corrected_from_transaction_id: row.effective_corrected_from_transaction_id,
    voided_at: row.effective_voided_at, created_at: row.effective_created_at, updated_at: row.effective_updated_at,
  });
  return {
    id: String(row.id), plannedTransactionId: String(row.planned_transaction_id),
    originalTransactionId: String(row.transaction_id),
    correctionTransactionId: row.correction_transaction_id == null ? null : String(row.correction_transaction_id),
    occurrenceDate: String(row.occurrence_date), completedAt: String(row.created_at),
    adjustedAt: row.adjusted_at == null ? null : String(row.adjusted_at),
    status: row.status as PlannedCompletion["status"], adjustable: Boolean(row.adjustable),
    originalTransaction, effectiveTransaction,
  };
}

function mapPlanned(row: Row): PlannedTransaction {
  return {
    id: String(row.id), accountId: row.account_id == null ? null : String(row.account_id), description: String(row.description),
    kind: row.kind as PlannedTransaction["kind"], amountCents: Number(row.amount_cents), currency: String(row.currency),
    recurrence: row.recurrence as PlannedTransaction["recurrence"], intervalCount: Number(row.interval_count), nextDate: String(row.next_date),
    endDate: row.end_date == null ? null : String(row.end_date), isActive: Boolean(row.is_active),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapReserve(row: Row, asOfDate: string): Reserve {
  const reserve: Reserve = {
    id: String(row.id), name: String(row.name), fundedAmountCents: Number(row.amount_cents),
    targetAmountCents: row.target_amount_cents == null ? null : Number(row.target_amount_cents),
    targetDate: row.target_date == null ? null : String(row.target_date),
    contributionMonth: row.contribution_month == null ? null : String(row.contribution_month),
    contributedThisMonthCents: Number(row.contribution_cents), requiredContributionCents: 0,
    linkedPlannedTransactionId: row.linked_planned_transaction_id == null
      ? null
      : String(row.linked_planned_transaction_id),
    currency: String(row.currency), note: String(row.note), isActive: Boolean(row.is_active),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
  reserve.requiredContributionCents = requiredGoalContributionCents(reserve, asOfDate);
  return reserve;
}

async function executeReserveWrite(statement: { sql: string; args: (string | number | null)[] }, linkedId: string | null) {
  try {
    return await db.execute(statement);
  } catch (error) {
    if (linkedId && error instanceof Error && /constraint|unique/i.test(error.message)) throw invalidReserveLink();
    throw error;
  }
}

function invalidReserveLink(): Error {
  return conflict("Choose an active, one-off planned expense that is not linked to another goal");
}

function requireChanged(rowsAffected: number, entity: string): void {
  if (!rowsAffected) throw notFound(entity);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function notFound(entity: string): Error {
  return Object.assign(new Error(`${entity} not found`), { status: 404 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}
