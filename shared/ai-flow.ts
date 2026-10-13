import type { AiAdvice } from "./ai-advisor.ts";

export const AI_DISABLED_REASON = "External AI is disabled: Italy rollout requires a compliant provider decision under the current free-only requirement.";
export const AI_DISCLOSURE = "Optional advice from an external AI provider (Google Gemini). Only the JSON shown below would be sent as financial data, with a fixed budgeting instruction. It excludes names, merchants, descriptions, identifiers and notes, but financial aggregates remain sensitive. Advice may be wrong and does not change your accounts, transactions, plans or reserves. Available-to-spend is a calculated fact, not automatically safe-to-spend.";

export interface AiPreview {
  readonly payload: string;
  readonly disclosure: string;
  readonly available: boolean;
  readonly disabledReason: string | null;
}

export interface AiAdviceResponse {
  readonly advice: AiAdvice;
}
