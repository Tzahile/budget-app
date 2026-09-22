import { assertDateOnly } from "../shared/finance.ts";
import type { TransactionKind, TransactionStatus } from "../shared/types.ts";
import type { MigrationStatement } from "./migrations.ts";

export type IngestionSource = "csv" | "open_banking";

/** The source-neutral boundary every import and future bank sync must cross. */
export interface CanonicalTransactionInput {
  occurredOn: string;
  amountCents: number;
  description: string;
  externalId?: string | null;
  status?: TransactionStatus;
  /** Limited, non-secret source audit data. Never include account credentials. */
  auditMetadata?: Record<string, string>;
}

export interface CsvColumnMapping {
  date: string;
  amount: string;
  description: string;
  externalId?: string;
  status?: string;
}

export interface CsvParseResult {
  transactions: CanonicalTransactionInput[];
  errors: string[];
}

export interface PreparedIngestionTransaction extends CanonicalTransactionInput {
  id: string;
  importIdentity: string;
  /** External IDs can prove an existing record is the same; fingerprints cannot. */
  identityKind: "external" | "fingerprint";
  kind: TransactionKind;
  metadataJson: string | null;
}

export type IngestionDuplicateDecision = "accepted" | "duplicate" | "ambiguous";

export interface IngestionDuplicateAssessment {
  transaction: PreparedIngestionTransaction;
  decision: IngestionDuplicateDecision;
  /** Stable, non-sensitive reason suitable for UI/API feedback. */
  reason: "new_identity" | "trusted_external_id" | "fallback_fingerprint";
}

export interface IngestionWriteInput {
  importId: string;
  accountId: string;
  filename: string;
  source: IngestionSource;
  now: string;
  transactions: PreparedIngestionTransaction[];
  assessments: readonly IngestionDuplicateAssessment[];
}

export interface IngestionWritePlan {
  statements: MigrationStatement[];
  importedCount: number;
  duplicateCount: number;
}

const maxCsvBytes = 500_000;
const maxRows = 2_000;
const maxDescriptionLength = 500;
const maxExternalIdLength = 200;
const knownStatus: ReadonlyMap<string, TransactionStatus> = new Map([
  ["pending", "pending"], ["in attesa", "pending"], ["cleared", "cleared"],
  ["completed", "cleared"], ["booked", "cleared"], ["eseguito", "cleared"],
] as const);

export function parseCsvTransactions(csv: string, mapping: CsvColumnMapping): CsvParseResult {
  if (new TextEncoder().encode(csv).byteLength > maxCsvBytes) throw new Error("CSV file is too large");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one data row");
  if (rows.length - 1 > maxRows) throw new Error(`CSV contains more than ${maxRows} rows`);
  const headers = rows[0].map(normalizeHeader);
  const indexFor = (column: string, required: boolean): number => {
    const index = headers.indexOf(normalizeHeader(column));
    if (index < 0 && required) throw new Error(`CSV column '${column}' was not found`);
    return index;
  };
  const dateIndex = indexFor(mapping.date, true);
  const amountIndex = indexFor(mapping.amount, true);
  const descriptionIndex = indexFor(mapping.description, true);
  const externalIdIndex = mapping.externalId ? indexFor(mapping.externalId, false) : -1;
  const statusIndex = mapping.status ? indexFor(mapping.status, false) : -1;
  const transactions: CanonicalTransactionInput[] = [];
  const errors: string[] = [];

  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    if (row.every((value) => !value.trim())) return;
    try {
      const occurredOn = parseCsvDate(valueAt(row, dateIndex));
      const amountCents = parseCsvAmount(valueAt(row, amountIndex));
      const description = valueAt(row, descriptionIndex).trim();
      if (!description || description.length > maxDescriptionLength) throw new Error("description is missing or too long");
      const externalId = externalIdIndex < 0 ? null : valueAt(row, externalIdIndex).trim() || null;
      if (externalId && externalId.length > maxExternalIdLength) throw new Error("external ID is too long");
      const status = statusIndex < 0 ? "cleared" : parseStatus(valueAt(row, statusIndex));
      transactions.push({
        occurredOn, amountCents, description, externalId, status,
        auditMetadata: { adapter: "csv", row: String(rowNumber) },
      });
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error instanceof Error ? error.message : "invalid value"}`);
    }
  });
  return { transactions, errors };
}

export async function prepareCanonicalTransactions(input: {
  source: IngestionSource;
  accountId: string;
  transactions: readonly CanonicalTransactionInput[];
  createId?: () => string;
}): Promise<PreparedIngestionTransaction[]> {
  // Node's Web Crypto implementation requires its receiver, unlike the
  // Val Town runtime. Keep the default callable in both environments.
  const createId = input.createId ?? (() => crypto.randomUUID());
  const identities = new Set<string>();
  const prepared: PreparedIngestionTransaction[] = [];
  for (const transaction of input.transactions) {
    validateCanonical(transaction);
    const { importIdentity, identityKind } = await canonicalImportIdentity(input.source, input.accountId, transaction);
    // Keep repeated fallback tuples for assessment: they might be two genuine
    // transactions, so rejecting/dropping one here would lose data.
    if (identityKind === "external" && identities.has(importIdentity)) {
      // It is safe to classify this as a duplicate later because the external
      // identifier is a trusted source identity, unlike a descriptive tuple.
    }
    identities.add(importIdentity);
    const kind: TransactionKind = transaction.amountCents > 0 ? "income" : "expense";
    prepared.push({
      ...transaction, id: createId(), importIdentity, identityKind, kind,
      status: transaction.status ?? "cleared",
      metadataJson: serializeAuditMetadata(transaction.auditMetadata),
    });
  }
  return prepared;
}

export function ingestionWritePlan(input: IngestionWriteInput): IngestionWritePlan {
  const imported = input.assessments
    .filter((assessment) => assessment.decision === "accepted")
    .map((assessment) => assessment.transaction);
  const statements: MigrationStatement[] = [{
    sql: `INSERT INTO imports (id, filename, source, account_id, status, row_count, imported_count, duplicate_count, created_at, completed_at)
      VALUES (?, ?, ?, ?, 'processing', ?, 0, 0, ?, NULL)`,
    args: [input.importId, input.filename, input.source, input.accountId, input.transactions.length, input.now],
  }];
  for (const transaction of imported) {
    statements.push({
      // The unique identity is the final concurrency guard. `changes()` keeps
      // a concurrent retry from applying a balance update after INSERT IGNORE.
      sql: `INSERT OR IGNORE INTO transactions
        (id, account_id, date, amount_cents, currency, description, kind, status, source,
         external_id, import_identity, raw_metadata, created_at, updated_at, is_demo)
        VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, 'import', ?, ?, ?, ?, ?, 0)`,
      args: [transaction.id, input.accountId, transaction.occurredOn, transaction.amountCents, transaction.description,
        transaction.kind, transaction.status ?? "cleared", transaction.externalId ?? null, transaction.importIdentity,
        transaction.metadataJson, input.now, input.now],
    });
    if (transaction.status !== "pending") {
      statements.push({
        sql: `UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ?, is_demo = 0
          WHERE id = ? AND changes() = 1`,
        args: [transaction.amountCents, input.now, input.accountId],
      });
    }
  }
  statements.push({
    sql: `UPDATE imports SET status = 'completed', imported_count = ?, duplicate_count = ?, completed_at = ? WHERE id = ?`,
    args: [imported.length, input.assessments.filter((assessment) => assessment.decision === "duplicate").length, input.now, input.importId],
  });
  return {
    statements,
    importedCount: imported.length,
    duplicateCount: input.assessments.filter((assessment) => assessment.decision === "duplicate").length,
  };
}

/**
 * Build an account-scoped identity without tying it to an adapter. An account
 * can first receive a CSV then later an Open Banking sync; a trusted external
 * ID must still deduplicate across those sources. Fallback fingerprints are
 * deliberately conservative and are never sufficient evidence to discard a
 * pre-existing record.
 */
export async function canonicalImportIdentity(_source: IngestionSource, accountId: string, transaction: CanonicalTransactionInput): Promise<{
  importIdentity: string;
  identityKind: "external" | "fingerprint";
}> {
  const externalId = transaction.externalId?.trim();
  const identityKind = externalId ? "external" : "fingerprint";
  const stable = externalId
    ? `external:${externalId}`
    : `fingerprint:${transaction.occurredOn}\u001f${transaction.amountCents}\u001f${normalizeFingerprintDescription(transaction.description)}`;
  const bytes = new TextEncoder().encode(`v2\u001f${accountId}\u001f${stable}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    importIdentity: `v2:${identityKind}:sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    identityKind,
  };
}

/**
 * Decide every row before writes. Only trusted external IDs become automatic
 * duplicates. A matching fallback fingerprint is ambiguous: importing it can
 * double-count, while skipping it can silently lose a legitimate purchase.
 */
export function assessIngestionDuplicates(
  transactions: readonly PreparedIngestionTransaction[],
  existingIdentities: ReadonlySet<string>,
): IngestionDuplicateAssessment[] {
  const seen = new Set(existingIdentities);
  return transactions.map((transaction) => {
    const exists = seen.has(transaction.importIdentity);
    seen.add(transaction.importIdentity);
    if (!exists) return { transaction, decision: "accepted", reason: "new_identity" };
    if (transaction.identityKind === "external") {
      return { transaction, decision: "duplicate", reason: "trusted_external_id" };
    }
    return { transaction, decision: "ambiguous", reason: "fallback_fingerprint" };
  });
}

function validateCanonical(transaction: CanonicalTransactionInput): void {
  try { assertDateOnly(transaction.occurredOn); } catch { throw new Error("date must be YYYY-MM-DD"); }
  if (!Number.isSafeInteger(transaction.amountCents) || transaction.amountCents === 0) throw new Error("amount must be non-zero integer cents");
  if (!transaction.description.trim() || transaction.description.trim().length > maxDescriptionLength) throw new Error("description is missing or too long");
  if (transaction.externalId && transaction.externalId.length > maxExternalIdLength) throw new Error("external ID is too long");
  if (transaction.status && transaction.status !== "cleared" && transaction.status !== "pending") throw new Error("status is invalid");
}

function serializeAuditMetadata(metadata: Record<string, string> | undefined): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata);
  if (entries.length > 10 || entries.some(([key, value]) => key.length > 50 || value.length > 200)) throw new Error("audit metadata is too large");
  return JSON.stringify(Object.fromEntries(entries));
}

function parseCsv(input: string): string[][] {
  const delimiter = input.slice(0, input.indexOf("\n") < 0 ? input.length : input.indexOf("\n")).includes(";") ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') {
      if (field) throw new Error("invalid CSV quoting");
      quoted = true;
    } else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function valueAt(row: string[], index: number): string { return index < row.length ? row[index] : ""; }
function normalizeHeader(value: string): string { return value.trim().replace(/^\uFEFF/, "").toLowerCase(); }
function parseCsvDate(value: string): string {
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const italian = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const date = iso ? value.trim() : italian ? `${italian[3]}-${italian[2]}-${italian[1]}` : "";
  try { assertDateOnly(date); return date; } catch { throw new Error("date is invalid"); }
}
function parseCsvAmount(value: string): number {
  const normalized = value.trim().replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("amount is invalid");
  const negative = normalized.startsWith("-");
  const absolute = normalized.replace(/^[+-]/, "");
  const [whole, fraction = ""] = absolute.split(".");
  const cents = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents) || cents === 0) throw new Error("amount is invalid");
  return cents;
}
function parseStatus(value: string): TransactionStatus {
  const status = knownStatus.get(value.trim().toLowerCase());
  if (!status) throw new Error("status is invalid");
  return status;
}

function normalizeFingerprintDescription(value: string): string {
  // NFKC handles equivalent Unicode representations; whitespace/case changes
  // are common CSV presentation differences. Punctuation is intentionally
  // retained because stripping it makes distinct merchant references collide.
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
