import type { RedactedFinancialSnapshotV1 } from "./ai-advisor.ts";
import { PROJECTION_METRICS, ROOT_METRICS, serializeRedactedSnapshot, type ProjectionMetric, type RootMetric } from "./ai-payload.ts";

export interface MetricDraft { included: boolean; value: string }
export interface AiPayloadDraft {
  readonly original: RedactedFinancialSnapshotV1;
  readonly metrics: Record<RootMetric, MetricDraft>;
  readonly includeProjections: boolean;
  readonly projections: readonly {
    readonly month: string;
    readonly included: boolean;
    readonly metrics: Record<ProjectionMetric, MetricDraft>;
  }[];
}

function metricDraft<K extends string>(keys: readonly K[], source: Record<K, number>): Record<K, MetricDraft> {
  return Object.fromEntries(keys.map((key) => [key, { included: true, value: String(source[key]) }])) as Record<K, MetricDraft>;
}

/** Detached editable values; the original calculated snapshot is never changed. */
export function createAiPayloadDraft(payload: string): AiPayloadDraft {
  const value: unknown = JSON.parse(payload);
  if (serializeRedactedSnapshot(value) !== payload || (value as { schemaVersion: number }).schemaVersion !== 1) throw new Error("Create a new calculated preview before editing");
  const original = value as RedactedFinancialSnapshotV1;
  return {
    original, metrics: metricDraft(ROOT_METRICS, original), includeProjections: true,
    projections: original.projectionMonths.map((projection) => ({ month: projection.month, included: true, metrics: metricDraft(PROJECTION_METRICS, projection) })),
  };
}

/** No coercion of blank strings, decimals, exponents or unsafe integer amounts. */
export function parseEditedCents(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Included amounts must be safe whole integer cents");
  return Number(value);
}

function selected<K extends string>(keys: readonly K[], fields: Record<K, MetricDraft>): Partial<Record<K, number>> {
  return Object.fromEntries(keys.filter((key) => fields[key].included).map((key) => [key, parseEditedCents(fields[key].value)])) as Partial<Record<K, number>>;
}

export function buildAiDraftPayload(draft: AiPayloadDraft): { payload: string; edited: boolean } {
  const values = {
    ...selected(ROOT_METRICS, draft.metrics),
    ...(draft.includeProjections ? { projectionMonths: draft.projections.filter((projection) => projection.included).map((projection) => ({ month: projection.month, ...selected(PROJECTION_METRICS, projection.metrics) })) } : {}),
  };
  const calculated = { schemaVersion: 1, currency: draft.original.currency, asOfMonth: draft.original.asOfMonth, ...values };
  const original = serializeRedactedSnapshot(draft.original);
  if (JSON.stringify(calculated) === original) return { payload: original, edited: false };
  const edited = { schemaVersion: 2, valueOrigin: "user_edited", currency: draft.original.currency, asOfMonth: draft.original.asOfMonth, ...values };
  return { payload: serializeRedactedSnapshot(edited), edited: true };
}

export interface AiEditorState { draft: AiPayloadDraft | null; confirmed: boolean }
export type AiEditorAction =
  | { type: "load"; payload: string }
  | { type: "change"; draft: AiPayloadDraft }
  | { type: "reset" }
  | { type: "confirm"; confirmed: boolean }
  | { type: "clear" };

/** Every edit/reset/load consumes prior consent; confirmation applies only to valid displayed bytes. */
export function aiEditorReducer(state: AiEditorState, action: AiEditorAction): AiEditorState {
  if (action.type === "clear") return { draft: null, confirmed: false };
  if (action.type === "load") return { draft: createAiPayloadDraft(action.payload), confirmed: false };
  if (action.type === "change") return { draft: action.draft, confirmed: false };
  if (action.type === "reset") return { draft: state.draft ? createAiPayloadDraft(serializeRedactedSnapshot(state.draft.original)) : null, confirmed: false };
  if (action.confirmed && state.draft) {
    try { buildAiDraftPayload(state.draft); return { ...state, confirmed: true }; } catch { /* Invalid amounts cannot be approved. */ }
  }
  return { ...state, confirmed: false };
}
