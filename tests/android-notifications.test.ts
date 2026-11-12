import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAndroidNotification, normalizeAndroidNotification } from "../server/android-notifications.ts";
import { createAccount, getAppData, ingestTransactions, listTransactions } from "../server/repository.ts";
import { exportBackup } from "../server/backup.ts";
import { sqlite, useTestSqlite } from "./support/val-sqlite.ts";

let database: DatabaseSync;
let handler: (request: Request) => Response | Promise<Response>;
let enabled = false;
const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
const event = (accountId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, eventId: crypto.randomUUID(), accountId, date: "2026-10-30", amountCents: -1234, currency: "EUR", kind: "expense", ...extra });

beforeAll(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  Object.assign(globalThis, { Deno: { env: { get: (key: string) => key === "BUDGET_APP_ANDROID_NOTIFICATIONS_ENABLED" && enabled ? "true" : "" } } });
  ({ default: handler } = await import("../index.http.ts"));
});
afterAll(() => database.close());
function request(path: string, body: unknown, extraHeaders: Record<string, string> = {}, user: string | null = "tzahile"): Promise<Response> {
  return Promise.resolve(handler(new Request(`https://budget.example/api/notifications/android/${path}`, {
    method: "POST", headers: { ...headers, ...(user ? { "X-Test-User": user } : {}), ...extraHeaders }, body: JSON.stringify(body),
  })));
}
async function account(): Promise<string> {
  await createAccount({ name: "Synthetic notification account", type: "checking", balanceCents: 100_000 });
  return (await getAppData("2026-10-30")).accounts.at(-1)!.id;
}
async function newAccount(): Promise<string> {
  const before = new Set((await getAppData("2026-10-30")).accounts.map((item) => item.id));
  await createAccount({ name: "Synthetic notification account", type: "checking", balanceCents: 100_000 });
  return (await getAppData("2026-10-30")).accounts.find((item) => !before.has(item.id))!.id;
}
function balance(accountId: string): number {
  return Number(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents);
}

describe("optional reviewed Android notification adapter", () => {
  it("accepts only bounded reviewed facts and never promotes delivery IDs to bank identities", () => {
    const valid = event(crypto.randomUUID());
    const parsed = parseAndroidNotification(valid);
    expect(normalizeAndroidNotification(parsed)).toEqual({ occurredOn: valid.date, amountCents: -1234, currency: "EUR", kind: "expense", status: "cleared", description: "Android notification expense", auditMetadata: { adapter: "android_notification", schemaVersion: "1" } });
    for (const bad of [
      { ...valid, text: "RAW_NOTIFICATION_SENTINEL" }, { ...valid, merchant: "RAW_MERCHANT" }, { ...valid, externalId: "bank-id" },
      { ...valid, eventId: "raw-system-notification-key" }, { ...valid, date: "2026-02-30" }, { ...valid, schemaVersion: 2 },
      { ...valid, currency: "USD" }, { ...valid, currency: null }, { ...valid, amountCents: 1.5 }, { ...valid, amountCents: 0 },
      { ...valid, amountCents: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, kind: "refund" }, { ...valid, kind: "transfer" },
    ]) expect(() => parseAndroidNotification(bad)).toThrow();
    expect(parseAndroidNotification({ ...valid, kind: "refund", amountCents: 1234 }).kind).toBe("refund");
  });

  it("rejects direct canonical notification writes without bound delivery identity", async () => {
    await expect(ingestTransactions({ accountId: crypto.randomUUID(), source: "android_notification", filename: "Android notification", transactions: [{ occurredOn: "2026-10-30", amountCents: -100, description: "Synthetic" }] })).rejects.toMatchObject({ status: 400 });
  });

  it("is off by default, with authentication and origin guards still preceding the gate", async () => {
    const source = event(await account());
    for (const path of ["preview", "confirm"]) {
      expect((await request(path, { event: source, confirmed: true })).status).toBe(503);
      expect((await request(path, {}, {}, null)).status).toBe(401);
      expect((await request(path, {}, {}, "outsider")).status).toBe(403);
      expect((await request(path, {}, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await request(path, {}, { "X-BudgetApp-Request": "" })).status).toBe(403);
    }
    expect(balance(source.accountId)).toBe(100_000);
    enabled = true;
  });

  it("previews without writes and requires explicit confirmation before one cleared mutation", async () => {
    const source = event(await newAccount());
    const preview = await request("preview", { event: source });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ event: source, transaction: { description: "Android notification expense" } });
    expect(balance(source.accountId)).toBe(100_000);
    for (const confirmed of [undefined, false, "true", 1]) expect((await request("confirm", { event: source, confirmed })).status).toBe(400);
    expect((await request("confirm", { event: source, confirmed: true, raw: "RAW_SENTINEL" })).status).toBe(400);
    expect(balance(source.accountId)).toBe(100_000);
    const first = await request("confirm", { event: source, confirmed: true });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ importedCount: 1, replayed: false });
    expect(balance(source.accountId)).toBe(98_766);
    const repeated = await request("confirm", { event: source, confirmed: true });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ importedCount: 1, replayed: true });
    expect(balance(source.accountId)).toBe(98_766);
    expect((await request("confirm", { event: { ...source, amountCents: -4321 }, confirmed: true })).status).toBe(409);
    const otherAccount = await newAccount();
    expect((await request("confirm", { event: { ...source, accountId: otherAccount }, confirmed: true })).status).toBe(409);
    expect(balance(otherAccount)).toBe(100_000);
    const page = await listTransactions({ source: "android_notification", limit: 50 });
    expect(page.items).toContainEqual(expect.objectContaining({ accountId: source.accountId, activitySource: "android_notification", amountCents: -1234 }));
    const backup = JSON.stringify(await exportBackup());
    expect(backup).toContain('"source":"android_notification"');
    expect(backup).not.toContain(source.eventId);
    expect(backup).not.toContain("request_fingerprint");
  });

  it("applies concurrent exact delivery retries once", async () => {
    const source = event(await newAccount());
    const responses = await Promise.all([request("confirm", { event: source, confirmed: true }), request("confirm", { event: source, confirmed: true })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(balance(source.accountId)).toBe(98_766);
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?").get(source.accountId)).toMatchObject({ count: 1 });
  });

  it("replays a committed delivery after its account is archived without accepting new writes", async () => {
    const id = await newAccount();
    const source = event(id);
    const confirmed = await request("confirm", { event: source, confirmed: true });
    expect(confirmed.status).toBe(201);
    const { importId } = await confirmed.json();
    database.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(id);

    const replay = await request("confirm", { event: source, confirmed: true });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ importId, importedCount: 1, replayed: true });
    expect((await request("confirm", { event: { ...source, amountCents: -5678 }, confirmed: true })).status).toBe(409);
    expect((await request("confirm", { event: event(id, { amountCents: -5678 }), confirmed: true })).status).toBe(400);
    expect(balance(id)).toBe(98_766);
    expect(database.prepare("SELECT COUNT(*) AS count FROM imports WHERE account_id = ?").get(id)).toMatchObject({ count: 1 });
  });

  it("rolls back an otherwise valid delivery if the account is archived immediately before the write batch", async () => {
    const id = await newAccount();
    const source = event(id);
    const batch = sqlite.batch;
    const archiveBeforeWrite = vi.spyOn(sqlite, "batch").mockImplementationOnce(async (statements) => {
      database.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(id);
      await batch(statements);
    });
    try {
      const result = await request("confirm", { event: source, confirmed: true });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: "Choose an active account" });
      expect(archiveBeforeWrite).toHaveBeenCalledOnce();
      expect(balance(id)).toBe(100_000);
      expect(database.prepare("SELECT COUNT(*) AS count FROM imports WHERE account_id = ?").get(id)).toMatchObject({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?").get(id)).toMatchObject({ count: 0 });
    } finally {
      archiveBeforeWrite.mockRestore();
    }
  });

  it("does not propose an Android refund as an incoming transfer leg", async () => {
    const refundAccount = await newAccount();
    const otherAccount = await newAccount();
    const amountCents = 24_681;
    await ingestTransactions({
      accountId: otherAccount, source: "csv", filename: "synthetic.csv",
      transactions: [{ occurredOn: "2026-10-30", amountCents: -amountCents, description: "Synthetic expense" }],
    });
    expect((await request("confirm", { event: event(refundAccount, { amountCents, kind: "refund" }), confirmed: true })).status).toBe(201);
    expect(balance(refundAccount)).toBe(124_681);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM ingested_transfer_candidates c
      JOIN transactions t ON t.id = c.incoming_transaction_id WHERE t.account_id = ?`).get(refundAccount)).toMatchObject({ count: 0 });
  });

  it("blocks possible cross-source duplicates in both directions despite different descriptions and bank IDs", async () => {
    const csvFirst = await newAccount();
    await ingestTransactions({ accountId: csvFirst, source: "csv", filename: "synthetic.csv", transactions: [{ occurredOn: "2026-10-29", amountCents: -1234, description: "Synthetic statement purchase", externalId: "synthetic-bank-1" }] });
    const response = await request("confirm", { event: event(csvFirst), confirmed: true });
    expect(response.status).toBe(409);
    expect(balance(csvFirst)).toBe(98_766);
    const notificationFirst = await newAccount();
    const source = event(notificationFirst);
    expect((await request("confirm", { event: source, confirmed: true })).status).toBe(201);
    await expect(ingestTransactions({ accountId: notificationFirst, source: "xlsx", filename: "synthetic.xlsx", transactions: [{ occurredOn: "2026-11-01", amountCents: -1234, description: "Synthetic other description", externalId: "synthetic-bank-2" }] })).rejects.toMatchObject({ status: 409 });
    expect(balance(notificationFirst)).toBe(98_766);
    const history = database.prepare("SELECT error_code FROM ingestion_items WHERE error_code = 'notification_overlap'").all();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect((await request("confirm", { event: { ...source, eventId: crypto.randomUUID() }, confirmed: true })).status).toBe(409);
    expect(balance(notificationFirst)).toBe(98_766);
  });

  it("database guard closes cross-adapter races and disabling stops later deliveries", async () => {
    const id = await newAccount();
    expect((await request("confirm", { event: event(id), confirmed: true })).status).toBe(201);
    expect(() => database.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, description, kind, status, source, created_at, updated_at)
      VALUES (?, ?, '2026-10-31', -1234, 'Synthetic racing statement', 'expense', 'cleared', 'import', '', '')`).run(crypto.randomUUID(), id)).toThrow("Possible notification overlap");
    const reverseId = await newAccount();
    await ingestTransactions({ accountId: reverseId, source: "csv", filename: "synthetic.csv", transactions: [{ occurredOn: "2026-10-30", amountCents: -555, description: "Synthetic", externalId: "synthetic-race-3" }] });
    expect(() => database.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, description, kind, status, source, raw_metadata, created_at, updated_at)
      VALUES (?, ?, '2026-10-30', -555, 'Android notification expense', 'expense', 'cleared', 'import', '{"adapter":"android_notification"}', '', '')`).run(crypto.randomUUID(), reverseId)).toThrow("Possible notification overlap");
    enabled = false;
    expect((await request("confirm", { event: event(id, { amountCents: -999 }), confirmed: true })).status).toBe(503);
    expect(balance(id)).toBe(98_766);
    enabled = true;
  });

  it("rejects oversized/raw/malformed payloads and inactive accounts without changes", async () => {
    const id = await newAccount();
    const source = event(id);
    expect((await request("preview", { event: source, text: "x".repeat(2100) })).status).toBe(413);
    expect((await request("preview", { event: source }, { "Content-Type": "text/plain" })).status).toBe(415);
    const raw = await request("confirm", { event: { ...source, text: "RAW_NOTIFICATION_SENTINEL" }, confirmed: true });
    expect(raw.status).toBe(400);
    expect(await raw.text()).not.toContain("RAW_NOTIFICATION_SENTINEL");
    database.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(id);
    expect((await request("preview", { event: source })).status).toBe(400);
    expect(balance(id)).toBe(100_000);
  });
});
