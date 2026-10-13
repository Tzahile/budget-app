import { assertDateOnly } from "./finance.ts";
import type { DashboardSummary } from "./types.ts";

/** The only financial payload a future AI adapter may receive. */
export interface RedactedFinancialSnapshotV1 {
  readonly schemaVersion: 1;
  readonly currency: "EUR";
  readonly asOfMonth: string;
  readonly currentCashCents: number;
  readonly spentThisMonthCents: number;
  readonly remainingIncomeCents: number;
  readonly remainingExpensesCents: number;
  readonly protectedReservesCents: number;
  readonly projectedMonthEndCents: number;
  readonly availableToSpendCents: number;
  readonly projectionMonths: readonly Readonly<{
    month: string;
    expectedIncomeCents: number;
    committedExpensesCents: number;
    protectedReservesCents: number;
    projectedMonthEndCents: number;
    availableToSpendCents: number;
  }>[];
}

export type RedactedFinancialSnapshot = RedactedFinancialSnapshotV1;

/** An advisory result is text, never a command or a financial mutation. */
export interface AiAdvice {
  readonly summary: string;
  readonly considerations: readonly string[];
}

/** Provider adapters receive only the redacted value; no repository or account state. */
export interface AiAdvisor {
  advise(snapshot: RedactedFinancialSnapshot): Promise<AiAdvice>;
}

function cents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("Snapshot metric must be a safe integer of cents");
  return value;
}

function month(date: string): string {
  assertDateOnly(date);
  return date.slice(0, 7);
}

/** Pure allowlist projection. Never spread dashboard objects into an AI payload. */
export function createRedactedFinancialSnapshot(dashboard: DashboardSummary): RedactedFinancialSnapshot {
  const projectionMonths = dashboard.projectionMonths.map((projection) => Object.freeze({
    month: month(projection.monthStart),
    expectedIncomeCents: cents(projection.expectedIncomeCents),
    committedExpensesCents: cents(projection.committedExpensesCents),
    protectedReservesCents: cents(projection.protectedReservesCents),
    projectedMonthEndCents: cents(projection.projectedMonthEndCents),
    availableToSpendCents: cents(projection.availableToSpendCents),
  }));

  return Object.freeze({
    schemaVersion: 1,
    currency: "EUR",
    asOfMonth: month(dashboard.asOfDate),
    currentCashCents: cents(dashboard.currentCashCents),
    spentThisMonthCents: cents(dashboard.spentThisMonthCents),
    remainingIncomeCents: cents(dashboard.remainingIncomeCents),
    remainingExpensesCents: cents(dashboard.remainingExpensesCents),
    protectedReservesCents: cents(dashboard.protectedReservesCents),
    projectedMonthEndCents: cents(dashboard.projectedMonthEndCents),
    availableToSpendCents: cents(dashboard.availableToSpendCents),
    projectionMonths: Object.freeze(projectionMonths),
  });
}
