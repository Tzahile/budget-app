import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite, useTestSqlite } from "./support/val-sqlite.ts";
import { db } from "../server/db.ts";
import { migrateDatabase } from "../server/migrations.ts";
import {
  applyBankConnectionSnapshot, confirmBankAccountMapping, decideIngestedTransferCandidate, ingestTransactions,
  consumeBankConsentAttempt, createAccount, createBankConnection, createBankConsentAttempt, createLinkedBankAccount,
  getAppData, hashBankConsentState, ingestBankAccountTransactions, linkBankAccount,
  listBankConnections, markBankConnection,
} from "../server/repository.ts";

let database: DatabaseSync;
beforeEach(async () => {
  database = new DatabaseSync(":memory:");
  useTestSqlite(database);
  await migrateDatabase(sqlite);
});
afterEach(() => database.close());

describe("bank sync storage and canonical ingestion", () => {
  it("claims consent state once, bound to owner, callback URI and expiry", async () => {
    const stateHash = await hashBankConsentState("synthetic-state");
    await createBankConsentAttempt({
      stateHash, ownerUsername: "owner", provider: "synthetic", institutionId: "it-bank",
      institutionName: "Synthetic Bank", providerRequisitionId: "requisition-1",
      redirectUri: "https://example.test/callback", expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(await consumeBankConsentAttempt({ stateHash, ownerUsername: "other", redirectUri: "https://example.test/callback" })).toBeNull();
    expect(await consumeBankConsentAttempt({ stateHash, ownerUsername: "owner", redirectUri: "https://example.test/other" })).toBeNull();
    expect(await consumeBankConsentAttempt({ stateHash, ownerUsername: "owner", redirectUri: "https://example.test/callback" }))
      .toMatchObject({ providerRequisitionId: "requisition-1", institutionId: "it-bank" });
    expect(await consumeBankConsentAttempt({ stateHash, ownerUsername: "owner", redirectUri: "https://example.test/callback" })).toBeNull();
    const record = database.prepare("SELECT state_hash, consumed_at FROM bank_consent_attempts").get() as Record<string, unknown>;
    expect(record.state_hash).toBe(stateHash);
    expect(record.consumed_at).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain("synthetic-state");
  });

  it("ingests, deduplicates and reconciles a linked account in a single run", async () => {
    await createAccount({ name: "Synthetic bank account", type: "checking", balanceCents: 0 });
    const accountId = (await getAppData()).accounts.find((account) => account.name === "Synthetic bank account")!.id;
    const connectionId = await createBankConnection({
      provider: "synthetic", providerConnectionId: "connection-1", institutionId: "it-bank",
      institutionName: "Synthetic Bank", countryCode: "IT",
    });
    await linkBankAccount({ connectionId, accountId, providerAccountId: "provider-account-1" });
    // The synthetic manually maintained account is already owner-mapped.
    database.prepare("INSERT INTO bank_account_identities (provider, institution_id, identity_hash, account_id) VALUES (?, ?, ?, ?)")
      .run("synthetic", "it-bank", "0".repeat(64), accountId);
    const transaction = { occurredOn: "2026-09-20", amountCents: 1250, description: "Synthetic transfer", externalId: "stable-1" };
    const first = await ingestBankAccountTransactions({
      connectionId, accountId, provider: "synthetic", transactions: [transaction], balanceCents: 5_000,
    });
    expect(first).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 5_000 });
    expect(database.prepare("SELECT difference_cents FROM account_reconciliations WHERE account_id = ?").get(accountId))
      .toMatchObject({ difference_cents: 3_750 });
    const second = await ingestBankAccountTransactions({
      connectionId, accountId, provider: "synthetic", transactions: [transaction], balanceCents: 5_000,
    });
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_reconciliations WHERE account_id = ?").get(accountId))
      .toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?").get(accountId))
      .toMatchObject({ count: 1 });
    expect((await listBankConnections())[0]).toMatchObject({
      id: connectionId, status: "connected", accounts: [{ accountId }],
    });

    await expect(ingestBankAccountTransactions({
      connectionId, accountId, provider: "other", transactions: [transaction], balanceCents: 7_000,
    })).rejects.toMatchObject({ status: 409 });
    await markBankConnection(connectionId, "reauth_required", "consent_expired");
    await expect(ingestBankAccountTransactions({
      connectionId, accountId, provider: "synthetic", transactions: [transaction], balanceCents: 7_000,
    })).rejects.toMatchObject({ status: 409 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 5_000 });
  });

  it("creates a zero-balance linked account once for a provider account ID", async () => {
    const connectionId = await createBankConnection({
      provider: "synthetic", providerConnectionId: "connection-2", institutionId: "it-bank",
      institutionName: "Synthetic Bank", countryCode: "IT",
    });
    const input = { connectionId, providerAccountId: "provider-account-2", name: "Synthetic linked", identityHash: "a".repeat(64) };
    const accountId = await createLinkedBankAccount(input);
    expect(await createLinkedBankAccount(input)).toBe(accountId);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts WHERE name = ?").get(input.name)).toMatchObject({ count: 1 });
    expect(JSON.stringify(await listBankConnections())).not.toContain("connection-2");
  });

  it("promotes a stable pending ID to booked and applies only the cleared delta", async () => {
    const connectionId = await createBankConnection({
      provider: "synthetic", providerConnectionId: "connection-revision", institutionId: "it-bank",
      institutionName: "Synthetic Bank", countryCode: "IT",
    });
    const accountId = await createLinkedBankAccount({ connectionId, providerAccountId: "revision-account", name: "Revision test", identityHash: "b".repeat(64) });
    const pending = { occurredOn: "2026-09-20", amountCents: -750, description: "Pending synthetic", externalId: "stable-revision", status: "pending" as const };
    await ingestBankAccountTransactions({ connectionId, accountId, provider: "synthetic", transactions: [pending] });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: 0 });
    const booked = { ...pending, occurredOn: "2026-09-21", description: "Booked synthetic", status: "cleared" as const };
    const result = await ingestBankAccountTransactions({ connectionId, accountId, provider: "synthetic", transactions: [booked] });
    expect(database.prepare("SELECT updated_count FROM imports WHERE id = ?").get(result.importId)).toMatchObject({ updated_count: 1 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: -750 });
    expect(database.prepare("SELECT COUNT(*) AS count, status, date FROM transactions WHERE account_id = ?").get(accountId))
      .toMatchObject({ count: 1, status: "cleared", date: "2026-09-21" });
    await ingestBankAccountTransactions({ connectionId, accountId, provider: "synthetic", transactions: [booked] });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)).toMatchObject({ balance_cents: -750 });
  });
});

describe("bank snapshot accounting conflicts", () => {
  async function mappedStatementAccount(accountName: string) {
    await createAccount({ name: accountName, type: "checking", balanceCents: 0 });
    const accountId = String(database.prepare("SELECT id FROM accounts WHERE name = ?").get(accountName)!.id);
    const connectionId = await createBankConnection({ provider: "synthetic", providerConnectionId: "statement-sync",
      institutionId: "it-bank", institutionName: "Synthetic", countryCode: "IT" });
    const account = { providerAccountId: "statement-account", identityHash: "1".repeat(64), name: "Synthetic",
      coverageFrom: "2026-09-01", coverageThrough: "2026-09-30", balanceCents: 1000 };
    await confirmBankAccountMapping({ connectionId, providerAccountId: account.providerAccountId,
      identityHash: account.identityHash, accountId });
    return { accountId, connectionId, account };
  }

  it.each(["csv", "xlsx"] as const)("rejects overlapping %s history without shared IDs", async (source) => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic statement");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Statement description" };
    await ingestTransactions({ accountId, source, filename: "Synthetic statement", transactions: [booking] });
    await expect(applyBankConnectionSnapshot({
      connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [{ ...booking, description: "Bank description", externalId: "bank-id" }] }],
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps"), importId: expect.any(String) });
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(1);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(-400);
    expect(database.prepare("SELECT COUNT(*) AS n FROM bank_account_sync_coverage").get()!.n).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS n FROM account_reconciliations").get()!.n).toBe(0);
  });

  it("keeps shared statement IDs deduplicated alongside new bank entries and on repeat sync", async () => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic reconciled statement");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Shared entry", externalId: "shared-id" };
    await ingestTransactions({ accountId, source: "csv", filename: "Synthetic statement", transactions: [booking] });
    const snapshot = { connectionId, provider: "synthetic", expectedRevision: 1, accounts: [{ ...account,
      transactions: [booking, { ...booking, amountCents: -800, description: "Additional booking", externalId: "additional-id" }] }] };
    expect(await applyBankConnectionSnapshot(snapshot)).toMatchObject({ importedCount: 1, duplicateCount: 1 });
    expect(await applyBankConnectionSnapshot({ ...snapshot, expectedRevision: 2 })).toMatchObject({ importedCount: 0, duplicateCount: 2 });
    await expect(ingestTransactions({ accountId, source: "xlsx", filename: "Synthetic statement",
      transactions: [{ ...booking, amountCents: -401 }] }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps") });
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(2);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
  });

  it.each([false, true])("rolls back a staged bank sync after a concurrent statement (shared ID %s)", async (sharedId) => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic statement race");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Concurrent statement booking", ...(sharedId ? { externalId: "bank-id" } : {}) };
    const snapshot = { connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [sharedId ? booking : { ...booking, occurredOn: "2026-09-21", externalId: "bank-id" }] }] };
    const batch = db.batch.bind(db);
    const concurrentImport = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await ingestTransactions({ accountId, source: "csv", filename: "Synthetic statement", transactions: [booking] });
      return await batch(statements);
    });
    try {
      await expect(applyBankConnectionSnapshot(snapshot))
        .rejects.toMatchObject({ status: 409, importId: expect.any(String) });
    } finally {
      concurrentImport.mockRestore();
    }
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(1);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(-400);
    expect(database.prepare("SELECT sync_revision FROM bank_connections WHERE id = ?").get(connectionId)!.sync_revision).toBe(1);
    if (sharedId) {
      expect(await applyBankConnectionSnapshot(snapshot)).toMatchObject({ importedCount: 0, duplicateCount: 1 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(1);
      expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
    }
  });

  it.each(["csv", "xlsx"] as const)("checks %s bookings against committed bank coverage", async (source) => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic bank-first account");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Shared entry", externalId: "bank-id" };
    await applyBankConnectionSnapshot({ connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [booking] }] });
    const importInput = { accountId, source, filename: "Synthetic statement" };
    const older = { ...booking, occurredOn: "2026-08-30", amountCents: 100, externalId: "older-id" };

    await expect(ingestTransactions({ ...importInput, transactions: [
      older, { occurredOn: "2026-09-21", amountCents: -401, description: "Unidentified statement entry" },
    ] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps") });
    await expect(ingestTransactions({ ...importInput, transactions: [{ ...booking, amountCents: -401 }] }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps") });
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(1);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
    expect(await ingestTransactions({ ...importInput, transactions: [booking] }))
      .toMatchObject({ importedCount: 0, duplicateCount: 1 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
  });

  it.each([false, true])("rejects a staged statement after a concurrent bank commit (shared ID %s)", async (sharedId) => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic bank-first race");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Concurrent bank booking", externalId: "bank-id" };
    const statement = sharedId ? booking : { ...booking, occurredOn: "2026-09-21", externalId: "statement-id" };
    const snapshot = { connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [booking] }] };
    const batch = db.batch.bind(db);
    const concurrentSync = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await applyBankConnectionSnapshot(snapshot);
      return await batch(statements);
    });
    const importInput = { accountId, source: "xlsx" as const, filename: "Synthetic statement", transactions: [statement] };
    try {
      await expect(ingestTransactions(importInput))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps") });
    } finally {
      concurrentSync.mockRestore();
    }
    if (sharedId) {
      expect(await ingestTransactions(importInput)).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    }
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(accountId)!.n).toBe(1);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
    expect(database.prepare("SELECT sync_revision FROM bank_connections WHERE id = ?").get(connectionId)!.sync_revision).toBe(2);
  });

  it.each(["date", "amount"] as const)("rejects a booked bank %s correction over unresolved statement history", async (change) => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic bank revision overlap");
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Original bank booking", externalId: "bank-id" };
    await applyBankConnectionSnapshot({ connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [booking] }] });
    await ingestTransactions({ accountId, source: "csv", filename: "Synthetic statement",
      transactions: [{ occurredOn: "2026-10-01", amountCents: -500, description: "Unresolved statement booking" }] });
    const correction = change === "date" ? { ...booking, occurredOn: "2026-10-01" } : { ...booking, amountCents: -500 };
    await expect(applyBankConnectionSnapshot({ connectionId, provider: "synthetic", expectedRevision: 2,
      accounts: [{ ...account, coverageThrough: "2026-10-02", balanceCents: 900, transactions: [correction] }] }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("overlaps"), importId: expect.any(String) });
    expect(database.prepare("SELECT date, amount_cents FROM transactions WHERE external_id = 'bank-id'").get())
      .toEqual({ date: "2026-09-20", amount_cents: -400 });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(500);
    expect(database.prepare("SELECT last_date FROM bank_account_sync_coverage WHERE account_id = ?").get(accountId)!.last_date)
      .toBe("2026-09-30");
    expect(database.prepare("SELECT sync_revision FROM bank_connections WHERE id = ?").get(connectionId)!.sync_revision).toBe(2);
  });

  it("rejects transfer confirmation when a bank date correction leaves the matching window", async () => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic stale transfer");
    await createAccount({ name: "Synthetic receiving cash", type: "cash", balanceCents: 0 });
    const receiver = String(database.prepare("SELECT id FROM accounts WHERE type = 'cash'").get()!.id);
    const booking = { occurredOn: "2026-09-20", amountCents: -400, description: "Outgoing transaction", externalId: "bank-id" };
    const snapshot = { connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [booking] }] };
    await applyBankConnectionSnapshot(snapshot);
    await ingestTransactions({ accountId: receiver, source: "xlsx", filename: "Synthetic statement",
      transactions: [{ ...booking, amountCents: 400, externalId: "incoming-id" }] });
    const candidateId = String(database.prepare("SELECT id FROM ingested_transfer_candidates").get()!.id);
    await applyBankConnectionSnapshot({ ...snapshot, expectedRevision: 2,
      accounts: [{ ...account, transactions: [{ ...booking, occurredOn: "2026-09-24" }] }] });

    await expect(decideIngestedTransferCandidate(candidateId, "confirm")).rejects.toMatchObject({ status: 409 });
    expect(database.prepare("SELECT status FROM ingested_transfer_candidates WHERE id = ?").get(candidateId)!.status).toBe("pending");
    expect(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE transfer_group_id IS NOT NULL").get()!.n).toBe(0);
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
  });

  it("rolls back a bank update when the owner confirms its transfer after staging", async () => {
    const { accountId, connectionId, account } = await mappedStatementAccount("Synthetic sending account");
    await createAccount({ name: "Synthetic receiving account", type: "cash", balanceCents: 0 });
    const receiver = String(database.prepare("SELECT id FROM accounts WHERE type = 'cash'").get()!.id);
    const payment = { occurredOn: "2026-09-20", amountCents: -400, description: "Synthetic outgoing", externalId: "outgoing-id" };
    await applyBankConnectionSnapshot({ connectionId, provider: "synthetic", expectedRevision: 1,
      accounts: [{ ...account, transactions: [payment] }] });
    await ingestTransactions({ accountId: receiver, source: "csv", filename: "Synthetic statement",
      transactions: [{ ...payment, amountCents: 400, externalId: "incoming-id" }] });
    const candidateId = String(database.prepare("SELECT id FROM ingested_transfer_candidates").get()!.id);
    const batch = db.batch.bind(db);
    const concurrentConfirmation = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await decideIngestedTransferCandidate(candidateId, "confirm");
      return await batch(statements);
    });
    try {
      await expect(applyBankConnectionSnapshot({ connectionId, provider: "synthetic", expectedRevision: 2,
        accounts: [{ ...account, balanceCents: 900, transactions: [{ ...payment, amountCents: -500 }] }] }))
        .rejects.toMatchObject({ status: 409, importId: expect.any(String) });
    } finally {
      concurrentConfirmation.mockRestore();
    }
    const candidate = database.prepare("SELECT status, transfer_group_id FROM ingested_transfer_candidates WHERE id = ?").get(candidateId)!;
    expect(candidate.status).toBe("confirmed");
    expect(database.prepare("SELECT kind, amount_cents, transfer_group_id FROM transactions WHERE account_id = ?").get(accountId))
      .toEqual({ kind: "transfer", amount_cents: -400, transfer_group_id: candidate.transfer_group_id });
    expect(database.prepare("SELECT kind, transfer_group_id FROM transactions WHERE account_id = ?").get(receiver))
      .toEqual({ kind: "transfer", transfer_group_id: candidate.transfer_group_id });
    expect(database.prepare("SELECT balance_cents FROM accounts WHERE id = ?").get(accountId)!.balance_cents).toBe(1000);
    expect(database.prepare("SELECT sync_revision FROM bank_connections WHERE id = ?").get(connectionId)!.sync_revision).toBe(2);
  });
});
