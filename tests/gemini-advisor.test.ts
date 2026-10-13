import { describe, expect, it, vi } from "vitest";
import { GeminiAdvisor, serializeApprovedSnapshot } from "../server/gemini-advisor.ts";
import type { RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";

function snapshot(): RedactedFinancialSnapshot {
  return {
    schemaVersion: 1, currency: "EUR", asOfMonth: "2026-10",
    currentCashCents: 100_000, spentThisMonthCents: 20_000, remainingIncomeCents: 50_000,
    remainingExpensesCents: 30_000, protectedReservesCents: 10_000,
    projectedMonthEndCents: 120_000, availableToSpendCents: 110_000,
    projectionMonths: [{ month: "2026-10", expectedIncomeCents: 50_000, committedExpensesCents: 30_000,
      protectedReservesCents: 10_000, projectedMonthEndCents: 120_000, availableToSpendCents: 110_000 }],
  };
}

const advice = { summary: "Recommendation: keep a buffer.", considerations: ["Assumption: future income is uncertain."] };
function envelope(text = JSON.stringify(advice), finishReason = "STOP") {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }] };
}
function mocked(body: unknown = envelope(), status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}
function advisor(request: typeof fetch, timeoutMs = 15_000) {
  return new GeminiAdvisor({ apiKey: "SYNTHETIC_TEST_KEY", model: "synthetic-model", fetch: request, timeoutMs });
}

describe("server-only Gemini advisor", () => {
  it("sends exactly the approved snapshot and fixed instructions, with key in a header", async () => {
    const request = mocked();
    const adapter = advisor(request);
    expect(request).not.toHaveBeenCalled();
    const input = snapshot();
    const before = JSON.stringify(input);
    expect(await adapter.advise(input)).toEqual(advice);
    expect(JSON.stringify(input)).toBe(before);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/synthetic-model:generateContent");
    expect(url).not.toContain("SYNTHETIC_TEST_KEY");
    expect(init?.headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": "SYNTHETIC_TEST_KEY" });
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(init!.body as string);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: before }] }]);
    expect(body.systemInstruction.parts[0].text).toContain("available-to-spend is not automatically safe-to-spend");
    expect(body.systemInstruction.parts[0].text).toContain("assumptions");
    expect(body.systemInstruction.parts[0].text).toContain("Never invent");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body).not.toHaveProperty("tools");
  });

  it.each([
    (s: ReturnType<typeof snapshot>) => ({ ...s, merchant: "RAW_MERCHANT_SENTINEL" }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, projectionMonths: [{ ...s.projectionMonths[0], accountId: "RAW_ACCOUNT_SENTINEL" }] }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, currentCashCents: { amount: 12, note: "RAW_NOTE_SENTINEL" } }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, schemaVersion: 2 }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, currency: "USD" }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, asOfMonth: "2026-13" }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, currentCashCents: 1.2 }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, currentCashCents: Number.MAX_SAFE_INTEGER + 1 }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, projectionMonths: [{ ...s.projectionMonths[0], month: "2026-10-01" }] }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, projectionMonths: Object.assign([...s.projectionMonths], { note: "RAW_NOTE_SENTINEL" }) }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, projectionMonths: new Array(1) }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, toJSON: () => ({ note: "RAW_SENTINEL" }) }),
    (s: ReturnType<typeof snapshot>) => Object.defineProperty(s, "currentCashCents", { get: () => 10 }),
  ])("rejects contaminated or malformed input before network access (%#)", async (contaminate) => {
    const request = mocked();
    await expect(advisor(request).advise(contaminate(snapshot()) as unknown as RedactedFinancialSnapshot)).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves negative integer metrics and frozen snapshot serialization", () => {
    const input = { ...snapshot(), currentCashCents: -10_000 };
    expect(serializeApprovedSnapshot(Object.freeze(input))).toBe(JSON.stringify(input));
  });

  it.each([[429, "rate_limit"], [401, "authentication"], [403, "authentication"], [500, "provider"]])("handles HTTP %s without exposing raw error details or retrying", async (status, code) => {
    const request = mocked({ error: { message: "RAW_PROVIDER_SENTINEL SYNTHETIC_TEST_KEY" } }, status as number);
    await expect(advisor(request).advise(snapshot())).rejects.toMatchObject({ code, message: `AI advice unavailable (${code})` });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { promptFeedback: { blockReason: "SAFETY" }, ...envelope() },
    envelope("{}", "SAFETY"), envelope(JSON.stringify(advice), "MAX_TOKENS"),
    envelope("not JSON"), envelope("```json\n{}\n```"),
    envelope(JSON.stringify({ ...advice, command: "change-balance" })),
    envelope(JSON.stringify({ ...advice, summary: " " })),
    envelope(JSON.stringify({ ...advice, summary: "x".repeat(2_001) })),
    envelope(JSON.stringify({ ...advice, considerations: Array(11).fill("x") })),
    envelope(JSON.stringify({ ...advice, considerations: ["x".repeat(1_001)] })),
    envelope(JSON.stringify({ ...advice, considerations: [42] })),
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}", thought: true }] } }] },
  ])("rejects malformed, refused, truncated or unbounded advice (%#)", async (body) => {
    await expect(advisor(mocked(body)).advise(snapshot())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sanitizes network failures and invalid response JSON", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("RAW_PROVIDER_SENTINEL"); });
    await expect(advisor(request).advise(snapshot())).rejects.toMatchObject({ code: "provider", message: "AI advice unavailable (provider)" });
    await expect(advisor(async () => new Response("invalid json")).advise(snapshot())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds the entire response body and discards provider thought parts", async () => {
    await expect(advisor(async () => new Response("x".repeat(65_537))).advise(snapshot())).rejects.toMatchObject({ code: "invalid_response" });
    const body = { candidates: [{ finishReason: "STOP", content: { parts: [
      { thought: true, text: "Synthetic internal thought" }, { text: JSON.stringify(advice) },
    ] } }] };
    expect(await advisor(mocked(body)).advise(snapshot())).toEqual(advice);
  });

  it("times out both fetch and stalled body reads, aborting without retry", async () => {
    for (const bodyStalls of [false, true]) {
      const request = vi.fn<typeof fetch>(async () => {
        if (!bodyStalls) return await new Promise<Response>(() => undefined);
        return new Response(new ReadableStream({ start() {} }));
      });
      await expect(advisor(request, 5).advise(snapshot())).rejects.toMatchObject({ code: "timeout" });
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("requires explicit server credentials, a safe model and bounded timeout", () => {
    for (const options of [
      { apiKey: "", model: "synthetic" }, { apiKey: "x", model: "" },
      { apiKey: "x", model: "../paid-model" }, { apiKey: "x\nsecret", model: "synthetic" },
      { apiKey: "x", model: "synthetic", timeoutMs: 0 },
    ]) expect(() => new GeminiAdvisor(options)).toThrow("configuration");
  });
});
