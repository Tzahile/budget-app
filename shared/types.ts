export type AccountType = "checking" | "savings" | "cash";
export type TransactionKind = "income" | "expense" | "refund" | "transfer";
export type TransactionStatus = "cleared" | "pending";
export type Recurrence = "once" | "weekly" | "monthly" | "yearly";
export type PlannedKind = "income" | "expense";
export type DemoDataState = "empty" | "demo-only" | "real-or-mixed";
export const DEMO_CLEANUP_CONFIRMATION = "DELETE DEMO DATA";

export function canCleanupDemoData(state: DemoDataState): boolean {
  return state === "demo-only";
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balanceCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountReconciliation {
  id: string;
  accountId: string;
  date: string;
  previousBalanceCents: number;
  actualBalanceCents: number;
  differenceCents: number;
  note: string;
  createdAt: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  currency: string;
  description: string;
  kind: TransactionKind;
  status: TransactionStatus;
  source: "manual" | "import" | "planned";
  transferGroupId: string | null;
  plannedTransactionId: string | null;
  correctedFromTransactionId: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedCompletion {
  id: string;
  plannedTransactionId: string;
  originalTransactionId: string;
  correctionTransactionId: string | null;
  occurrenceDate: string;
  completedAt: string;
  adjustedAt: string | null;
  status: "completed" | "undone" | "corrected";
  adjustable: boolean;
  originalTransaction: Transaction;
  effectiveTransaction: Transaction | null;
}

export interface PlannedTransaction {
  id: string;
  accountId: string | null;
  description: string;
  kind: PlannedKind;
  amountCents: number;
  currency: string;
  recurrence: Recurrence;
  intervalCount: number;
  nextDate: string;
  endDate: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Reserve {
  id: string;
  name: string;
  fundedAmountCents: number;
  targetAmountCents: number | null;
  targetDate: string | null;
  contributionMonth: string | null;
  contributedThisMonthCents: number;
  requiredContributionCents: number;
  linkedPlannedTransactionId: string | null;
  currency: string;
  note: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedOccurrence {
  plannedTransactionId: string;
  description: string;
  kind: PlannedKind;
  amountCents: number;
  date: string;
  linkedReserveId: string | null;
  linkedReserveName: string | null;
  linkedGoalCoverageCents: number;
}

export interface DashboardSummary {
  asOfDate: string;
  monthStart: string;
  monthEnd: string;
  currentCashCents: number;
  spentThisMonthCents: number;
  remainingIncomeCents: number;
  remainingExpensesCents: number;
  fundedReservesCents: number;
  requiredGoalContributionsCents: number;
  linkedGoalCoverageCents: number;
  protectedReservesCents: number;
  projectedMonthEndCents: number;
  safeToSpendCents: number;
  upcoming: PlannedOccurrence[];
  projectionMonths: CashFlowProjectionMonth[];
}

/** A deterministic forecast month. Advisory safe-spending guidance is separate. */
export interface CashFlowProjectionMonth {
  monthStart: string;
  monthEnd: string;
  openingCashCents: number;
  expectedIncomeCents: number;
  committedExpensesCents: number;
  monthlyGoalContributionsCents: number;
  protectedReservesCents: number;
  linkedGoalCoverageCents: number;
  projectedMonthEndCents: number;
  availableToSpendCents: number;
  upcoming: PlannedOccurrence[];
}

export interface AppData {
  dashboard: DashboardSummary;
  accounts: Account[];
  accountReconciliations: AccountReconciliation[];
  transactions: Transaction[];
  plannedTransactions: PlannedTransaction[];
  plannedCompletions: PlannedCompletion[];
  reserves: Reserve[];
  demoDataState: DemoDataState;
}
