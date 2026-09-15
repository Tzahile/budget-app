import { addRecurrence, calculateDashboard, householdDate } from "../shared/finance.ts";
import {
  DEMO_CLEANUP_CONFIRMATION,
  type Account,
  type AppData,
  type DemoDataState,
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

type Row = Record<string, unknown>;

export async function getAppData(asOfDate = householdDate()): Promise<AppData> {
  await ensureSchema();
  const monthStart = `${asOfDate.slice(0, 7)}-01`;
  const [accountResult, transactionResult, dashboardTransactionResult, plannedResult, completionResult, reserveResult, demoResult] = await Promise.all([
    db.execute("SELECT * FROM accounts ORDER BY is_active DESC, name COLLATE NOCASE"),
    db.execute("SELECT * FROM transactions WHERE voided_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 500"),
    db.execute({ sql: "SELECT * FROM transactions WHERE voided_at IS NULL AND date BETWEEN ? AND ?", args: [monthStart, asOfDate] }),
    db.execute("SELECT * FROM planned_transactions ORDER BY is_active DESC, next_date, description COLLATE NOCASE"),
    db.execute(PLANNED_COMPLETIONS_QUERY),
    db.execute("SELECT * FROM reserves ORDER BY is_active DESC, name COLLATE NOCASE"),
    db.execute(demoStateQuery()),
  ]);
  const accounts = accountResult.rows.map(mapAccount);
  const transactions = transactionResult.rows.map(mapTransaction);
  const dashboardTransactions = dashboardTransactionResult.rows.map(mapTransaction);
  const plannedTransactions = plannedResult.rows.map(mapPlanned);
  const plannedCompletions = completionResult.rows.map(mapCompletion);
  const reserves = reserveResult.rows.map(mapReserve);
  const demoDataState = demoStateFromRow(demoResult.rows[0] as Row | undefined);
  return {
    accounts,
    transactions,
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
  balanceCents: number;
  isActive: boolean;
}): Promise<void> {
  await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE accounts SET name = ?, type = ?, balance_cents = ?, is_active = ?, updated_at = ?, is_demo = 0 WHERE id = ?`,
    args: [input.name, input.type, input.balanceCents, Number(input.isActive), new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Account");
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
  const result = await db.execute({
    sql: `UPDATE planned_transactions SET account_id = ?, description = ?, kind = ?, amount_cents = ?, recurrence = ?,
      interval_count = ?, next_date = ?, end_date = ?, is_active = ?, revision = revision + 1,
      latest_completion_id = NULL, updated_at = ?, is_demo = 0 WHERE id = ?`,
    args: [input.accountId, input.description, input.kind, input.amountCents, input.recurrence, input.intervalCount,
      input.nextDate, input.endDate, Number(input.isActive), new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Planned transaction");
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

export async function createReserve(input: { name: string; amountCents: number; note: string }): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO reserves (id, name, amount_cents, currency, note, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'EUR', ?, 1, ?, ?)`,
    args: [crypto.randomUUID(), input.name, input.amountCents, input.note, now, now],
  });
}

export async function updateReserve(id: string, input: { name: string; amountCents: number; note: string; isActive: boolean }): Promise<void> {
  await ensureSchema();
  const result = await db.execute({
    sql: "UPDATE reserves SET name = ?, amount_cents = ?, note = ?, is_active = ?, updated_at = ?, is_demo = 0 WHERE id = ?",
    args: [input.name, input.amountCents, input.note, Number(input.isActive), new Date().toISOString(), id],
  });
  requireChanged(result.rowsAffected, "Reserve");
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

function mapAccount(row: Row): Account {
  return {
    id: String(row.id), name: String(row.name), type: row.type as Account["type"], currency: String(row.currency),
    balanceCents: Number(row.balance_cents), isActive: Boolean(row.is_active), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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

function mapReserve(row: Row): Reserve {
  return {
    id: String(row.id), name: String(row.name), amountCents: Number(row.amount_cents), currency: String(row.currency),
    note: String(row.note), isActive: Boolean(row.is_active), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function requireChanged(rowsAffected: number, entity: string): void {
  if (!rowsAffected) throw notFound(entity);
}

function notFound(entity: string): Error {
  return Object.assign(new Error(`${entity} not found`), { status: 404 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}
