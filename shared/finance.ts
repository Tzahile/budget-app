import type {
  Account,
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
  const upcoming = input.plannedTransactions
    // nextDate is the earliest unpaid occurrence, so overdue items remain
    // committed until explicitly completed rather than disappearing at midnight.
    .flatMap((item) => occurrencesBetween(item, item.nextDate, end))
    .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
  const remainingIncomeCents = sum(upcoming.filter((o) => o.kind === "income"), (o) => o.amountCents);
  const remainingExpensesCents = sum(upcoming.filter((o) => o.kind === "expense"), (o) => o.amountCents);
  const activeReserves = input.reserves.filter((reserve) => reserve.isActive);
  const fundedReservesCents = sum(activeReserves, (reserve) => reserve.fundedAmountCents);
  const requiredGoalContributionsCents = sum(
    activeReserves,
    (reserve) => requiredGoalContributionCents(reserve, input.asOfDate),
  );
  const protectedReservesCents = fundedReservesCents + requiredGoalContributionsCents;
  const projectedMonthEndCents = currentCashCents + remainingIncomeCents - remainingExpensesCents;
  const safeToSpendCents = projectedMonthEndCents - protectedReservesCents;

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
    protectedReservesCents,
    projectedMonthEndCents,
    safeToSpendCents,
    upcoming,
  };
}

export function requiredGoalContributionCents(
  reserve: Pick<Reserve, "fundedAmountCents" | "targetAmountCents" | "targetDate" | "isActive">,
  asOfDate: string,
): number {
  if (!reserve.isActive || reserve.targetAmountCents == null || reserve.targetDate == null) return 0;
  assertDateOnly(asOfDate);
  assertDateOnly(reserve.targetDate);
  const remaining = Math.max(0, reserve.targetAmountCents - reserve.fundedAmountCents);
  if (remaining === 0) return 0;

  const [asOfYear, asOfMonth] = asOfDate.split("-").map(Number);
  const [targetYear, targetMonth] = reserve.targetDate.split("-").map(Number);
  const monthDistance = (targetYear - asOfYear) * 12 + targetMonth - asOfMonth;
  const contributionMonths = Math.max(1, monthDistance + 1);
  return Math.floor(remaining / contributionMonths) + (remaining % contributionMonths === 0 ? 0 : 1);
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
