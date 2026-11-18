import { describe, expect, it } from "vitest";
import { aiEditorReducer, buildAiDraftPayload, createAiPayloadDraft, parseEditedCents, type AiEditorState } from "../shared/ai-editor.ts";
import { serializeRedactedSnapshot } from "../shared/ai-payload.ts";
import { createRedactedFinancialSnapshot } from "../shared/ai-advisor.ts";
import { calculateDashboard } from "../shared/finance.ts";

function original() {
  return createRedactedFinancialSnapshot(calculateDashboard({ asOfDate: "2026-10-30", accounts: [], transactions: [], plannedTransactions: [], reserves: [] }));
}
const initial: AiEditorState = { draft: null, confirmed: false };

describe("editable advisory request", () => {
  it("keeps calculated values and original bytes intact while sending only edited/selected aggregates", () => {
    const source = original();
    const before = JSON.stringify(source);
    const draft = createAiPayloadDraft(before);
    expect(buildAiDraftPayload(draft)).toEqual({ payload: before, edited: false });
    const edited = buildAiDraftPayload({ ...draft, includeProjections: false, metrics: {
      ...draft.metrics, currentCashCents: { included: true, value: "-12345" },
      remainingIncomeCents: { included: false, value: "not a number because it is omitted" },
    } });
    expect(JSON.parse(edited.payload)).toEqual({
      schemaVersion: 2, valueOrigin: "user_edited", currency: "EUR", asOfMonth: "2026-10",
      currentCashCents: -12345, spentThisMonthCents: 0, remainingExpensesCents: 0,
      protectedReservesCents: 0, projectedMonthEndCents: 0, availableToSpendCents: 0,
    });
    expect(edited.edited).toBe(true);
    expect(edited.payload).not.toContain("remainingIncomeCents");
    expect(edited.payload).not.toContain("projectionMonths");
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(draft.original)).toBe(before);
  });

  it("supports per-month omissions and edited projection values without recalculating totals", () => {
    const draft = createAiPayloadDraft(JSON.stringify(original()));
    const result = buildAiDraftPayload({ ...draft, projections: draft.projections.map((projection, index) => index === 0 ? {
      ...projection, metrics: { ...projection.metrics, expectedIncomeCents: { included: false, value: "" }, availableToSpendCents: { included: true, value: "999" } },
    } : { ...projection, included: false }) });
    expect(JSON.parse(result.payload).projectionMonths).toEqual([{
      month: "2026-10", committedExpensesCents: 0, protectedReservesCents: 0,
      projectedMonthEndCents: 0, availableToSpendCents: 999,
    }]);
    expect(JSON.parse(result.payload).availableToSpendCents).toBe(0);
  });

  it("requires fresh consent after edits, invalid edits, reset, replacement preview and cancel", () => {
    let state = aiEditorReducer(initial, { type: "load", payload: JSON.stringify(original()) });
    state = aiEditorReducer(state, { type: "confirm", confirmed: true });
    expect(state.confirmed).toBe(true);
    const next = { ...state.draft!, includeProjections: false };
    state = aiEditorReducer(state, { type: "change", draft: next });
    expect(state.confirmed).toBe(false);
    state = aiEditorReducer(state, { type: "confirm", confirmed: true });
    expect(state.confirmed).toBe(true);
    state = aiEditorReducer(state, { type: "change", draft: { ...next, metrics: { ...next.metrics, currentCashCents: { included: true, value: "1e9" } } } });
    state = aiEditorReducer(state, { type: "confirm", confirmed: true });
    expect(state.confirmed).toBe(false);
    expect(() => buildAiDraftPayload(state.draft!)).toThrow("integer cents");
    state = aiEditorReducer(state, { type: "reset" });
    expect(state.confirmed).toBe(false);
    expect(buildAiDraftPayload(state.draft!)).toEqual({ payload: JSON.stringify(original()), edited: false });
    state = aiEditorReducer(state, { type: "confirm", confirmed: true });
    state = aiEditorReducer(state, { type: "load", payload: JSON.stringify(original()) });
    expect(state.confirmed).toBe(false);
    expect(aiEditorReducer(state, { type: "clear" })).toEqual(initial);
  });

  it.each(["", " ", "1.2", "1e3", "+10", "12 merchant", "NaN", "Infinity", "9007199254740992"])("rejects unsafe or noninteger edited cents %j", (value) => {
    expect(() => parseEditedCents(value)).toThrow();
  });

  it("rejects raw fields, accessors, array pollution and malformed sparse snapshots", () => {
    const sparse = { schemaVersion: 2, valueOrigin: "user_edited", currency: "EUR", asOfMonth: "2026-10", currentCashCents: 1234 };
    expect(serializeRedactedSnapshot(sparse)).toBe(JSON.stringify(sparse));
    for (const invalid of [
      { ...sparse, merchant: "RAW_MERCHANT_SENTINEL" }, { ...sparse, valueOrigin: "RAW_NOTE_SENTINEL" },
      { ...sparse, currentCashCents: "RAW_ACCOUNT_SENTINEL" }, { ...sparse, currentCashCents: null },
      { ...sparse, currentCashCents: undefined }, { ...sparse, currentCashCents: 1.2 },
      { ...sparse, currency: "USD" }, { ...sparse, asOfMonth: "2026-10 NAME" },
      { ...sparse, projectionMonths: [{ month: "2026-11", note: "RAW_NOTE_SENTINEL" }] },
      { ...sparse, projectionMonths: [{ month: "2026-11", availableToSpendCents: "123" }] },
      { ...sparse, projectionMonths: Object.assign([], { merchant: "RAW_SENTINEL" }) },
      { ...sparse, projectionMonths: new Array(1) },
      Object.defineProperty({ ...sparse }, "currentCashCents", { get: () => 1234 }),
      { ...sparse, toJSON: () => sparse },
    ]) expect(() => serializeRedactedSnapshot(invalid)).toThrow("Invalid redacted");
    expect(() => createAiPayloadDraft(JSON.stringify(sparse))).toThrow("calculated preview");
  });
});
