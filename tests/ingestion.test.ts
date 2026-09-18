import { describe, expect, it } from "vitest";
import {
  canonicalImportIdentity,
  ingestionWritePlan,
  parseCsvTransactions,
  prepareCanonicalTransactions,
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
  });

  it("uses external IDs when available and a stable tuple otherwise", async () => {
    const source = { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee", status: "cleared" as const };
    await expect(canonicalImportIdentity("csv", "account-a", source)).resolves.toBe(
      await canonicalImportIdentity("csv", "account-a", source),
    );
    await expect(canonicalImportIdentity("csv", "account-a", { ...source, externalId: "bank-1" })).resolves.not.toBe(
      await canonicalImportIdentity("csv", "account-a", { ...source, externalId: "bank-2" }),
    );
  });

  it("writes imported rows, balance changes, and the completed run atomically", async () => {
    const prepared = await prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", createId: (() => { let value = 0; return () => `tx-${++value}`; })(),
      transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee" },
        { occurredOn: "2026-09-17", amountCents: 5000, description: "Pending salary", status: "pending" },
      ],
    });
    const plan = ingestionWritePlan({
      importId: "import-a", accountId: "account-a", filename: "synthetic.csv", source: "csv", now: "2026-09-17T10:00:00.000Z",
      transactions: prepared, duplicateIdentities: new Set([prepared[1].importIdentity]),
    });
    expect(plan).toMatchObject({ importedCount: 1, duplicateCount: 1 });
    expect(plan.statements.map((statement) => typeof statement === "string" ? statement : statement.sql)).toHaveLength(4);
  });

  it("rejects duplicate source rows before any database write plan", async () => {
    await expect(prepareCanonicalTransactions({
      source: "csv", accountId: "account-a", createId: () => "ignored",
      transactions: [
        { occurredOn: "2026-09-16", amountCents: -1234, description: "Coffee", externalId: "same" },
        { occurredOn: "2026-09-17", amountCents: -300, description: "Tea", externalId: "same" },
      ],
    })).rejects.toThrow("duplicate transactions");
  });
});
