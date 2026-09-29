import ExcelJS from "exceljs";
import { parseTabularTransactions, type CsvColumnMapping, type CsvParseResult } from "./ingestion.ts";

export const MAX_XLSX_BYTES = 500_000;
const MAX_SHEETS = 20;
const MAX_ROWS = 2_001; // header plus 2,000 transactions
const MAX_COLUMNS = 30;
const MAX_UNCOMPRESSED_BYTES = 8_000_000;

export interface XlsxWorkbook {
  sheets: { name: string; headers: string[] }[];
  rowsBySheet: Map<string, string[][]>;
}

/** Parse only a small, ordinary XLSX ZIP. Reject encrypted and oversized archives before inflation. */
export async function readXlsxWorkbook(base64: string): Promise<XlsxWorkbook> {
  if (!base64 || base64.length > Math.ceil(MAX_XLSX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("XLSX file is invalid or too large");
  }
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)); }
  catch { throw new Error("XLSX file is invalid"); }
  if (bytes.length > MAX_XLSX_BYTES) throw new Error("XLSX file is too large");
  checkZipDirectory(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS accepts Uint8Array at runtime in both Node and Deno.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new Error("XLSX file is corrupt or unsupported");
  }
  if (!workbook.worksheets.length || workbook.worksheets.length > MAX_SHEETS) throw new Error(`XLSX must have 1–${MAX_SHEETS} sheets`);
  const sheets: XlsxWorkbook["sheets"] = [];
  const rowsBySheet = new Map<string, string[][]>();
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) throw new Error(`XLSX sheet exceeds ${MAX_ROWS} rows or ${MAX_COLUMNS} columns`);
    const rows: string[][] = [];
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const values: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column++) {
        const cell = row.getCell(column);
        if (cell.type === ExcelJS.ValueType.Formula) throw new Error("XLSX formulas are not supported; export values instead");
        values.push(cellValue(cell.value));
      }
      rows.push(values);
    }
    sheets.push({ name: sheet.name, headers: rows[0]?.map((value) => value.trim().replace(/^\uFEFF/, "")) ?? [] });
    rowsBySheet.set(sheet.name, rows);
  }
  return { sheets, rowsBySheet };
}

export function parseXlsxSheet(workbook: XlsxWorkbook, sheetName: string, mapping: CsvColumnMapping): CsvParseResult {
  const rows = workbook.rowsBySheet.get(sheetName);
  if (!rows) throw new Error("XLSX sheet was not found");
  return parseTabularTransactions(rows, mapping, "xlsx");
}

function cellValue(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  throw new Error("XLSX contains an unsupported cell value");
}

function checkZipDirectory(bytes: Uint8Array): void {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error("XLSX file is corrupt or unsupported");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error("XLSX file is corrupt or unsupported");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + view.getUint32(end + 12, true);
  if (count < 1 || count > 150 || directoryEnd !== end) throw new Error("XLSX archive exceeds limits or is unsupported");
  let inflated = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX file is corrupt or unsupported");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (flags & 1) throw new Error("Encrypted XLSX files are not supported");
    if (![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error("XLSX archive is unsupported");
    inflated += uncompressed;
    if (inflated > MAX_UNCOMPRESSED_BYTES) throw new Error("XLSX uncompressed data exceeds limit");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== end) throw new Error("XLSX file is corrupt or unsupported");
}
