import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectIngestedTransferPairs, INGESTED_TRANSFER_DATE_TOLERANCE_DAYS } from "../server/ingested-transfers.ts";
import { createAccount, decideIngestedTransferCandidate, getAppData, ingestTransactions } from "../server/repository.ts";
import { useTestSqlite } from "./support/val-sqlite.ts";

let database: DatabaseSync;

beforeAll(() => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
});

afterAll(() => database.close());

describe("ingested internal transfer detection", () => {
  it("matches only equal opposite amounts in distinct accounts within the documented tolerance", () => {
    const debit = { id: "debit", accountId: "checking", occurredOn: "2026-09-10", amountCents: -25_000 };
    const inputs = [
      debit,
      { id: "match", accountId: "savings", occurredOn: "2026-09-13", amountCents: 25_000 },
      { id: "too-late", accountId: "savings", occurredOn: "2026-09-14", amountCents: 25_000 },
      { id: "wrong-amount", accountId: "savings", occurredOn: "2026-09-10", amountCents: 24_999 },
      { id: "same-account", accountId: "checking", occurredOn: "2026-09-10", amountCents: 25_000 },
      { id: "same-direction", accountId: "savings", occurredOn: "2026-09-10", amountCents: -26_000 },
    ];
    expect(INGESTED_TRANSFER_DATE_TOLERANCE_DAYS).toBe(3);
    expect(detectIngestedTransferPairs(inputs)).toEqual([
      { outgoingTransactionId: "debit", incomingTransactionId: "match" },
    ]);
  });

  it("keeps candidates in reporting until confirmation, then groups existing legs without changing balances", async () => {
    await createAccount({ name: "Synthetic checking", type: "checking", balanceCents: 100_000 });
    await createAccount({ name: "Synthetic savings", type: "savings", balanceCents: 50_000 });
    let data = await getAppData("2026-09-30");
    const checking = data.accounts.find((account) => account.name === "Synthetic checking")!;
    const savings = data.accounts.find((account) => account.name === "Synthetic savings")!;

    const outgoing = [{ occurredOn: "2026-09-10", amountCents: -25_000, description: "Synthetic outgoing", externalId: "out-1" }];
    const incoming = [{ occurredOn: "2026-09-12", amountCents: 25_000, description: "Synthetic incoming", externalId: "in-1" }];
    await ingestTransactions({ accountId: checking.id, filename: "out.csv", source: "csv", transactions: outgoing });
    await ingestTransactions({ accountId: savings.id, filename: "in.csv", source: "csv", transactions: incoming });
    data = await getAppData("2026-09-30");
    expect(data.ingestedTransferCandidates).toHaveLength(1);
    expect(data.ingestedTransferCandidates[0].status).toBe("pending");
    expect(data.dashboard.spentThisMonthCents).toBe(25_000);
    expect(data.accounts.reduce((sum, account) => sum + account.balanceCents, 0)).toBe(150_000);

    await decideIngestedTransferCandidate(data.ingestedTransferCandidates[0].id, "defer");
    data = await getAppData("2026-09-30");
    expect(data.ingestedTransferCandidates[0].status).toBe("deferred");
    expect(data.dashboard.spentThisMonthCents).toBe(25_000);

    await decideIngestedTransferCandidate(data.ingestedTransferCandidates[0].id, "confirm");
    data = await getAppData("2026-09-30");
    const legs = data.transactions.filter((transaction) => transaction.description.startsWith("Synthetic "));
    expect(data.ingestedTransferCandidates[0]).toMatchObject({ status: "confirmed", transferGroupId: expect.any(String) });
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((transaction) => transaction.transferGroupId)).size).toBe(1);
    expect(legs.every((transaction) => transaction.kind === "transfer")).toBe(true);
    expect(data.dashboard.spentThisMonthCents).toBe(0);
    expect(data.accounts.reduce((sum, account) => sum + account.balanceCents, 0)).toBe(150_000);

    const repeated = await ingestTransactions({ accountId: savings.id, filename: "in-again.csv", source: "csv", transactions: incoming });
    expect(repeated).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    expect((await getAppData("2026-09-30")).ingestedTransferCandidates).toHaveLength(1);
  });

  it("persists rejection so repeated ingestion does not recreate the candidate", async () => {
    await createAccount({ name: "Synthetic A", type: "checking", balanceCents: 0 });
    await createAccount({ name: "Synthetic B", type: "savings", balanceCents: 0 });
    const rejectionAccounts = (await getAppData("2026-09-30")).accounts.filter((account) => account.name === "Synthetic A" || account.name === "Synthetic B");
    const a = rejectionAccounts.find((account) => account.name === "Synthetic A")!;
    const b = rejectionAccounts.find((account) => account.name === "Synthetic B")!;
    const debit = [{ occurredOn: "2026-09-20", amountCents: -10_000, description: "Not transfer debit", externalId: "reject-out" }];
    const credit = [{ occurredOn: "2026-09-20", amountCents: 10_000, description: "Not transfer credit", externalId: "reject-in" }];
    await ingestTransactions({ accountId: a.id, filename: "a.csv", source: "csv", transactions: debit });
    await ingestTransactions({ accountId: b.id, filename: "b.csv", source: "csv", transactions: credit });
    let data = await getAppData("2026-09-30");
    const candidateId = data.ingestedTransferCandidates.find((candidate) => candidate.status === "pending")!.id;
    await decideIngestedTransferCandidate(candidateId, "reject");
    await ingestTransactions({ accountId: b.id, filename: "b-repeat.csv", source: "csv", transactions: credit });
    data = await getAppData("2026-09-30");
    const rejected = data.ingestedTransferCandidates.find((candidate) => candidate.id === candidateId);
    expect(data.ingestedTransferCandidates.filter((candidate) => candidate.status === "rejected")).toHaveLength(1);
    expect(rejected).toMatchObject({ status: "rejected", transferGroupId: null });
    expect(data.transactions.filter((transaction) => transaction.description.startsWith("Not transfer") && transaction.kind === "transfer")).toHaveLength(0);
  });
});
