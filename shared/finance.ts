import type {
  Account,
  CashFlowProjectionMonth,
  DashboardSummary,
  PlannedOccurrence,
  PlannedTransaction,
  Reserve,
  Transaction,
} from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateOnly(value: string): void {
  if (!DATE_RE.test(value)) throw new Error("Date must use YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) throw new Error("Date is invalid");
}

export function householdDate(now = new Date(), timeZone = "Europe/Rome"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function monthBounds(date: string): { start: string; end: string } {
  assertDateOnly(date);
  const [year, month] = date.split("-").map(Number);
  return {
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: formatUtcDate(new Date(Date.UTC(year, month, 0))),
  };
}

export function addRecurrence(
  date: string,
  recurrence: PlannedTransaction["recurrence"],
  intervalCount: number,
): string | null {
  assertDateOnly(date);
  if (recurrence === "once") return null;
  if (!Number.isInteger(intervalCount) || intervalCount < 1) throw new Error("Interval must be a positive integer");
  const [year, month, day] = date.split("-").map(Number);
  if (recurrence === "weekly") {
    return formatUtcDate(new Date(Date.UTC(year, month - 1, day + 7 * intervalCount)));
  }
  if (recurrence === "monthly") {
    const targetMonthStart = new Date(Date.UTC(year, month - 1 + intervalCount, 1));
    const targetYear = targetMonthStart.getUTCFullYear();
    const targetMonth = targetMonthStart.getUTCMonth();
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return formatUtcDate(new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))));
  }
  const targetYear = year + intervalCount;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return formatUtcDate(new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay))));
}

export function occurrencesBetween(
  item: PlannedTransaction,
  fromDate: string,
  toDate: string,
): PlannedOccurrence[] {
  if (!item.isActive || item.nextDate > toDate || (item.endDate && item.nextDate > item.endDate)) return [];
  const occurrences: PlannedOccurrence[] = [];
  let cursor: string | null = item.nextDate;
  let guard = 0;
  while (cursor && cursor <= toDate && (!item.endDate || cursor <= item.endDate)) {
    if (cursor >= fromDate) {
      occurrences.push({
        plannedTransactionId: item.id,
        description: item.description,
        kind: item.kind,
        amountCents: item.amountCents,
        date: cursor,
        linkedReserveId: null,
        linkedReserveName: null,
        linkedGoalCoverageCents: 0,
      });
    }
    cursor = addRecurrence(cursor, item.recurrence, item.intervalCount);
    if (++guard > 400) throw new Error("Recurrence produced too many occurrences");
  }
  return occurrences;
}

export function calculateDashboard(input: {
  asOfDate: string;
  accounts: Account[];
  transactions: Transaction[];
  plannedTransactions: PlannedTransaction[];
  reserves: Reserve[];
}): DashboardSummary {
  const { start, end } = monthBounds(input.asOfDate);
  const currentCashCents = sum(input.accounts.filter((a) => a.isActive), (a) => a.balanceCents);
  const monthTransactions = input.transactions.filter(
    (t) => t.status === "cleared" && t.date >= start && t.date <= input.asOfDate && t.kind !== "transfer",
  );
  const grossExpenses = sum(monthTransactions.filter((t) => t.kind === "expense"), (t) => Math.abs(t.amountCents));
  const refunds = sum(monthTransactions.filter((t) => t.kind === "refund"), (t) => Math.abs(t.amountCents));
  const spentThisMonthCents = Math.max(0, grossExpenses - refunds);
  const rawUpcoming = input.plannedTransactions
    // nextDate is the earliest unpaid occurrence, so overdue items remain
    // committed until explicitly completed rather than disappearing at midnight.
    .flatMap((item) => occurrencesBetween(item, item.nextDate, end))
    .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
  const activeReserves = input.reserves.filter((reserve) => reserve.isActive);
  const linkedReserves = new Map(activeReserves
    .filter((reserve) => reserve.targetAmountCents != null && reserve.linkedPlannedTransactionId != null)
    .map((reserve) => [reserve.linkedPlannedTransactionId!, reserve]));
  const eligiblePlannedIds = new Set(input.plannedTransactions
    .filter((item) => item.isActive && item.kind === "expense" && item.recurrence === "once")
    .map((item) => item.id));
  const upcoming = rawUpcoming.map((occurrence) => {
    const reserve = occurrence.kind === "expense" && eligiblePlannedIds.has(occurrence.plannedTransactionId)
      ? linkedReserves.get(occurrence.plannedTransactionId)
      : undefined;
    if (!reserve) return occurrence;
    const protectedForGoal = reserve.fundedAmountCents + requiredGoalContributionCents(reserve, input.asOfDate);
    return {
      ...occurrence,
      linkedReserveId: reserve.id,
      linkedReserveName: reserve.name,
      linkedGoalCoverageCents: Math.min(occurrence.amountCents, protectedForGoal),
    };
  });
  const remainingIncomeCents = sum(upcoming.filter((o) => o.kind === "income"), (o) => o.amountCents);
  const remainingExpensesCents = sum(upcoming.filter((o) => o.kind === "expense"), (o) => o.amountCents);
  const fundedReservesCents = sum(activeReserves, (reserve) => reserve.fundedAmountCents);
  const requiredGoalContributionsCents = sum(
    activeReserves,
    (reserve) => requiredGoalContributionCents(reserve, input.asOfDate),
  );
  const linkedGoalCoverageCents = sum(upcoming, (occurrence) => occurrence.linkedGoalCoverageCents);
  const protectedReservesCents = fundedReservesCents + requiredGoalContributionsCents - linkedGoalCoverageCents;
  const projectedMonthEndCents = currentCashCents + remainingIncomeCents - remainingExpensesCents;
  const safeToSpendCents = projectedMonthEndCents - protectedReservesCents;
  const projectionMonths = calculateCashFlowProjection(input);

  return {
    asOfDate: input.asOfDate,
    monthStart: start,
    monthEnd: end,
    currentCashCents,
    spentThisMonthCents,
    remainingIncomeCents,
    remainingExpensesCents,
    fundedReservesCents,
    requiredGoalContributionsCents,
    linkedGoalCoverageCents,
    protectedReservesCents,
    projectedMonthEndCents,
    safeToSpendCents,
    upcoming,
    projectionMonths,
  };
}

/**
 * Projects the current (partial) household month plus the next five calendar
 * months. It only models deterministic planned cash flow and reserve goals;
 * it deliberately does not make an advisory "safe to spend" recommendation.
 */
export function calculateCashFlowProjection(input: {
  asOfDate: string;
  accounts: Account[];
  plannedTransactions: PlannedTransaction[];
  reserves: Reserve[];
  months?: number;
}): CashFlowProjectionMonth[] {
  assertDateOnly(input.asOfDate);
  const months = input.months ?? 6;
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    throw new Error("Projection months must be an integer between 1 and 24");
  }

  let openingCashCents = sum(input.accounts.filter((account) => account.isActive), (account) => account.balanceCents);
  const virtualReserves = input.reserves
    .filter((reserve) => reserve.isActive)
    .map((reserve) => ({ ...reserve }));
  const linkedReserves = new Map(virtualReserves
    .filter((reserve) => reserve.targetAmountCents != null && reserve.linkedPlannedTransactionId != null)
    .map((reserve) => [reserve.linkedPlannedTransactionId!, reserve]));
  const eligiblePlannedIds = new Set(input.plannedTransactions
    .filter((item) => item.isActive && item.kind === "expense" && item.recurrence === "once")
    .map((item) => item.id));
  const result: CashFlowProjectionMonth[] = [];

  for (let index = 0; index < months; index++) {
    const monthStart = projectionMonthStart(input.asOfDate, index);
    const { end: monthEnd } = monthBounds(monthStart);
    const occurrenceStart = index === 0 ? input.asOfDate : monthStart;
    const rawUpcoming = input.plannedTransactions
      .flatMap((item) => occurrencesBetween(item, index === 0 ? item.nextDate : occurrenceStart, monthEnd))
      .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
    const monthlyGoalContributionsCents = sum(
      virtualReserves,
      (reserve) => requiredGoalContributionCents(reserve, occurrenceStart),
    );
    for (const reserve of virtualReserves) {
      const contribution = requiredGoalContributionCents(reserve, occurrenceStart);
      if (contribution === 0) continue;
      reserve.fundedAmountCents += contribution;
      reserve.contributionMonth = occurrenceStart.slice(0, 7);
      reserve.contributedThisMonthCents = contribution;
    }

    const upcoming = rawUpcoming.map((occurrence) => {
      const reserve = occurrence.kind === "expense" && eligiblePlannedIds.has(occurrence.plannedTransactionId)
        ? linkedReserves.get(occurrence.plannedTransactionId)
        : undefined;
      if (!reserve || !reserve.isActive) return occurrence;
      return {
        ...occurrence,
        linkedReserveId: reserve.id,
        linkedReserveName: reserve.name,
        linkedGoalCoverageCents: Math.min(occurrence.amountCents, reserve.fundedAmountCents),
      };
    });
    const expectedIncomeCents = sum(upcoming.filter((item) => item.kind === "income"), (item) => item.amountCents);
    const committedExpensesCents = sum(upcoming.filter((item) => item.kind === "expense"), (item) => item.amountCents);
    const linkedGoalCoverageCents = sum(upcoming, (item) => item.linkedGoalCoverageCents);
    const grossProtectedCents = sum(virtualReserves.filter((reserve) => reserve.isActive), (reserve) => reserve.fundedAmountCents);
    const protectedReservesCents = grossProtectedCents - linkedGoalCoverageCents;
    const projectedMonthEndCents = openingCashCents + expectedIncomeCents - committedExpensesCents;
    result.push({
      monthStart,
      monthEnd,
      openingCashCents,
      expectedIncomeCents,
      committedExpensesCents,
      monthlyGoalContributionsCents,
      protectedReservesCents,
      linkedGoalCoverageCents,
      projectedMonthEndCents,
      availableToSpendCents: projectedMonthEndCents - protectedReservesCents,
      upcoming,
    });

    // A linked one-off goal is consumed in the simulated future once its
    // planned expense happens. This prevents its protected balance from being
    // deducted again in later forecast months.
    for (const occurrence of upcoming) {
      if (!occurrence.linkedReserveId || occurrence.linkedGoalCoverageCents === 0) continue;
      const reserve = linkedReserves.get(occurrence.plannedTransactionId);
      if (!reserve) continue;
      reserve.fundedAmountCents -= occurrence.linkedGoalCoverageCents;
      reserve.isActive = false;
    }
    openingCashCents = projectedMonthEndCents;
  }
  return result;
}

export function requiredGoalContributionCents(
  reserve: Pick<Reserve, "fundedAmountCents" | "targetAmountCents" | "targetDate" |
    "contributionMonth" | "contributedThisMonthCents" | "isActive">,
  asOfDate: string,
): number {
  if (!reserve.isActive || reserve.targetAmountCents == null || reserve.targetDate == null) return 0;
  assertDateOnly(asOfDate);
  assertDateOnly(reserve.targetDate);
  const [asOfYear, asOfMonth] = asOfDate.split("-").map(Number);
  const [targetYear, targetMonth] = reserve.targetDate.split("-").map(Number);
  const currentMonth = asOfDate.slice(0, 7);
  const contributedThisMonth = reserve.contributionMonth === currentMonth
    ? reserve.contributedThisMonthCents
    : 0;
  const fundedBeforeThisMonth = reserve.fundedAmountCents - contributedThisMonth;
  const shortfallAtMonthStart = Math.max(0, reserve.targetAmountCents - fundedBeforeThisMonth);
  if (shortfallAtMonthStart === 0) return 0;

  const monthDistance = (targetYear - asOfYear) * 12 + targetMonth - asOfMonth;
  const contributionMonths = Math.max(1, monthDistance + 1);
  const scheduledContribution = Math.ceil(shortfallAtMonthStart / contributionMonths);
  return Math.max(0, scheduledContribution - contributedThisMonth);
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function projectionMonthStart(asOfDate: string, offset: number): string {
  const [year, month] = asOfDate.split("-").map(Number);
  return formatUtcDate(new Date(Date.UTC(year, month - 1 + offset, 1)));
}
