import { describe, expect, it } from "vitest";
import { addRecurrence, assertDateOnly, calculateDashboard, householdDate, occurrencesBetween } from "../shared/finance.ts";
import type { Account, PlannedTransaction, Reserve, Transaction } from "../shared/types.ts";

const now = "2026-09-12T10:00:00.000Z";
const account = (balanceCents: number, overrides: Partial<Account> = {}): Account => ({
  id: "account-1", name: "Main", type: "checking", currency: "EUR", balanceCents, isActive: true,
  createdAt: now, updatedAt: now, ...overrides,
});
const transaction = (amountCents: number, overrides: Partial<Transaction> = {}): Transaction => ({
  id: crypto.randomUUID(), accountId: "account-1", date: "2026-09-10", amountCents, currency: "EUR",
  description: "Test", kind: amountCents < 0 ? "expense" : "income", status: "cleared", source: "manual",
  transferGroupId: null, plannedTransactionId: null, createdAt: now, updatedAt: now, ...overrides,
});
const planned = (overrides: Partial<PlannedTransaction> = {}): PlannedTransaction => ({
  id: "planned-1", accountId: "account-1", description: "Mortgage", kind: "expense", amountCents: 58_100,
  currency: "EUR", recurrence: "monthly", intervalCount: 1, nextDate: "2026-09-15", endDate: null,
  isActive: true, createdAt: now, updatedAt: now, ...overrides,
});
const reserve = (amountCents: number, overrides: Partial<Reserve> = {}): Reserve => ({
  id: crypto.randomUUID(), name: "Buffer", amountCents, currency: "EUR", note: "", isActive: true,
  createdAt: now, updatedAt: now, ...overrides,
});

describe("calculateDashboard", () => {
  it("calculates the core cash-flow equation without double counting recorded transactions", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12",
      accounts: [account(200_000), account(50_000, { id: "account-2", type: "savings" })],
      transactions: [transaction(-20_000), transaction(180_000, { kind: "income" })],
      plannedTransactions: [planned(), planned({ id: "income", description: "Salary", kind: "income", amountCents: 280_000, nextDate: "2026-09-25" })],
      reserves: [reserve(100_000)],
    });

    expect(result.currentCashCents).toBe(250_000);
    expect(result.spentThisMonthCents).toBe(20_000);
    expect(result.remainingIncomeCents).toBe(280_000);
    expect(result.remainingExpensesCents).toBe(58_100);
    expect(result.projectedMonthEndCents).toBe(471_900);
    expect(result.safeToSpendCents).toBe(371_900);
  });

  it("excludes inactive accounts and reserves", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12",
      accounts: [account(100_000), account(900_000, { id: "closed", isActive: false })],
      transactions: [], plannedTransactions: [],
      reserves: [reserve(20_000), reserve(80_000, { isActive: false })],
    });
    expect(result.currentCashCents).toBe(100_000);
    expect(result.protectedReservesCents).toBe(20_000);
    expect(result.safeToSpendCents).toBe(80_000);
  });

  it("nets refunds against spending and excludes transfers", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(100_000)], plannedTransactions: [], reserves: [],
      transactions: [
        transaction(-50_000),
        transaction(12_000, { kind: "refund" }),
        transaction(-25_000, { kind: "transfer", transferGroupId: "transfer-1" }),
        transaction(-7_000, { status: "pending" }),
      ],
    });
    expect(result.spentThisMonthCents).toBe(38_000);
  });

  it("ignores transactions outside the current month and after the as-of date", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(0)], plannedTransactions: [], reserves: [],
      transactions: [transaction(-2_000, { date: "2026-08-31" }), transaction(-3_000, { date: "2026-09-13" })],
    });
    expect(result.spentThisMonthCents).toBe(0);
  });

  it("can produce a negative safe-to-spend value", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(10_000)], transactions: [],
      plannedTransactions: [planned({ amountCents: 30_000 })], reserves: [reserve(5_000)],
    });
    expect(result.safeToSpendCents).toBe(-25_000);
  });

  it("keeps overdue unpaid occurrences in committed cash flow", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(100_000)], transactions: [], reserves: [],
      plannedTransactions: [planned({ recurrence: "once", nextDate: "2026-09-05", amountCents: 25_000 })],
    });
    expect(result.remainingExpensesCents).toBe(25_000);
    expect(result.upcoming[0]?.date).toBe("2026-09-05");
  });
});

describe("recurrences", () => {
  it("clamps monthly occurrences to the last valid day", () => {
    expect(addRecurrence("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    expect(addRecurrence("2028-01-31", "monthly", 1)).toBe("2028-02-29");
  });

  it("clamps leap-day yearly occurrences", () => {
    expect(addRecurrence("2028-02-29", "yearly", 1)).toBe("2029-02-28");
  });

  it("includes an unpaid occurrence due today and all later occurrences in range", () => {
    const occurrences = occurrencesBetween(
      planned({ recurrence: "weekly", nextDate: "2026-09-12" }),
      "2026-09-12",
      "2026-09-30",
    );
    expect(occurrences.map((item) => item.date)).toEqual(["2026-09-12", "2026-09-19", "2026-09-26"]);
  });

  it("emits a one-off occurrence once", () => {
    expect(occurrencesBetween(planned({ recurrence: "once" }), "2026-09-01", "2026-09-30")).toHaveLength(1);
  });

  it("respects inactive status and end dates", () => {
    expect(occurrencesBetween(planned({ isActive: false }), "2026-09-01", "2026-09-30")).toEqual([]);
    expect(occurrencesBetween(planned({ endDate: "2026-09-14" }), "2026-09-01", "2026-09-30")).toEqual([]);
  });
});

describe("date conventions", () => {
  it("rejects invalid calendar dates", () => {
    expect(() => assertDateOnly("2026-02-29")).toThrow("invalid");
    expect(() => assertDateOnly("12/09/2026")).toThrow("YYYY-MM-DD");
  });

  it("derives the household date in Europe/Rome", () => {
    expect(householdDate(new Date("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
  });
});
