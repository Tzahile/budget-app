import { assertDateOnly } from "../shared/finance.ts";
import type { Transaction, TransactionKind } from "../shared/types.ts";
import { ValidationError, uuidField } from "./validation.ts";

export type ActivitySource = "manual" | "planned" | "csv" | "open_banking";
export interface TransactionFilters {
  accountId?: string;
  from?: string;
  to?: string;
  kind?: TransactionKind;
  source?: ActivitySource;
  search?: string;
  cursor?: string;
  limit: number;
}

interface Position { date: string; createdAt: string; id: string }
export interface TransactionPage { items: (Transaction & { activitySource: ActivitySource; counterpartAccountId: string | null })[]; nextCursor: string | null }

function date(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  try { assertDateOnly(value); return value; }
  catch { throw new ValidationError(`${name} must be a valid YYYY-MM-DD date`); }
}

export function parseTransactionFilters(params: URLSearchParams): TransactionFilters {
  const allowed = new Set(["accountId", "from", "to", "kind", "source", "search", "cursor", "limit"]);
  for (const [key] of params) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new ValidationError("Invalid transaction filter");
  const accountId = params.get("accountId") ?? undefined;
  if (accountId) uuidField(accountId, "accountId");
  const from = date(params.get("from") ?? undefined, "from");
  const to = date(params.get("to") ?? undefined, "to");
  if (from && to && from > to) throw new ValidationError("from must be on or before to");
  const kind = params.get("kind") ?? undefined;
  if (kind && !["income", "expense", "refund", "transfer"].includes(kind)) throw new ValidationError("kind is invalid");
  const source = params.get("source") ?? undefined;
  if (source && !["manual", "planned", "csv", "open_banking"].includes(source)) throw new ValidationError("source is invalid");
  const search = params.get("search")?.trim() ?? undefined;
  if (search && search.length > 160) throw new ValidationError("search is too long");
  const limitString = params.get("limit");
  const limit = limitString === null ? 50 : Number(limitString);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("limit must be between 1 and 100");
  const cursor = params.get("cursor") ?? undefined;
  if (cursor && cursor.length > 512) throw new ValidationError("cursor is invalid");
  return { accountId, from, to, kind: kind as TransactionKind | undefined, source: source as ActivitySource | undefined, search, cursor, limit };
}

function decodeCursor(cursor: string): Position {
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as Position;
    date(value.date, "cursor date");
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value.createdAt)) throw new Error();
    uuidField(value.id);
    return value;
  } catch { throw new ValidationError("cursor is invalid"); }
}

function encodeCursor(value: Position): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import identity lives on the transaction; ingestion history identifies the provider.
const originSql = `CASE WHEN t.source = 'import' THEN
  COALESCE((SELECT i.source FROM ingestion_items ii JOIN imports i ON i.id = ii.import_id
    WHERE ii.transaction_id = t.id AND ii.status = 'accepted' LIMIT 1), 'csv')
  ELSE t.source END`;

export function transactionPageQuery(filters: TransactionFilters): { sql: string; args: (string | number)[] } {
  const clauses = ["t.voided_at IS NULL"];
  const args: (string | number)[] = [];
  // One household transfer row; an account filter shows that account's leg.
  if (!filters.accountId) clauses.push("(t.kind <> 'transfer' OR t.amount_cents < 0)");
  if (filters.accountId) { clauses.push("t.account_id = ?"); args.push(filters.accountId); }
  if (filters.from) { clauses.push("t.date >= ?"); args.push(filters.from); }
  if (filters.to) { clauses.push("t.date <= ?"); args.push(filters.to); }
  if (filters.kind) { clauses.push("t.kind = ?"); args.push(filters.kind); }
  if (filters.source) { clauses.push(`${originSql} = ?`); args.push(filters.source); }
  if (filters.search) { clauses.push("instr(lower(t.description), lower(?)) > 0"); args.push(filters.search); }
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    clauses.push("(t.date, t.created_at, t.id) < (?, ?, ?)");
    args.push(cursor.date, cursor.createdAt, cursor.id);
  }
  args.push(filters.limit + 1);
  return {
    sql: `SELECT t.*, ${originSql} AS activity_source,
      (SELECT other.account_id FROM transactions other WHERE other.transfer_group_id = t.transfer_group_id AND other.id <> t.id LIMIT 1) AS counterpart_account_id
      FROM transactions t WHERE ${clauses.join(" AND ")}
      ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT ?`, args,
  };
}

export function nextTransactionCursor(items: readonly Position[], limit: number): string | null {
  if (items.length <= limit) return null;
  return encodeCursor(items[limit - 1]);
}
