import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";

let database: DatabaseSync;
let handler: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  Object.assign(globalThis, { Deno: { env: { get: () => "" } } });
  ({ default: handler } = await import("../index.http.ts"));
});

afterAll(() => database.close());

function request(path: string, init: RequestInit = {}, user: string | null = "tzahile"): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user) headers.set("X-Test-User", user);
  return Promise.resolve(handler(new Request(`https://budget.example${path}`, { ...init, headers })));
}

describe("Hono financial API security integration", () => {
  it("previews XLSX sheets, imports via saved CSV mapping, and deduplicates across formats", async () => {
    const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Notes").addRow(["Synthetic only"]);
    const sheet = workbook.addWorksheet("Movements");
    sheet.addRow(["Date", "Amount", "Description", "ID"]);
    sheet.addRow(["2026-09-16", -4.25, "Synthetic XLSX purchase", "xlsx-integration-1"]);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
    const mapping = { date: "Date", amount: "Amount", description: "Description", externalId: "ID", decimalSeparator: "." };
    const selection = await request("/api/imports/xlsx/preview", { method: "POST", headers, body: JSON.stringify({ xlsx }) });
    expect(selection.status).toBe(200);
    expect(await selection.json()).toMatchObject({ sheets: ["Notes", "Movements"], sheet: "Notes" });
    const preview = await request("/api/imports/xlsx/preview", { method: "POST", headers, body: JSON.stringify({ xlsx, sheet: "Movements", mapping }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ rowCount: 1, validCount: 1, sample: [{ amountCents: -425 }] });
    expect((await request("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name: "Synthetic XLSX account", type: "checking", balanceCents: 0 }) })).status).toBe(201);
    const data = await (await request("/api/data")).json() as { accounts: Array<{ id: string; name: string }> };
    const accountId = data.accounts.find(({ name }) => name === "Synthetic XLSX account")!.id;
    const body = { accountId, filename: "synthetic.xlsx", xlsx, sheet: "Movements", mapping };
    const imported = await request("/api/imports/xlsx", { method: "POST", headers, body: JSON.stringify(body) });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({ importedCount: 1, rowCount: 1 });
    const csv = "Date,Amount,Description,ID\n2026-09-16,-4.25,Synthetic XLSX purchase,xlsx-integration-1\n";
    const duplicate = await request("/api/imports/csv", { method: "POST", headers, body: JSON.stringify({ accountId, filename: "synthetic.csv", csv, mapping }) });
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    expect((await (await request("/api/imports")).json()).imports).toContainEqual(expect.objectContaining({ source: "xlsx", acceptedCount: 1 }));
  });
  it("accepts positive manual refunds and rejects invalid kinds or amounts on create and edit", async () => {
    const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
    const accountResponse = await request("/api/accounts", { method: "POST", headers,
      body: JSON.stringify({ name: "Synthetic API refund account", type: "checking", balanceCents: 10_000 }) });
    expect(accountResponse.status).toBe(201);
    const accounts = await (await request("/api/data?asOf=2026-12-31")).json() as { accounts: Array<{ id: string; name: string }> };
    const accountId = accounts.accounts.find((item) => item.name === "Synthetic API refund account")!.id;
    const body = { accountId, date: "2026-12-31", description: "Synthetic API refund", amountCents: 1_000, kind: "refund" };
    expect((await request("/api/transactions", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(201);
    const snapshot = await (await request("/api/data?asOf=2026-12-31")).json() as { transactions: Array<{ id: string; description: string }> };
    const id = snapshot.transactions.find((item) => item.description === body.description)!.id;
    expect((await request(`/api/transactions/${id}`, { method: "PUT", headers,
      body: JSON.stringify({ ...body, amountCents: 2_000 }) })).status).toBe(200);
    for (const invalid of [{ ...body, kind: "transfer" }, { ...body, kind: "bogus" }, { ...body, amountCents: -1_000 }, { ...body, amountCents: 0 }]) {
      expect((await request("/api/transactions", { method: "POST", headers, body: JSON.stringify(invalid) })).status).toBe(400);
      expect((await request(`/api/transactions/${id}`, { method: "PUT", headers, body: JSON.stringify(invalid) })).status).toBe(400);
    }
    expect((await request(`/api/transactions/${id}`, { method: "DELETE", headers })).status).toBe(204);
  });

  it("accepts CSV requests over the ordinary JSON limit with an automatic date format", async () => {
    const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
    const csv = "Date,Amount,Description,ID\n" + Array.from({ length: 210 }, (_, index) => `2026-09-16,-1.00,Synthetic purchase ${"x".repeat(140)},row-${index}\n`).join("");
    expect(csv.length).toBeGreaterThan(32_000);
    const mapping = { date: "Date", amount: "Amount", description: "Description", externalId: "ID" };
    const preview = await request("/api/imports/csv/preview", { method: "POST", headers, body: JSON.stringify({ csv, mapping }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ rowCount: 210, validCount: 210, rowErrors: [] });
    const created = await request("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name: "Synthetic bulk CSV account", type: "checking", balanceCents: 0 }) });
    expect(created.status).toBe(201);
    const data = await (await request("/api/data")).json() as { accounts: Array<{ id: string; name: string }> };
    const accountId = data.accounts.find((account) => account.name === "Synthetic bulk CSV account")!.id;
    const imported = await request("/api/imports/csv", { method: "POST", headers, body: JSON.stringify({ accountId, filename: "synthetic.csv", csv, mapping }) });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({ importedCount: 210, rowCount: 210 });
    const oversizedOrdinaryRequest = await request("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name: "x".repeat(33_000), type: "checking", balanceCents: 0 }) });
    expect(oversizedOrdinaryRequest.status).toBe(413);
  });
  it("previews mapped rows and supports editable, deletable CSV profiles", async () => {
    const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
    const csv = "Date;Debit;Credit;Details\n16/09/2026;12,50;;Synthetic coffee\n17/09/2026;;2,00;Synthetic refund\ninvalid;1,00;;Invalid date\n";
    const mapping = { date: "Date", debit: "Debit", credit: "Credit", description: "Details", decimalSeparator: "," };
    const preview = await request("/api/imports/csv/preview", { method: "POST", headers, body: JSON.stringify({ csv, mapping }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ rowCount: 3, validCount: 2, sample: [
      { occurredOn: "2026-09-16", amountCents: -1250 }, { occurredOn: "2026-09-17", amountCents: 200 },
    ], rowErrors: [{ sourcePosition: 4, code: "invalid_date" }] });
    const created = await request("/api/imports/csv/profiles", { method: "POST", headers, body: JSON.stringify({ name: "Synthetic bank", mapping }) });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await (await request("/api/imports/csv/profiles")).json()).profiles).toContainEqual(expect.objectContaining({ id, name: "Synthetic bank", mapping }));
    expect((await request(`/api/imports/csv/profiles/${id}`, { method: "PUT", headers, body: JSON.stringify({ name: "Synthetic bank revised", mapping }) })).status).toBe(200);
    expect((await request(`/api/imports/csv/profiles/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await (await request("/api/imports/csv/profiles")).json()).profiles).toEqual([]);
    expect((await request("/api/imports/csv/preview", {}, null)).status).toBe(401);
  });
  it("enforces authentication, allowlisting, mutation origin, and JSON boundaries before repository access", async () => {
    expect((await request("/api/data", {}, null)).status).toBe(401);
    expect((await request("/api/data", {}, "not-allowed")).status).toBe(403);
    expect((await request("/api/data")).status).toBe(200);

    expect((await request("/api/accounts", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await request("/api/accounts", {
      method: "POST",
      headers: { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "text/plain" },
      body: "{}",
    })).status).toBe(415);
  });

  it("returns validated responses through the real Hono route and keeps error details bounded", async () => {
    const created = await request("/api/accounts", {
      method: "POST",
      headers: { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Synthetic route account", type: "checking", balanceCents: 12_345 }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true });
    expect(created.headers.get("Cache-Control")).toBe("no-store");

    const invalid = await request("/api/accounts", {
      method: "POST",
      headers: { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Synthetic route account", type: "checking", balanceCents: "not-cents" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "balanceCents must be a safe integer number of cents" });
    const data = await (await request("/api/data?asOf=2026-09-30")).json() as { accounts: Array<{ name: string; balanceCents: number }> };
    expect(data.accounts).toContainEqual(expect.objectContaining({ name: "Synthetic route account", balanceCents: 12_345 }));
  });

  it("records rejected CSV rows and exposes authenticated ingestion history", async () => {
    const data = await (await request("/api/data?asOf=2026-09-30")).json() as { accounts: Array<{ id: string; name: string }> };
    const accountId = data.accounts.find((account) => account.name === "Synthetic route account")!.id;
    const response = await request("/api/imports/csv", {
      method: "POST",
      headers: { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        filename: "synthetic-invalid.csv",
        retryKey: "http-invalid-1",
        csv: "date,amount,description\ninvalid,-12.00,Private merchant text\n",
        mapping: { date: "date", amount: "amount", description: "description" },
      }),
    });
    expect(response.status).toBe(422);
    const rejected = await response.json() as { importId: string; errors: string[] };
    expect(rejected.importId).not.toBe("");
    expect(rejected.errors).toEqual(["Row 2: date is invalid"]);

    const historyResponse = await request("/api/imports?limit=10");
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { imports: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }> };
    expect(history.imports).toContainEqual(expect.objectContaining({
      id: rejected.importId,
      status: "failed",
      errorSummary: "Import blocked: 1 invalid row",
      items: [expect.objectContaining({ status: "error", errorCode: "invalid_date" })],
    }));
    expect(JSON.stringify(history)).not.toContain("Private merchant text");
    expect((await request("/api/imports", {}, null)).status).toBe(401);
  });
});

it("shows source denominations and blocks foreign currencies even beyond the preview sample", async () => {
  const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
  const mapping = { date: "Date", amount: "Amount", description: "Description", currency: "Currency" };
  const csv = "Date,Amount,Description,Currency\n" + Array.from({ length: 6 }, (_, index) => `2026-09-16,-2.00,Synthetic,${index === 5 ? "USD" : "EUR"}\n`).join("");
  const preview = await request("/api/imports/csv/preview", { method: "POST", headers, body: JSON.stringify({ csv, mapping }) });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ validCount: 6, unsupportedCurrencyCount: 1, sample: Array.from({ length: 5 }, () => expect.objectContaining({ currency: "EUR" })) });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Synthetic");
  sheet.addRow(["Date", "Amount", "Description", "Currency"]);
  sheet.addRow(["2026-09-16", -2, "Synthetic", "USD"]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
  const xlsxPreview = await request("/api/imports/xlsx/preview", { method: "POST", headers, body: JSON.stringify({ xlsx, mapping }) });
  expect(xlsxPreview.status).toBe(200);
  expect(await xlsxPreview.json()).toMatchObject({ unsupportedCurrencyCount: 1, sample: [{ currency: "USD", amountCents: -200 }] });
  const before = database.prepare("SELECT COUNT(*) AS count FROM accounts").get();
  const rejected = await request("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name: "Synthetic foreign", type: "checking", balanceCents: 200, currency: "USD" }) });
  expect(rejected.status).toBe(422);
  expect(database.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual(before);
});

it("detects source currency with a legacy profile and audits blocked CSV and XLSX rows", async () => {
  const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
  const post = (path: string, body: unknown) => request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const legacyMapping = { date: "Date", amount: "Amount", description: "Description", decimalSeparator: "." };
  const saved = await post("/api/imports/csv/profiles", { name: "Synthetic legacy profile", mapping: legacyMapping });
  expect(saved.status).toBe(201);
  const { id } = await saved.json() as { id: string };
  const { profiles } = await (await request("/api/imports/csv/profiles")).json() as {
    profiles: Array<{ id: string; mapping: typeof legacyMapping }>;
  };
  const mapping = profiles.find((profile) => profile.id === id)!.mapping;
  expect(mapping).not.toHaveProperty("currency");
  const created = await post("/api/accounts", { name: "Synthetic currency audit", type: "checking", balanceCents: 7_000 });
  expect(created.status).toBe(201);
  const account = database.prepare("SELECT id FROM accounts WHERE name = ?").get("Synthetic currency audit")!;
  const accountId = String(account.id);

  const csv = "Date,Amount,Description,Currency\n2026-09-16,-2.00,Synthetic foreign,USD\ninvalid,-3.00,Synthetic malformed,EUR\n2026-09-18,-4.00,Synthetic valid,EUR\n";
  const csvPreview = await post("/api/imports/csv/preview", { csv, mapping });
  expect(await csvPreview.json()).toMatchObject({
    unsupportedCurrencyCount: 1,
    sample: [{ currency: "USD" }, { currency: "EUR" }],
  });

  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("First");
  first.addRow(["Date", "Amount", "Description"]);
  first.addRow(["2026-09-16", -1, "Synthetic default"]);
  const switched = workbook.addWorksheet("Switched");
  switched.addRow(["Date", "Amount", "Description", "  VaLuTa  "]);
  switched.addRow(["2026-09-16", -2, "Synthetic foreign", "USD"]);
  switched.addRow(["invalid", -3, "Synthetic malformed", "EUR"]);
  switched.addRow(["2026-09-18", -4, "Synthetic valid", "EUR"]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
  const firstPreview = await post("/api/imports/xlsx/preview", { xlsx, mapping, sheet: "First" });
  expect(await firstPreview.json()).toMatchObject({ sheet: "First", unsupportedCurrencyCount: 0 });
  const switchedPreview = await post("/api/imports/xlsx/preview", { xlsx, mapping, sheet: "Switched" });
  expect(await switchedPreview.json()).toMatchObject({ sheet: "Switched", unsupportedCurrencyCount: 1 });

  const attempts = [
    { source: "csv", data: { csv } },
    { source: "xlsx", data: { xlsx, sheet: "Switched" } },
  ];
  for (const { source, data } of attempts) {
    const body = { accountId, filename: `synthetic-currency.${source}`, retryKey: "currency-audit", mapping, ...data };
    const response = await post(`/api/imports/${source}`, body);
    expect(response.status).toBe(422);
    const rejected = await response.json() as { importId: string; errors: string[] };
    expect(rejected.importId).toBeTruthy();
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Only EUR is supported"),
      "Row 3: date is invalid",
    ]));
    const replay = await post(`/api/imports/${source}`, body);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ importId: rejected.importId });
    const history = await (await request("/api/imports?limit=10")).json() as { imports: unknown[] };
    expect(history.imports).toContainEqual(expect.objectContaining({
      id: rejected.importId,
      status: "failed",
      items: [
        expect.objectContaining({ sourcePosition: 2, status: "error", errorCode: "unsupported_currency" }),
        expect.objectContaining({ sourcePosition: 3, status: "error", errorCode: "invalid_date" }),
        expect.objectContaining({ sourcePosition: 4, status: "error", errorCode: "run_blocked" }),
      ],
    }));
    expect(JSON.stringify(history)).not.toContain("Synthetic foreign");
  }
  expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 7_000 });
  expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?").get(accountId)).toMatchObject({ count: 0 });
});
