/** @jsxImportSource https://esm.sh/react@18.2.0 */
import { useReducer, useState } from "https://esm.sh/react@18.2.0";
import type { AiAdvice } from "../../shared/ai-advisor.ts";
import { aiEditorReducer, buildAiDraftPayload, type AiPayloadDraft, type MetricDraft } from "../../shared/ai-editor.ts";
import { PROJECTION_METRICS, ROOT_METRICS } from "../../shared/ai-payload.ts";
import type { AiAdviceResponse, AiPreview } from "../../shared/ai-flow.ts";

export async function aiRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-BudgetApp-Request": "1" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? "AI advice is unavailable; try again later.");
  return result as T;
}

/** No mount/load effect: both preview and external send require separate actions. */
export function AskAi({ request = aiRequest }: { request?: typeof aiRequest }) {
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const [editor, dispatch] = useReducer(aiEditorReducer, { draft: null, confirmed: false });
  const { draft, confirmed } = editor;
  let outbound: ReturnType<typeof buildAiDraftPayload> | null = null;
  let draftError = "";
  try { if (draft) outbound = buildAiDraftPayload(draft); }
  catch { draftError = "Included amounts must be safe whole integer cents. Correct the highlighted input or omit it before sending."; }
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<AiAdvice | null>(null);
  const [error, setError] = useState("");

  async function prepare() {
    setBusy(true); setError(""); setPreview(null); dispatch({ type: "clear" }); setAdvice(null);
    try {
      const result = await request<AiPreview>("/api/ai/preview", {});
      dispatch({ type: "load", payload: result.payload });
      setPreview(result);
    }
    catch (error) { setError(error instanceof Error ? error.message : "Could not prepare AI preview."); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!preview?.available || !confirmed || !outbound || busy) return;
    setBusy(true); setError(""); setAdvice(null);
    // Consume consent before awaiting, so failures cannot automatically resend.
    dispatch({ type: "confirm", confirmed: false });
    try {
      const result = await request<AiAdviceResponse>("/api/ai/advice", { payload: outbound.payload, confirmed: true });
      setAdvice(result.advice);
    } catch (error) { setError(error instanceof Error ? error.message : "AI advice is unavailable."); }
    finally { setBusy(false); }
  }

  function edit(next: AiPayloadDraft) {
    dispatch({ type: "change", draft: next }); setAdvice(null); setError("");
  }

  return <section aria-labelledby="ask-ai-title" className="mt-7 min-w-0 rounded-2xl border border-stone-200 bg-white p-5">
    <h2 id="ask-ai-title" className="text-lg font-semibold">Optional AI guidance</h2>
    <p className="mt-2 text-sm text-stone-600">Review a redacted snapshot before any external request. Recommendations stay separate from the calculated cash-flow figures.</p>
    <button type="button" disabled={busy} onClick={() => void prepare()} className="mt-4 rounded-xl border border-green-800 px-4 py-3 text-sm font-medium text-green-900 disabled:opacity-50">{busy && !preview ? "Preparing preview…" : "Ask AI: preview data"}</button>
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {preview && draft && <div className="mt-5 min-w-0 border-t border-stone-200 pt-5">
      <h3 className="font-semibold">Review before sending</h3>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">{preview.disclosure}</p>
      <details className="mt-4 min-w-0 rounded-xl border border-stone-200 p-3">
        <summary className="cursor-pointer font-medium">Adjust or omit advisory values</summary>
        <p className="mt-2 text-sm text-stone-600">Amounts are whole EUR cents (100 = €1). These edits apply only to this request. Calculated balances stay unchanged; omitted values are unknown to the advisor. Related totals are not recalculated.</p>
        <fieldset disabled={busy} className="mt-4 min-w-0 space-y-3">
          <legend className="text-sm font-semibold">Current month: {draft.original.asOfMonth}</legend>
          {ROOT_METRICS.map((key) => <MetricControl key={key} label={metricLabels[key]} value={draft.metrics[key]} calculated={draft.original[key]} onChange={(value) => edit({ ...draft, metrics: { ...draft.metrics, [key]: value } })} />)}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.includeProjections} onChange={(event) => edit({ ...draft, includeProjections: event.target.checked })} className="mt-1 h-4 w-4 shrink-0" /><span>Include month projections</span></label>
          {draft.includeProjections && draft.projections.map((projection, index) => <details key={index} className="min-w-0 rounded-lg border border-stone-200 p-3">
            <summary className="cursor-pointer text-sm font-medium">Projection: {projection.month}</summary>
            <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={projection.included} onChange={(event) => edit({ ...draft, projections: draft.projections.map((item, position) => position === index ? { ...item, included: event.target.checked } : item) })} className="mt-1 h-4 w-4 shrink-0" /><span>Include {projection.month}</span></label>
            {projection.included && <div className="mt-3 space-y-3">{PROJECTION_METRICS.map((key) => <MetricControl key={key} label={`${projection.month} ${metricLabels[key]}`} value={projection.metrics[key]} calculated={draft.original.projectionMonths[index][key]} onChange={(value) => edit({ ...draft, projections: draft.projections.map((item, position) => position === index ? { ...item, metrics: { ...item.metrics, [key]: value } } : item) })} />)}</div>}
          </details>)}
          <button type="button" onClick={() => { dispatch({ type: "reset" }); setAdvice(null); setError(""); }} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">Reset to calculated values</button>
        </fieldset>
      </details>
      <p role="status" className="mt-3 text-sm font-medium">{!outbound ? "Payload invalid: correct or omit included values before approval." : outbound.edited ? "Edited advisory assumptions: these are not calculated accounting facts." : "Calculated snapshot: no advisory values changed."}</p>
      {draftError && <p role="alert" className="mt-3 text-sm text-red-800">{draftError}</p>}
      <p className="mt-3 text-sm font-medium">Exact outbound financial payload (EUR cents)</p>
      {outbound && <pre aria-label="Exact outbound financial payload" tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-stone-100 p-3 text-xs leading-relaxed">{outbound.payload}</pre>}
      <details className="mt-3 min-w-0 text-sm"><summary className="cursor-pointer">Original calculated snapshot</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-stone-100 p-3 text-xs">{preview.payload}</pre></details>
      {!preview.available && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{preview.disabledReason}</p>}
      <label className="mt-4 flex items-start gap-3 text-sm text-stone-700">
        <input type="checkbox" checked={confirmed} disabled={busy || !preview.available || !outbound} onChange={(event) => dispatch({ type: "confirm", confirmed: event.target.checked })} className="mt-1 h-4 w-4 shrink-0" />
        <span>I approve sending exactly this financial payload to Google Gemini for optional advice.</span>
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={busy || !confirmed || !preview.available || !outbound} onClick={() => void send()} className="rounded-xl bg-green-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? "Requesting advice…" : "Confirm and send to Gemini"}</button>
        <button type="button" disabled={busy} onClick={() => { setPreview(null); dispatch({ type: "clear" }); setAdvice(null); setError(""); }} className="rounded-xl border border-stone-200 px-4 py-3 text-sm">Cancel</button>
      </div>
      <p className="mt-3 text-xs text-stone-500">Every edit or reset clears approval and previous advice. Cancel closes this request without sending.</p>
    </div>}
    {advice && <aside aria-label="AI recommendations" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-semibold text-amber-900">AI recommendations — advisory, not accounting facts</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-amber-900">{advice.summary}</p>
      {advice.considerations.length > 0 && <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-amber-900">{advice.considerations.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul>}
      {outbound?.edited && <p className="mt-3 text-sm font-medium text-amber-900">Based on edited advisory assumptions, not verified accounting facts.</p>}
      <p className="mt-3 text-xs text-amber-900">No accounting data was changed. Review the assumptions before acting.</p>
    </aside>}
  </section>;
}

const metricLabels: Record<string, string> = {
  currentCashCents: "Current cash", spentThisMonthCents: "Spent this month",
  remainingIncomeCents: "Remaining income", remainingExpensesCents: "Remaining commitments",
  protectedReservesCents: "Protected reserves", projectedMonthEndCents: "Projected month-end",
  availableToSpendCents: "Available to spend", expectedIncomeCents: "Expected income",
  committedExpensesCents: "Committed expenses",
};

function MetricControl({ label, value, calculated, onChange }: {
  label: string; value: MetricDraft; calculated: number; onChange: (value: MetricDraft) => void;
}) {
  const valid = /^-?\d+$/.test(value.value) && Number.isSafeInteger(Number(value.value));
  const changed = value.included && valid && Number(value.value) !== calculated;
  return <div className="min-w-0 rounded-lg bg-stone-50 p-3">
    <label className="flex items-start gap-2 text-sm font-medium"><input type="checkbox" checked={value.included} onChange={(event) => onChange({ ...value, included: event.target.checked })} className="mt-1 h-4 w-4 shrink-0" /><span>Include {label}</span></label>
    <label className="mt-2 block text-sm">{label} (integer cents)<input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={17} value={value.value} disabled={!value.included} aria-invalid={value.included && !valid} onChange={(event) => onChange({ ...value, value: event.target.value })} className="mt-1 block w-full min-w-0 rounded-lg border border-stone-300 p-2 disabled:opacity-50" /></label>
    <p className="mt-1 text-xs text-stone-600">Calculated: {calculated} cents. {!value.included ? "Omitted from this request." : !valid ? "Invalid integer cents." : changed ? "Edited assumption." : "Matches calculated value."}</p>
  </div>;
}
