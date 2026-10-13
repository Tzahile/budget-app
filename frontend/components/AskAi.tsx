/** @jsxImportSource https://esm.sh/react@18.2.0 */
import { useState } from "https://esm.sh/react@18.2.0";
import type { AiAdvice } from "../../shared/ai-advisor.ts";
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
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<AiAdvice | null>(null);
  const [error, setError] = useState("");

  async function prepare() {
    setBusy(true); setError(""); setPreview(null); setConfirmed(false); setAdvice(null);
    try { setPreview(await request<AiPreview>("/api/ai/preview", {})); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not prepare AI preview."); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!preview?.available || !confirmed || busy) return;
    setBusy(true); setError(""); setAdvice(null);
    // Consume consent before awaiting, so failures cannot automatically resend.
    setConfirmed(false);
    try {
      const result = await request<AiAdviceResponse>("/api/ai/advice", { payload: preview.payload, confirmed: true });
      setAdvice(result.advice);
    } catch (error) { setError(error instanceof Error ? error.message : "AI advice is unavailable."); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="ask-ai-title" className="mt-7 min-w-0 rounded-2xl border border-stone-200 bg-white p-5">
    <h2 id="ask-ai-title" className="text-lg font-semibold">Optional AI guidance</h2>
    <p className="mt-2 text-sm text-stone-600">Review a redacted snapshot before any external request. Recommendations stay separate from the calculated cash-flow figures.</p>
    <button type="button" disabled={busy} onClick={() => void prepare()} className="mt-4 rounded-xl border border-green-800 px-4 py-3 text-sm font-medium text-green-900 disabled:opacity-50">{busy && !preview ? "Preparing preview…" : "Ask AI: preview data"}</button>
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {preview && <div className="mt-5 min-w-0 border-t border-stone-200 pt-5">
      <h3 className="font-semibold">Review before sending</h3>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">{preview.disclosure}</p>
      <p className="mt-3 text-sm font-medium">Exact outbound financial payload (EUR cents)</p>
      <pre aria-label="Exact outbound financial payload" tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-stone-100 p-3 text-xs leading-relaxed">{preview.payload}</pre>
      {!preview.available && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{preview.disabledReason}</p>}
      <label className="mt-4 flex items-start gap-3 text-sm text-stone-700">
        <input type="checkbox" checked={confirmed} disabled={busy || !preview.available} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" />
        <span>I approve sending exactly this financial payload to Google Gemini for optional advice.</span>
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={busy || !confirmed || !preview.available} onClick={() => void send()} className="rounded-xl bg-green-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? "Requesting advice…" : "Confirm and send to Gemini"}</button>
        <button type="button" disabled={busy} onClick={() => { setPreview(null); setConfirmed(false); setAdvice(null); setError(""); }} className="rounded-xl border border-stone-200 px-4 py-3 text-sm">Cancel</button>
      </div>
      <p className="mt-3 text-xs text-stone-500">This snapshot stays fixed until you create another preview. Cancel closes it without sending.</p>
    </div>}
    {advice && <aside aria-label="AI recommendations" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-semibold text-amber-900">AI recommendations — advisory, not accounting facts</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-amber-900">{advice.summary}</p>
      {advice.considerations.length > 0 && <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-amber-900">{advice.considerations.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul>}
      <p className="mt-3 text-xs text-amber-900">No accounting data was changed. Review the assumptions before acting.</p>
    </aside>}
  </section>;
}
