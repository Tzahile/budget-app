import { describe, expect, it } from "vitest";
import {
  assessIngestionDuplicates,
  canonicalImportIdentity,
  ingestionWritePlan,
  parseCsvTransactions,
  prepareCanonicalTransactions,
  rejectedIngestionWritePlan,
} from "../server/ingestion.ts";

describe("CSV canonical ingestion adapter", () => {
  it("normalizes quoted semicolon CSV values and Italian amounts before persistence", () => {
    const result = parseCsvTransactions(
      'Data;Importo;Descrizione;ID;Stato\n16/09/2026;-12,34;"Groceries; family";bank-123;Eseguito\n',
      { date: "Data", amount: "Importo", description: "Descrizione", externalId: "ID", status: "Stato" },
    );
    expect(result.errors).toEqual([]);
    expect(result.transactions).toEqual([expect.objectContaining({
      occurredOn: "2026-09-16", amountCents: -1234, description: "Groceries; family", externalId: "bank-123", status: "cleared",
    })]);
  });

  it("reports invalid rows and never quietly treats them as imports", () => {
    const result = parseCsvTransactions("date,amount,description\n2026-09-16,12.50,Salary\ninvalid,-2,Coffee\n", {
      date: "date", amount: "amount", description: "description",
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.errors).toEqual(["Row 3: date is invalid"]);
    expect(result.rowErrors).toEqual([{ sourcePosition: 3, code: "invalid_date", summary: "Date is invalid" }]);
  });

  it("uses account-scoped external IDs across source types and a stable normalized fingerprint otherwise", async () => {
    const source = { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee", status: "cleared" as const };
    const fingerprint = await canonicalImportIdentity("csv", "account-a", source);
    expect(fingerprint).toEqual(await canonicalImportIdentity("open_banking", "account-a", { ...source, description: "  COFFEE  " }));
    const external = await canonicalImportIdentity("csv", "account-a", { ...source, externalId: "bank-1" });
    expect(external).toEqual(await canonicalImportIdentity("open_banking", "account-a", { ...source, externalId: "bank-1" }));
    expect(external).not.toEqual(await canonicalImportIdentity("csv", "account-b", { ...source, externalId: "bank-1" }));
  });

  it("writes imported rows, balance changes, and the completed run atomically", async () => {
    const prepared = await prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", createId: (() => { let value = 0; return () => `tx-${++value}`; })(),
      transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee" },
        { occurredOn: "2026-09-17", amountCents: 5000, description: "Pending salary", status: "pending", externalId: "salary-1" },
      ],
    });
    const plan = ingestionWritePlan({
      importId: "import-a", accountId: "account-a", filename: "synthetic.csv", source: "csv", now: "2026-09-17T10:00:00.000Z",
      transactions: prepared,
      assessments: assessIngestionDuplicates(prepared, new Set([prepared[1].importIdentity])),
    });
    expect(plan).toMatchObject({ importedCount: 1, duplicateCount: 1 });
    expect(plan.statements.map((statement) => typeof statement === "string" ? statement : statement.sql)).toHaveLength(6);
  });

  it("marks repeated trusted external IDs as duplicates but accepts records in different accounts", async () => {
    const transactions = await prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", createId: () => "ignored",
      transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee", externalId: "same" },
        { occurredOn: "2026-09-17", amountCents: -300, description: "Tea", externalId: "same" },
      ],
    });
    expect(assessIngestionDuplicates(transactions, new Set()).map(({ decision, reason }) => ({ decision, reason }))).toEqual([
      { decision: "accepted", reason: "new_identity" },
      { decision: "duplicate", reason: "trusted_external_id" },
    ]);
    const otherAccount = await prepareCanonicalTransactions({
      source: "open_banking", accountId: "account-b", transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee", externalId: "same" },
      ],
    });
    expect(assessIngestionDuplicates(otherAccount, new Set([transactions[0].importIdentity]))[0].decision).toBe("accepted");
  });

  it("flags fallback fingerprint collisions as ambiguous instead of silently dropping a legitimate similar record", async () => {
    const transactions = await prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee shop" },
        { occurredOn: "2026-09-16", amountCents: -1234, description: "  COFFEE   SHOP " },
      ],
    });
    expect(assessIngestionDuplicates(transactions, new Set()).map(({ decision, reason }) => ({ decision, reason }))).toEqual([
      { decision: "accepted", reason: "new_identity" },
      { decision: "ambiguous", reason: "fallback_fingerprint" },
    ]);
  });

  it("records a blocked run with safe row outcomes and no transaction writes", async () => {
    const transactions = await prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", createId: () => "tx-1",
      transactions: [{
        occurredOn: "2026-09-16", amountCents: -1234, description: "Private source text",
        auditMetadata: { adapter: "csv", row: "2" },
      }],
    });
    const plan = rejectedIngestionWritePlan({
      importId: "import-a", accountId: "account-a", filename: "synthetic.csv", source: "csv",
      now: "2026-09-17T10:00:00.000Z", transactions,
      assessments: assessIngestionDuplicates(transactions, new Set()),
      rowErrors: [{ sourcePosition: 3, code: "invalid_amount", summary: "Amount is invalid" }],
      errorSummary: "Import blocked: 1 invalid row",
    });
    const sql = plan.statements.map((statement) => typeof statement === "string" ? statement : statement.sql).join("\n");
    expect(sql).not.toContain("INSERT OR IGNORE INTO transactions");
    expect(JSON.stringify(plan.statements)).not.toContain("Private source text");
    expect(plan).toMatchObject({ importedCount: 0, ambiguousCount: 0, errorCount: 2 });
  });
});
