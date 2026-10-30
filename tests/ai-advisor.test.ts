import { describe, expect, it } from "vitest";
import { createRedactedFinancialSnapshot, type AiAdvisor } from "../shared/ai-advisor.ts";
import { calculateDashboard } from "../shared/finance.ts";
import type { Account, PlannedTransaction, Reserve, Transaction } from "../shared/types.ts";

const stamp = "2026-09-10T00:00:00.000Z";
const account: Account = {
  id: "ACCOUNT_IDENTIFIER_SENTINEL", name: "PERSON_NAME_SENTINEL", type: "checking", currency: "EUR",
  balanceCents: 150_000, isActive: true, createdAt: stamp, updatedAt: stamp,
};
const transaction: Transaction = {
  id: "TRANSACTION_IDENTIFIER_SENTINEL", accountId: account.id, date: "2026-09-08",
  amountCents: -4_000, currency: "EUR", description: "MERCHANT_NAME_SENTINEL IBAN_SENTINEL",
  kind: "expense", status: "cleared", source: "manual", transferGroupId: null,
  plannedTransactionId: null, correctedFromTransactionId: null, voidedAt: null,
  createdAt: stamp, updatedAt: stamp,
};
const planned: PlannedTransaction = {
  id: "PLANNED_IDENTIFIER_SENTINEL", accountId: account.id,
  description: "ADDRESS_SENTINEL", kind: "expense", amountCents: 25_000,
  currency: "EUR", recurrence: "monthly", intervalCount: 1, nextDate: "2026-09-20",
  endDate: null, isActive: true, createdAt: stamp, updatedAt: stamp,
};
const reserve: Reserve = {
  id: "RESERVE_IDENTIFIER_SENTINEL", name: "RESERVE_NAME_SENTINEL",
  fundedAmountCents: 10_000, targetAmountCents: null, targetDate: null,
  contributionMonth: null, contributedThisMonthCents: 0, requiredContributionCents: 0,
  linkedPlannedTransactionId: null, currency: "EUR", note: "FREE_TEXT_NOTE_SENTINEL",
  isActive: true, createdAt: stamp, updatedAt: stamp,
};

function dashboard() {
  return calculateDashboard({
    asOfDate: "2026-09-12", accounts: [account], transactions: [transaction],
    plannedTransactions: [planned], reserves: [reserve],
  });
}

describe("redacted AI boundary", () => {
  it("creates a versioned allowlist of aggregate amounts and month granularity", () => {
    const snapshot = createRedactedFinancialSnapshot(dashboard());
    expect(snapshot).toEqual({
      schemaVersion: 1, currency: "EUR", asOfMonth: "2026-09",
      currentCashCents: 150_000, spentThisMonthCents: 4_000,
      remainingIncomeCents: 0, remainingExpensesCents: 25_000,
      protectedReservesCents: 10_000, projectedMonthEndCents: 125_000,
      availableToSpendCents: 115_000,
      projectionMonths: expect.arrayContaining([expect.objectContaining({
        month: "2026-09", expectedIncomeCents: 0, committedExpensesCents: 25_000,
        protectedReservesCents: 10_000, projectedMonthEndCents: 125_000,
        availableToSpendCents: 115_000,
      })]),
    });
  });

  it("excludes raw descriptions, merchants, identifiers, IBANs, addresses, names, notes and unknown fields", () => {
    const source = dashboard();
    const contaminated = source as typeof source & { personalName: string; iban: string };
    contaminated.personalName = "EXTRA_PERSON_SENTINEL";
    contaminated.iban = "EXTRA_IBAN_SENTINEL";
    source.upcoming[0]!.description = "ADDRESS_SENTINEL";
    (source.projectionMonths[0] as typeof source.projectionMonths[0] & { merchant: string }).merchant = "EXTRA_MERCHANT_SENTINEL";

    const serialized = JSON.stringify(createRedactedFinancialSnapshot(contaminated));
    for (const sentinel of [
      account.id, account.name, transaction.id, "MERCHANT_NAME_SENTINEL", "IBAN_SENTINEL",
      planned.id, planned.description, reserve.id, reserve.name, reserve.note,
      contaminated.personalName, contaminated.iban, "EXTRA_MERCHANT_SENTINEL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    for (const prohibitedKey of ["description", "merchant", "accountId", "id", "iban", "address", "name", "note", "upcoming", "date"]) {
      expect(serialized).not.toContain(`"${prohibitedKey}"`);
    }
  });

  it("does not mutate the dashboard and gives an adapter frozen, detached values", async () => {
    const source = dashboard();
    const before = JSON.stringify(source);
    const snapshot = createRedactedFinancialSnapshot(source);
    const adapter: AiAdvisor = {
      async advise(input) {
        expect(input).toBe(snapshot);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.projectionMonths)).toBe(true);
        expect(Object.isFrozen(input.projectionMonths[0])).toBe(true);
        expect(() => { (input as { currentCashCents: number }).currentCashCents = 0; }).toThrow();
        return { summary: "Synthetic advice", considerations: [] };
      },
    };
    expect(await adapter.advise(snapshot)).toEqual({ summary: "Synthetic advice", considerations: [] });
    expect(JSON.stringify(source)).toBe(before);
    source.projectionMonths[0]!.projectedMonthEndCents = 0;
    expect(snapshot.projectionMonths[0]!.projectedMonthEndCents).toBe(125_000);
  });

  it("rejects invalid source dates and noninteger or unsafe amounts", () => {
    const invalid = dashboard();
    invalid.asOfDate = "2026-09-12 SECRET";
    expect(() => createRedactedFinancialSnapshot(invalid)).toThrow();
    invalid.asOfDate = "2026-09-12";
    invalid.projectionMonths[0]!.monthStart = "2026-09-01 SECRET";
    expect(() => createRedactedFinancialSnapshot(invalid)).toThrow();
    invalid.projectionMonths[0]!.monthStart = "2026-09-01";
    invalid.currentCashCents = Number.MAX_SAFE_INTEGER + 1;
    expect(() => createRedactedFinancialSnapshot(invalid)).toThrow("safe integer");
  });
});
