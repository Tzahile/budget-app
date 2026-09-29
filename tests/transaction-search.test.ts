import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import { createAccount, ingestTransactions, listTransactions } from "../server/repository.ts";
import { parseTransactionFilters } from "../server/transaction-search.ts";

let database: DatabaseSync;
let accountId: string;

beforeAll(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  await createAccount({ name: "Synthetic search account", type: "checking", balanceCents: 0 });
  accountId = String((database.prepare("SELECT id FROM accounts WHERE name = ?").get("Synthetic search account") as { id: string }).id);
  const insert = database.prepare(`INSERT INTO transactions
    (id, account_id, date, amount_cents, currency, description, kind, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'EUR', ?, 'expense', 'cleared', 'manual', ?, ?)`);
  for (let i = 0; i < 505; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    insert.run(id, accountId, "2026-09-28", -100, `Synthetic coffee ${i}`, "2026-09-28T10:00:00.000Z", "2026-09-28T10:00:00.000Z");
  }
});
afterAll(() => database.close());

describe("server-backed transaction search", () => {
  it("pages past 500 records with no overlap or omission on identical dates and timestamps", async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTransactions({ limit: 100, cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(505);
    expect(new Set(ids).size).toBe(505);
    expect(ids[0]).toBe("00000000-0000-4000-8000-000000000504");
    expect(ids.at(-1)).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("filters account, dates, kind, literal substring, and CSV versus bank provenance", async () => {
    await ingestTransactions({ accountId, filename: "synthetic.csv", source: "csv", transactions: [
      { occurredOn: "2026-09-29", amountCents: -230, description: "Synthetic CSV 100%", externalId: "csv-search" },
    ] });
    await ingestTransactions({ accountId, filename: "synthetic bank", source: "open_banking", transactions: [
      { occurredOn: "2026-09-30", amountCents: 500, description: "Synthetic bank credit", externalId: "bank-search" },
    ] });
    expect((await listTransactions({ limit: 50, accountId, from: "2026-09-29", to: "2026-09-29", kind: "expense", source: "csv", search: "100%" })).items.map((item) => item.activitySource)).toEqual(["csv"]);
    expect((await listTransactions({ limit: 50, source: "open_banking" })).items.map((item) => item.description)).toEqual(["Synthetic bank credit"]);
    expect((await listTransactions({ limit: 50, source: "planned" })).items).toEqual([]);
  });

  it("rejects malformed filters and cursors", async () => {
    for (const query of ["limit=0", "limit=101", "limit=4.2", "from=2026-02-30", "from=2026-09-30&to=2026-09-01", "source=import", "kind=bogus", "accountId=x", "search=" + "x".repeat(161), "kind=income&kind=expense", "other=x"]) {
      expect(() => parseTransactionFilters(new URLSearchParams(query)), query).toThrow();
    }
    await expect(listTransactions({ limit: 10, cursor: "broken" })).rejects.toThrow("cursor is invalid");
  });
});
