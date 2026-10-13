import type { AiAdvice, AiAdvisor, RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";

export type AiAdvisorErrorCode = "missing_configuration" | "invalid_snapshot" | "timeout" | "rate_limited" | "provider_error" | "invalid_response";

/** Safe to display; never retains provider bodies, credentials, or transport errors. */
export class AiAdvisorError extends Error {
  constructor(readonly code: AiAdvisorErrorCode) {
    super(`AI advice unavailable: ${code}`);
    this.name = "AiAdvisorError";
  }
}

const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const moneyKeys = ["currentCashCents", "spentThisMonthCents", "remainingIncomeCents", "remainingExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"] as const;
const projectionKeys = ["expectedIncomeCents", "committedExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
}

function validMonth(value: unknown): boolean {
  return typeof value === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Revalidate at the network boundary: TypeScript types are not a runtime allowlist. */
function snapshotJson(snapshot: unknown): string {
  if (!record(snapshot) || !exactKeys(snapshot, ["schemaVersion", "currency", "asOfMonth", ...moneyKeys, "projectionMonths"]) ||
    snapshot.schemaVersion !== 1 || snapshot.currency !== "EUR" || !validMonth(snapshot.asOfMonth) ||
    !moneyKeys.every((key) => Number.isSafeInteger(snapshot[key])) || !Array.isArray(snapshot.projectionMonths) ||
    snapshot.projectionMonths.length > 120) throw new AiAdvisorError("invalid_snapshot");
  const projections: Record<string, unknown>[] = [];
  for (let index = 0; index < snapshot.projectionMonths.length; index++) {
    const projection: unknown = snapshot.projectionMonths[index];
    if (!record(projection) || !exactKeys(projection, ["month", ...projectionKeys]) || !validMonth(projection.month) ||
      !projectionKeys.every((key) => Number.isSafeInteger(projection[key]))) throw new AiAdvisorError("invalid_snapshot");
    projections.push(Object.fromEntries(["month", ...projectionKeys].map((key) => [key, projection[key]])));
  }
  // Detached plain objects also prevent array/custom serialization hooks from entering egress.
  return JSON.stringify({
    schemaVersion: 1, currency: "EUR", asOfMonth: snapshot.asOfMonth,
    ...Object.fromEntries(moneyKeys.map((key) => [key, snapshot[key]])), projectionMonths: projections,
  });
}

const instructions = `You provide optional household cash-flow guidance, never accounting decisions.
The user payload contains only deterministic aggregate facts in integer EUR cents and months.
Do not recalculate or alter those facts. Available-to-spend is NOT safe-to-spend.
Suggest conservative buffers or safe spending only as advisory estimates, explaining assumptions,
uncertainty and missing income stability/history data in considerations. Never invent transactions,
merchants, personal circumstances or records. Do not give commands to mutate balances, reserves or plans.
Return only a JSON object with summary (plain text, at most 2000 characters) and considerations
(at most 10 plain-text strings, each at most 1000 characters).`;

function parseAdvice(value: unknown): AiAdvice {
  if (!record(value) || (record(value.promptFeedback) && value.promptFeedback.blockReason) || !Array.isArray(value.candidates) || value.candidates.length !== 1) throw new AiAdvisorError("invalid_response");
  const candidate: unknown = value.candidates[0];
  if (!record(candidate) || candidate.finishReason !== "STOP" || !record(candidate.content) || !Array.isArray(candidate.content.parts)) throw new AiAdvisorError("invalid_response");
  const parts = candidate.content.parts as unknown[];
  if (parts.length !== 1 || !record(parts[0]) || !exactKeys(parts[0], ["text"]) || typeof parts[0].text !== "string" || parts[0].text.length > 16_000) throw new AiAdvisorError("invalid_response");
  let advice: unknown;
  try { advice = JSON.parse(parts[0].text); } catch { throw new AiAdvisorError("invalid_response"); }
  if (!record(advice) || !exactKeys(advice, ["summary", "considerations"]) || typeof advice.summary !== "string" || !advice.summary.trim() || advice.summary.length > 2000 ||
    !Array.isArray(advice.considerations) || advice.considerations.length > 10 || !advice.considerations.every((item: unknown) => typeof item === "string" && item.trim().length > 0 && item.length <= 1000)) throw new AiAdvisorError("invalid_response");
  return Object.freeze({ summary: advice.summary, considerations: Object.freeze([...advice.considerations] as string[]) });
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new AiAdvisorError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => {});
        throw new AiAdvisorError("invalid_response");
      }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AiAdvisorError("invalid_response"); }
}

/** Server-only adapter; deliberately unwired until the explicit payload-confirmation flow (#36). */
export class GeminiAiAdvisor implements AiAdvisor {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: { apiKey: string; fetcher?: typeof fetch; timeoutMs?: number }) {
    if (typeof config.apiKey !== "string" || !config.apiKey.trim()) throw new AiAdvisorError("missing_configuration");
    this.apiKey = config.apiKey;
    this.fetcher = config.fetcher ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) throw new AiAdvisorError("missing_configuration");
  }

  async advise(snapshot: RedactedFinancialSnapshot): Promise<AiAdvice> {
    let payload: string;
    try { payload = snapshotJson(snapshot); } catch { throw new AiAdvisorError("invalid_snapshot"); }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AiAdvisorError("timeout")); }, this.timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetcher(endpoint, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: "user", parts: [{ text: payload }] }],
            generationConfig: {
              temperature: 0.2, candidateCount: 1, maxOutputTokens: 2048,
              thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT", required: ["summary", "considerations"],
                properties: { summary: { type: "STRING" }, considerations: { type: "ARRAY", items: { type: "STRING" }, maxItems: 10 } },
              },
            },
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new AiAdvisorError(response.status === 429 ? "rate_limited" : "provider_error");
        }
        return parseAdvice(await readResponse(response, controller.signal));
      })()]);
    } catch (error) {
      if (error instanceof AiAdvisorError) throw error;
      throw new AiAdvisorError(controller.signal.aborted ? "timeout" : "provider_error");
    } finally { clearTimeout(timer); }
  }
}
