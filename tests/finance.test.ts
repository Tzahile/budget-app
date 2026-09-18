import { describe, expect, it } from "vitest";
import { addRecurrence, assertDateOnly, calculateCashFlowProjection, calculateDashboard, householdDate, occurrencesBetween, requiredGoalContributionCents } from "../shared/finance.ts";
import type { Account, PlannedTransaction, Reserve, Transaction } from "../shared/types.ts";

const now = "2026-09-12T10:00:00.000Z";
const account = (balanceCents: number, overrides: Partial<Account> = {}): Account => ({
  id: "account-1", name: "Main", type: "checking", currency: "EUR", balanceCents, isActive: true,
  createdAt: now, updatedAt: now, ...overrides,
});
const transaction = (amountCents: number, overrides: Partial<Transaction> = {}): Transaction => ({
  id: crypto.randomUUID(), accountId: "account-1", date: "2026-09-10", amountCents, currency: "EUR",
  description: "Test", kind: amountCents < 0 ? "expense" : "income", status: "cleared", source: "manual",
  transferGroupId: null, plannedTransactionId: null, correctedFromTransactionId: null, voidedAt: null,
  createdAt: now, updatedAt: now, ...overrides,
});
const planned = (overrides: Partial<PlannedTransaction> = {}): PlannedTransaction => ({
  id: "planned-1", accountId: "account-1", description: "Mortgage", kind: "expense", amountCents: 58_100,
  currency: "EUR", recurrence: "monthly", intervalCount: 1, nextDate: "2026-09-15", endDate: null,
  isActive: true, createdAt: now, updatedAt: now, ...overrides,
});
const reserve = (amountCents: number, overrides: Partial<Reserve> = {}): Reserve => ({
  id: crypto.randomUUID(), name: "Buffer", fundedAmountCents: amountCents, targetAmountCents: null,
  targetDate: null, contributionMonth: null, contributedThisMonthCents: 0,
  requiredContributionCents: 0, linkedPlannedTransactionId: null,
  currency: "EUR", note: "", isActive: true,
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
    expect(result.fundedReservesCents).toBe(100_000);
    expect(result.requiredGoalContributionsCents).toBe(0);
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

  it("does not turn a two-leg owned-account transfer into household income or spending", () => {
    const result = calculateDashboard({
      asOfDate: "2026-09-12",
      accounts: [account(75_000), account(125_000, { id: "account-2", type: "savings" })],
      plannedTransactions: [], reserves: [],
      transactions: [
        transaction(-25_000, { kind: "transfer", transferGroupId: "transfer-1" }),
        transaction(25_000, { accountId: "account-2", kind: "transfer", transferGroupId: "transfer-1" }),
      ],
    });
    expect(result.currentCashCents).toBe(200_000);
    expect(result.spentThisMonthCents).toBe(0);
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

  it("counts a fully funded linked goal and its planned expense only once", () => {
    const expense = planned({ recurrence: "once", amountCents: 600_000, nextDate: "2026-09-20" });
    const result = calculateDashboard({
      asOfDate: "2026-09-12",
      accounts: [account(1_000_000)],
      transactions: [],
      plannedTransactions: [expense],
      reserves: [reserve(600_000, {
        name: "New car",
        targetAmountCents: 600_000,
        targetDate: "2026-09-20",
        linkedPlannedTransactionId: expense.id,
      })],
    });

    expect(result.remainingExpensesCents).toBe(600_000);
    expect(result.projectedMonthEndCents).toBe(400_000);
    expect(result.linkedGoalCoverageCents).toBe(600_000);
    expect(result.protectedReservesCents).toBe(0);
    expect(result.safeToSpendCents).toBe(400_000);
    expect(result.upcoming[0]).toMatchObject({
      linkedReserveName: "New car",
      linkedGoalCoverageCents: 600_000,
    });
  });

  it("only overlaps the protected portion of a partly funded linked goal", () => {
    const expense = planned({ recurrence: "once", amountCents: 600_000, nextDate: "2026-09-20" });
    const result = calculateDashboard({
      asOfDate: "2026-09-12",
      accounts: [account(1_000_000)],
      transactions: [],
      plannedTransactions: [expense],
      reserves: [reserve(200_000, {
        targetAmountCents: 300_000,
        targetDate: "2026-09-20",
        linkedPlannedTransactionId: expense.id,
      })],
    });

    expect(result.requiredGoalContributionsCents).toBe(100_000);
    expect(result.linkedGoalCoverageCents).toBe(300_000);
    expect(result.protectedReservesCents).toBe(0);
    expect(result.safeToSpendCents).toBe(400_000);
  });

  it("leaves unlinked, inactive, missing, and recurring associations unchanged", () => {
    const expense = planned({ recurrence: "once", amountCents: 60_000, nextDate: "2026-09-20" });
    const scenarios = [
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-09-20" }),
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-09-20", linkedPlannedTransactionId: expense.id, isActive: false }),
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-09-20", linkedPlannedTransactionId: "deleted-plan" }),
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-09-20", linkedPlannedTransactionId: expense.id }),
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-09-20", linkedPlannedTransactionId: expense.id }),
    ];
    const plannedInputs = [
      [expense], [expense], [expense],
      [planned({ ...expense, recurrence: "monthly" })],
      [planned({ ...expense, isActive: false })],
    ];

    scenarios.forEach((goal, index) => {
      const result = calculateDashboard({
        asOfDate: "2026-09-12", accounts: [account(100_000)], transactions: [],
        plannedTransactions: plannedInputs[index], reserves: [goal],
      });
      expect(result.linkedGoalCoverageCents).toBe(0);
    });
  });

  it("applies linked coverage to an overdue unpaid one-off expense", () => {
    const expense = planned({ recurrence: "once", amountCents: 60_000, nextDate: "2026-09-05" });
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(100_000)], transactions: [], plannedTransactions: [expense],
      reserves: [reserve(25_000, {
        targetAmountCents: 25_000,
        targetDate: "2026-09-05",
        linkedPlannedTransactionId: expense.id,
      })],
    });

    expect(result.linkedGoalCoverageCents).toBe(25_000);
    expect(result.safeToSpendCents).toBe(40_000);
  });
});

describe("reserve goals", () => {
  it("supports a 6000 EUR November goal with one contribution per remaining month", () => {
    const goal = reserve(0, { targetAmountCents: 600_000, targetDate: "2026-11-30" });
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(700_000)], transactions: [], plannedTransactions: [],
      reserves: [goal],
    });

    expect(requiredGoalContributionCents(goal, "2026-09-12")).toBe(200_000);
    expect(result.fundedReservesCents).toBe(0);
    expect(result.requiredGoalContributionsCents).toBe(200_000);
    expect(result.safeToSpendCents).toBe(500_000);
  });

  it("does not require September twice after its contribution is funded and rolls forward in October", () => {
    const fundedInSeptember = reserve(200_000, {
      targetAmountCents: 600_000,
      targetDate: "2026-11-30",
      contributionMonth: "2026-09",
      contributedThisMonthCents: 200_000,
    });

    expect(requiredGoalContributionCents(fundedInSeptember, "2026-09-20")).toBe(0);
    expect(requiredGoalContributionCents(fundedInSeptember, "2026-10-01")).toBe(200_000);
  });

  it("uses funded progress and rounds the contribution up to whole cents", () => {
    const goal = reserve(100_000, { targetAmountCents: 600_000, targetDate: "2026-11-30" });
    expect(requiredGoalContributionCents(goal, "2026-09-12")).toBe(166_667);
    const result = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(700_000)], transactions: [], plannedTransactions: [],
      reserves: [goal],
    });
    expect(result.fundedReservesCents).toBe(100_000);
    expect(result.requiredGoalContributionsCents).toBe(166_667);
    expect(result.protectedReservesCents).toBe(266_667);
    expect(result.safeToSpendCents).toBe(433_333);
    expect(requiredGoalContributionCents(
      reserve(0, { targetAmountCents: 100, targetDate: "2026-11-30" }),
      "2026-09-12",
    )).toBe(34);
    expect(requiredGoalContributionCents(
      reserve(10, {
        targetAmountCents: 100,
        targetDate: "2026-11-30",
        contributionMonth: "2026-09",
        contributedThisMonthCents: 10,
      }),
      "2026-09-12",
    )).toBe(24);
  });

  it("recalculates an edited target from the month-start baseline without losing recorded funding", () => {
    const editedGoal = reserve(200_000, {
      targetAmountCents: 900_000,
      targetDate: "2026-11-30",
      contributionMonth: "2026-09",
      contributedThisMonthCents: 200_000,
    });

    expect(requiredGoalContributionCents(editedGoal, "2026-09-20")).toBe(100_000);
  });

  it("requires the entire remaining shortfall for current-month and overdue goals", () => {
    const currentMonth = reserve(25_000, { targetAmountCents: 100_000, targetDate: "2026-09-30" });
    const overdue = reserve(25_000, { targetAmountCents: 100_000, targetDate: "2026-08-31" });
    expect(requiredGoalContributionCents(currentMonth, "2026-09-12")).toBe(75_000);
    expect(requiredGoalContributionCents(overdue, "2026-09-12")).toBe(75_000);
  });

  it("requires nothing for inactive, simple, completed, or overfunded reserves", () => {
    expect(requiredGoalContributionCents(reserve(10_000), "2026-09-12")).toBe(0);
    expect(requiredGoalContributionCents(
      reserve(10_000, { targetAmountCents: 20_000, targetDate: "2026-11-30", isActive: false }),
      "2026-09-12",
    )).toBe(0);
    expect(requiredGoalContributionCents(
      reserve(20_000, { targetAmountCents: 20_000, targetDate: "2026-11-30" }),
      "2026-09-12",
    )).toBe(0);
    expect(requiredGoalContributionCents(
      reserve(25_000, { targetAmountCents: 20_000, targetDate: "2026-11-30" }),
      "2026-09-12",
    )).toBe(0);
  });
});

describe("multi-month cash-flow projection", () => {
  it("carries each projected month-end into the next opening balance without replaying cleared transactions", () => {
    const projection = calculateCashFlowProjection({
      asOfDate: "2026-09-12",
      accounts: [account(100_000)],
      plannedTransactions: [
        planned({ description: "Salary", kind: "income", amountCents: 200_000, nextDate: "2026-09-25" }),
        planned({ description: "Rent", amountCents: 80_000, nextDate: "2026-09-15" }),
      ],
      reserves: [],
      months: 2,
    });

    expect(projection).toHaveLength(2);
    expect(projection[0]).toMatchObject({
      monthStart: "2026-09-01", openingCashCents: 100_000,
      expectedIncomeCents: 200_000, committedExpensesCents: 80_000,
      projectedMonthEndCents: 220_000,
    });
    expect(projection[1]).toMatchObject({
      monthStart: "2026-10-01", openingCashCents: 220_000,
      expectedIncomeCents: 200_000, committedExpensesCents: 80_000,
      projectedMonthEndCents: 340_000,
    });
  });

  it("keeps overdue commitments in the current month only", () => {
    const projection = calculateCashFlowProjection({
      asOfDate: "2026-09-12", accounts: [account(100_000)], reserves: [], months: 2,
      plannedTransactions: [planned({ recurrence: "once", nextDate: "2026-09-05", amountCents: 25_000 })],
    });

    expect(projection[0]?.committedExpensesCents).toBe(25_000);
    expect(projection[0]?.upcoming[0]?.date).toBe("2026-09-05");
    expect(projection[1]?.committedExpensesCents).toBe(0);
  });

  it("spreads target-date protection across forecast months and consumes a linked goal after its expense", () => {
    const car = planned({ id: "car", recurrence: "once", nextDate: "2026-11-20", amountCents: 600_000 });
    const projection = calculateCashFlowProjection({
      asOfDate: "2026-09-12", accounts: [account(1_000_000)], plannedTransactions: [car], months: 4,
      reserves: [reserve(0, {
        name: "Car", targetAmountCents: 600_000, targetDate: "2026-11-30", linkedPlannedTransactionId: car.id,
      })],
    });

    expect(projection.map((month) => month.monthlyGoalContributionsCents)).toEqual([200_000, 200_000, 200_000, 0]);
    expect(projection[2]).toMatchObject({
      committedExpensesCents: 600_000,
      linkedGoalCoverageCents: 600_000,
      protectedReservesCents: 0,
      projectedMonthEndCents: 400_000,
      availableToSpendCents: 400_000,
    });
    expect(projection[3]?.protectedReservesCents).toBe(0);
  });

  it("exposes the same first-month forecast through the dashboard", () => {
    const dashboard = calculateDashboard({
      asOfDate: "2026-09-12", accounts: [account(100_000)], transactions: [], reserves: [],
      plannedTransactions: [planned({ amountCents: 30_000 })],
    });
    expect(dashboard.projectionMonths[0]).toMatchObject({
      projectedMonthEndCents: dashboard.projectedMonthEndCents,
      availableToSpendCents: dashboard.safeToSpendCents,
    });
  });

  it("rejects an invalid projection horizon", () => {
    expect(() => calculateCashFlowProjection({
      asOfDate: "2026-09-12", accounts: [], plannedTransactions: [], reserves: [], months: 0,
    })).toThrow("Projection months");
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
