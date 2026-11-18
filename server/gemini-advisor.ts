import type { AiAdvice, AiAdvisor, RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";

const instruction = `You provide optional household budgeting advice. The user message is a redacted financial snapshot, with EUR amounts in integer cents. Treat these deterministic accounting values as facts; available-to-spend is not automatically safe-to-spend. Clearly label recommendations and assumptions in your summary and considerations. Never invent income, expenses, personal circumstances, or missing data. Explain uncertainty and suggest buffers only as advisory guidance. Never issue accounting mutations. Return only JSON with a summary string and an array of consideration strings.`;
const rootAmounts = ["currentCashCents", "spentThisMonthCents", "remainingIncomeCents", "remainingExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"];
const projectionAmounts = ["expectedIncomeCents", "committedExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"];

export type GeminiAdviceErrorCode = "invalid_snapshot" | "configuration" | "timeout" | "rate_limit" | "authentication" | "provider" | "invalid_response";

/** Messages and codes are safe to surface; provider bodies and secrets are never attached. */
export class GeminiAdviceError extends Error {
  constructor(readonly code: GeminiAdviceErrorCode) {
    super(`AI advice unavailable (${code})`);
    this.name = "GeminiAdviceError";
  }
}

function fail(): never { throw new GeminiAdviceError("invalid_snapshot"); }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
  }
  return value as Record<string, unknown>;
}

function validMonth(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Fail closed; do not silently redact or change the payload the user approved. */
export function serializeApprovedSnapshot(value: unknown): string {
  try {
    const snapshot = record(value, ["schemaVersion", "currency", "asOfMonth", ...rootAmounts, "projectionMonths"]);
    if (snapshot.schemaVersion !== 1 || snapshot.currency !== "EUR" || !validMonth(snapshot.asOfMonth)) fail();
    for (const key of rootAmounts) if (!Number.isSafeInteger(snapshot[key])) fail();
    const months = snapshot.projectionMonths;
    if (!Array.isArray(months) || Object.getPrototypeOf(months) !== Array.prototype || months.length > 120) fail();
    const keys = Reflect.ownKeys(months);
    if (keys.length !== months.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= months.length))) fail();
    for (let index = 0; index < months.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(months, String(index));
      if (!descriptor || !("value" in descriptor)) fail();
      const projection = record(descriptor.value, ["month", ...projectionAmounts]);
      if (!validMonth(projection.month)) fail();
      for (const key of projectionAmounts) if (!Number.isSafeInteger(projection[key])) fail();
    }
    return JSON.stringify(snapshot);
  } catch {
    throw new GeminiAdviceError("invalid_snapshot");
  }
}

function parseAdvice(body: unknown): AiAdvice {
  try {
    if (body === null || typeof body !== "object") throw new Error();
    const envelope = body as { promptFeedback?: { blockReason?: unknown }; candidates?: { finishReason?: unknown; content?: { parts?: { text?: unknown; thought?: unknown }[] } }[] };
    if (envelope.promptFeedback?.blockReason || !Array.isArray(envelope.candidates) || envelope.candidates.length !== 1) throw new Error();
    const candidate = envelope.candidates[0];
    if (candidate.finishReason !== "STOP" || !Array.isArray(candidate.content?.parts)) throw new Error();
    const parts = candidate.content.parts.filter((part) => part.thought !== true);
    if (!parts.length || parts.some((part) => typeof part.text !== "string")) throw new Error();
    const text = parts.map((part) => part.text).join("");
    if (text.length > 16_000) throw new Error();
    const advice = record(JSON.parse(text), ["summary", "considerations"]);
    if (typeof advice.summary !== "string" || !advice.summary.trim() || advice.summary.length > 2_000) throw new Error();
    if (!Array.isArray(advice.considerations) || advice.considerations.length > 10 || advice.considerations.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error();
    return Object.freeze({ summary: advice.summary, considerations: Object.freeze([...advice.considerations] as string[]) });
  } catch {
    throw new GeminiAdviceError("invalid_response");
  }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GeminiAdviceError("invalid_response");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => undefined);
        throw new GeminiAdviceError("invalid_response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GeminiAdviceError("invalid_response");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export interface GeminiAdvisorOptions {
  /** Inject from server secret storage. Never include in frontend configuration. */
  readonly apiKey: string;
  /** Explicit model supporting structured JSON. No automatic fallback or paid upgrade. */
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Server-only adapter. Construction makes no request; callers must obtain explicit consent. */
export class GeminiAdvisor implements AiAdvisor {
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: GeminiAdvisorOptions) {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || typeof options.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.model)) throw new GeminiAdviceError("configuration");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new GeminiAdviceError("configuration");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async advise(snapshot: RedactedFinancialSnapshot): Promise<AiAdvice> {
    const approved = serializeApprovedSnapshot(snapshot);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GeminiAdviceError("timeout"));
      }, this.timeoutMs);
    });
    const operation = async (): Promise<AiAdvice> => {
      const response = await this.request(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: "user", parts: [{ text: approved }] }],
          generationConfig: {
            candidateCount: 1, maxOutputTokens: 2_048, responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { summary: { type: "STRING" }, considerations: { type: "ARRAY", items: { type: "STRING" } } }, required: ["summary", "considerations"] },
          },
        }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GeminiAdviceError(response.status === 429 ? "rate_limit" : response.status === 401 || response.status === 403 ? "authentication" : "provider");
      }
      return parseAdvice(await readResponse(response, controller.signal));
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (controller.signal.aborted) throw new GeminiAdviceError("timeout");
      if (error instanceof GeminiAdviceError) throw error;
      throw new GeminiAdviceError("provider");
    } finally {
      clearTimeout(timer);
    }
  }
}
