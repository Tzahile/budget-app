import { DatabaseSync } from "node:sqlite";
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
});
