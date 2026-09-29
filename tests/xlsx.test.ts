import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { canonicalImportIdentity, parseCsvTransactions, prepareCanonicalTransactions } from "../server/ingestion.ts";
import { parseXlsxSheet, readXlsxWorkbook } from "../server/xlsx.ts";

async function fixture(): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const note = workbook.addWorksheet("Instructions");
  note.addRow(["Synthetic bank statement"]);
  const sheet = workbook.addWorksheet("Movements");
  sheet.addRow(["Data", "Importo", "Descrizione", "ID"]);
  sheet.addRow([new Date("2026-09-16T00:00:00Z"), -12.34, "Synthetic groceries", "bank-1"]);
  sheet.addRow(["17/09/2026", "2,00", "Synthetic refund", "bank-2"]);
  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes).toString("base64");
}

describe("XLSX adapter", () => {
  it("selects a sheet and maps native date and numeric amounts through the canonical CSV mapping", async () => {
    const workbook = await readXlsxWorkbook(await fixture());
    expect(workbook.sheets.map(({ name }) => name)).toEqual(["Instructions", "Movements"]);
    expect(workbook.sheets[1].headers).toEqual(["Data", "Importo", "Descrizione", "ID"]);
    const mapping = { date: "Data", amount: "Importo", description: "Descrizione", externalId: "ID" };
    const parsed = parseXlsxSheet(workbook, "Movements", mapping);
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.transactions.map(({ occurredOn, amountCents, externalId }) => ({ occurredOn, amountCents, externalId }))).toEqual([
      { occurredOn: "2026-09-16", amountCents: -1234, externalId: "bank-1" },
      { occurredOn: "2026-09-17", amountCents: 200, externalId: "bank-2" },
    ]);
    const csv = parseCsvTransactions("Data,Importo,Descrizione,ID\n2026-09-16,-12.34,Synthetic groceries,bank-1\n", mapping);
    expect(await canonicalImportIdentity("xlsx", "account-a", parsed.transactions[0])).toEqual(
      await canonicalImportIdentity("csv", "account-a", csv.transactions[0]),
    );
    expect((await prepareCanonicalTransactions({ source: "xlsx", accountId: "account-a", transactions: parsed.transactions }))[0].sourcePosition).toBe(2);
    expect(() => parseXlsxSheet(workbook, "missing", mapping)).toThrow("not found");
  });

  it("rejects corrupt, encrypted and oversized archives and formula cells", async () => {
    await expect(readXlsxWorkbook("not-base64")).rejects.toThrow("invalid");
    const bytes = Buffer.from(await fixture(), "base64");
    bytes[0] = 0;
    await expect(readXlsxWorkbook(bytes.toString("base64"))).rejects.toThrow("corrupt");
    const encrypted = Buffer.from(await fixture(), "base64");
    const signature = Buffer.from([0x50, 0x4b, 1, 2]);
    const central = encrypted.indexOf(signature);
    encrypted[central + 8] |= 1;
    await expect(readXlsxWorkbook(encrypted.toString("base64"))).rejects.toThrow("Encrypted");
    await expect(readXlsxWorkbook("A".repeat(700_000))).rejects.toThrow("too large");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Formula");
    sheet.addRow(["Date", "Amount", "Description"]);
    sheet.addRow(["2026-09-16", { formula: "1+1", result: 2 }, "Synthetic"]);
    await expect(readXlsxWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"))).rejects.toThrow("formulas");
  });

  it("rejects worksheets larger than the row limit", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Too many");
    sheet.addRow(["Date", "Amount", "Description"]);
    sheet.getRow(2_002).getCell(1).value = "2026-09-16";
    await expect(readXlsxWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"))).rejects.toThrow("exceeds");
  });
});
