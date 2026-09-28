import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestSqlite } from "./support/val-sqlite.ts";
import {
  consumeBankConsentAttempt, createAccount, createBankConnection, createBankConsentAttempt, createLinkedBankAccount,
  getAppData, hashBankConsentState, ingestBankAccountTransactions, linkBankAccount,
  listBankConnections, markBankConnection,
} from "../server/repository.ts";

let database: DatabaseSync;
beforeAll(() => { database = new DatabaseSync(":memory:"); useTestSqlite(database); });
afterAll(() => database.close());

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
    const input = { connectionId, providerAccountId: "provider-account-2", name: "Synthetic linked" };
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
    const accountId = await createLinkedBankAccount({ connectionId, providerAccountId: "revision-account", name: "Revision test" });
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
