import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import { BACKUP_TABLES, type BudgetBackup } from "../server/backup.ts";

let database: DatabaseSync;
let handler: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  Object.assign(globalThis, { Deno: { env: { get: () => "" } } });
  ({ default: handler } = await import("../index.http.ts"));
  await request("/api/data");
  database.exec(`
    INSERT INTO accounts (id, name, type, balance_cents, created_at, updated_at)
      VALUES ('a', 'Synthetic account', 'checking', 1200, '2026-09-01', '2026-09-01');
    INSERT INTO planned_transactions (id, account_id, description, kind, amount_cents, recurrence, next_date, created_at, updated_at)
      VALUES ('p', 'a', 'Synthetic bill', 'expense', 300, 'monthly', '2026-10-01', '2026-09-01', '2026-09-01');
    INSERT INTO transactions (id, account_id, date, amount_cents, description, kind, status, source, created_at, updated_at, raw_metadata)
      VALUES ('t1', 'a', '2026-09-01', -300, 'Synthetic transfer out', 'expense', 'cleared', 'import', '2026-09-01', '2026-09-01', '{"access_token":"synthetic-secret-never-export"}');
    INSERT INTO transactions (id, account_id, date, amount_cents, description, kind, status, source, created_at, updated_at)
      VALUES ('t2', 'a', '2026-09-01', 300, 'Synthetic transfer in', 'income', 'cleared', 'import', '2026-09-01', '2026-09-01');
    INSERT INTO reserves (id, name, amount_cents, created_at, updated_at)
      VALUES ('r', 'Synthetic goal', 100, '2026-09-01', '2026-09-01');
    INSERT INTO planned_completions (id, planned_transaction_id, transaction_id, occurrence_date,
      previous_next_date, previous_is_active, completed_next_date, completed_is_active,
      completed_revision, status, created_at)
      VALUES ('pc', 'p', 't1', '2026-09-01', '2026-09-01', 1, '2026-10-01', 1, 1, 'completed', '2026-09-01');
    INSERT INTO account_reconciliations (id, account_id, date, previous_balance_cents,
      actual_balance_cents, difference_cents, created_at)
      VALUES ('ar', 'a', '2026-09-01', 900, 1200, 300, '2026-09-01');
    INSERT INTO imports (id, filename, status, row_count, imported_count, duplicate_count,
      created_at, completed_at, account_id, retry_key)
      VALUES ('i', 'synthetic.csv', 'completed', 2, 2, 0, '2026-09-01', '2026-09-01', 'a', 'synthetic-retry-secret-never-export');
    INSERT INTO ingestion_items (id, import_id, source_position, status, transaction_id, created_at)
      VALUES ('ii', 'i', 1, 'accepted', 't1', '2026-09-01');
    INSERT INTO ingested_transfer_candidates (id, outgoing_transaction_id, incoming_transaction_id, created_at)
      VALUES ('tc', 't1', 't2', '2026-09-01');
    INSERT INTO app_metadata (key, value, updated_at)
      VALUES ('provider_token', 'synthetic-app-secret-never-export', '2026-09-01');
    INSERT INTO csv_mapping_profiles (id, name, mapping_json, created_at, updated_at)
      VALUES ('csv-profile', 'Synthetic mapping', '{"date":"Date","amount":"Amount","description":"Description"}', '2026-09-01', '2026-09-01');
  `);
  const insert = database.prepare(`INSERT INTO transactions
    (id, account_id, date, amount_cents, description, kind, status, source, created_at, updated_at)
    VALUES (?, 'a', '2026-09-01', -1, 'Synthetic historical row', 'expense', 'cleared', 'manual', '2026-09-01', '2026-09-01')`);
  for (let i = 0; i < 501; i++) insert.run(`historical-${i}`);
});

afterAll(() => database.close());

function request(path: string, user: string | null = "tzahile"): Promise<Response> {
  const headers = new Headers();
  if (user) headers.set("X-Test-User", user);
  return Promise.resolve(handler(new Request(`https://budget.example${path}`, { headers })));
}

describe("authenticated portable backup", () => {
  it("denies unauthenticated and unallowlisted downloads", async () => {
    expect((await request("/api/export", null)).status).toBe(401);
    expect((await request("/api/export", "outsider")).status).toBe(403);
  });

  it("exports all canonical and audit rows without pagination or secrets", async () => {
    const response = await request("/api/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="budgetapp-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const serialized = await response.text();
    const backup = JSON.parse(serialized) as BudgetBackup;
    expect(backup).toMatchObject({ format: "budgetapp-backup", formatVersion: 3, schemaVersion: 12 });
    expect(Number.isNaN(Date.parse(backup.exportedAt))).toBe(false);
    expect(Object.keys(backup.data).sort()).toEqual(Object.keys(BACKUP_TABLES).sort());
    expect(backup.data.transactions).toHaveLength(503);
    for (const [table, id] of Object.entries({
      accounts: "a", planned_transactions: "p", transactions: "t1", reserves: "r",
      planned_completions: "pc", account_reconciliations: "ar", imports: "i",
      ingestion_items: "ii", ingested_transfer_candidates: "tc", csv_mapping_profiles: "csv-profile",
    })) expect(backup.data[table as keyof typeof backup.data]).toContainEqual(expect.objectContaining({ id }));
    expect(backup.data.accounts[0]).toMatchObject({ balance_cents: 1200 });
    expect(backup.data.imports[0]).toMatchObject({ row_count: 2, account_id: "a" });
    expect(backup.data.ingestion_items[0]).toMatchObject({ import_id: "i", transaction_id: "t1" });
    expect(serialized).not.toContain("synthetic-secret-never-export");
    expect(serialized).not.toContain("synthetic-retry-secret-never-export");
    expect(serialized).not.toContain("synthetic-app-secret-never-export");
    expect(serialized).not.toContain("raw_metadata");
    expect(serialized).not.toContain("app_metadata");
  });

  it("fails closed when new schema data has not been reviewed for portability", async () => {
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (13, '2026-09-01')").run();
    const response = await request("/api/export");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unexpected server error" });
  });
});
