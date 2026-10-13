import { describe, expect, it, vi } from "vitest";
import { AiAdvisorError, GeminiAiAdvisor } from "../server/gemini-advisor.ts";
import type { RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";

const snapshot: RedactedFinancialSnapshot = {
  schemaVersion: 1, currency: "EUR", asOfMonth: "2026-10", currentCashCents: 200_000,
  spentThisMonthCents: 30_000, remainingIncomeCents: 100_000, remainingExpensesCents: 70_000,
  protectedReservesCents: 50_000, projectedMonthEndCents: 230_000, availableToSpendCents: 180_000,
  projectionMonths: [{ month: "2026-11", expectedIncomeCents: 100_000, committedExpensesCents: 70_000,
    protectedReservesCents: 50_000, projectedMonthEndCents: 260_000, availableToSpendCents: 210_000 }],
};
const apiKey = "SYNTHETIC_KEY_SENTINEL";
const advice = { summary: "Keep a conservative buffer.", considerations: ["Income stability is unknown; this is an estimate."] };
const result = (text: unknown = advice, finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(text) }] } }],
});
const reply = (body: unknown = result(), status = 200) => new Response(JSON.stringify(body), { status });

function provider(fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply()), timeoutMs = 1000) {
  return { fetcher, adapter: new GeminiAiAdvisor({ apiKey, fetcher, timeoutMs }) };
}

describe("server Gemini advice adapter", () => {
  it("sends only redacted facts and fixed instructions, returns detached advisory text", async () => {
    const { adapter, fetcher } = provider();
    const before = JSON.stringify(snapshot);
    expect(await adapter.advise(snapshot)).toEqual(advice);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(String(url)).not.toContain(apiKey);
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": apiKey });
    const body = JSON.parse(String(options?.body));
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual(snapshot);
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(body.systemInstruction.parts[0].text).toContain("Available-to-spend is NOT safe-to-spend");
    expect(body.systemInstruction.parts[0].text).toContain("Never invent transactions");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it.each([
    { ...snapshot, iban: "PRIVATE_IBAN_SENTINEL" },
    { ...snapshot, currentCashCents: 1.5 },
    { ...snapshot, remainingIncomeCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, asOfMonth: "2026-10 PRIVATE_NAME" },
    { ...snapshot, asOfMonth: "2026-13" },
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, currency: "USD" },
    { ...snapshot, projectionMonths: [{ ...snapshot.projectionMonths[0], note: "PRIVATE_MERCHANT" }] },
    { ...snapshot, projectionMonths: [{ ...snapshot.projectionMonths[0], expectedIncomeCents: NaN }] },
    { ...snapshot, projectionMonths: Array(121).fill(snapshot.projectionMonths[0]) },
    { ...snapshot, projectionMonths: Array(1) },
    { ...snapshot, toJSON: () => ({ name: "PRIVATE_NAME" }) },
  ])("rejects malformed/contaminated snapshots before any egress", async (input) => {
    const { adapter, fetcher } = provider();
    await expect(adapter.advise(input as RedactedFinancialSnapshot)).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reconstructs arrays rather than forwarding their custom serializer", async () => {
    const months = [...snapshot.projectionMonths];
    Object.assign(months, { toJSON: () => [{ merchant: "PRIVATE_MERCHANT" }], map: () => ({ toJSON: () => ({ merchant: "PRIVATE_MERCHANT" }) }) });
    const { adapter, fetcher } = provider();
    await adapter.advise({ ...snapshot, projectionMonths: months });
    expect(String(fetcher.mock.calls[0]![1]?.body)).not.toContain("PRIVATE_MERCHANT");
  });

  it.each([429, 400, 401, 403, 500, 503])("sanitizes HTTP %i without propagating a provider body", async (status) => {
    const { adapter } = provider(vi.fn<typeof fetch>().mockResolvedValue(reply({ error: `${apiKey} PRIVATE_RECORD` }, status)));
    await expect(adapter.advise(snapshot)).rejects.toEqual(new AiAdvisorError(status === 429 ? "rate_limited" : "provider_error"));
  });

  it("sanitizes transport errors", async () => {
    const { adapter } = provider(vi.fn<typeof fetch>().mockRejectedValue(new Error(`${apiKey} PRIVATE_RECORD`)));
    await expect(adapter.advise(snapshot)).rejects.toEqual(new AiAdvisorError("provider_error"));
  });

  it.each([
    {}, { promptFeedback: { blockReason: "SAFETY" }, ...result() }, result(advice, "MAX_TOKENS"),
    result(advice, "SAFETY"), result({ ...advice, transaction: {} }), result({ summary: "", considerations: [] }),
    result({ summary: "x".repeat(2001), considerations: [] }), result({ ...advice, considerations: ["x".repeat(1001)] }),
    result({ ...advice, considerations: Array(11).fill("x") }), result({ ...advice, considerations: [42] }),
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not JSON" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(advice), thought: true }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(advice), functionCall: { name: "mutate" } }] } }] },
    { candidates: [result().candidates[0], result().candidates[0]] },
  ])("rejects blocked, truncated and invalid advice", async (body) => {
    const { adapter } = provider(vi.fn<typeof fetch>().mockResolvedValue(reply(body)));
    await expect(adapter.advise(snapshot)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects invalid envelope JSON and oversized responses", async () => {
    for (const body of ["invalid", "x".repeat(65_537)]) {
      const { adapter } = provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
      await expect(adapter.advise(snapshot)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("times out a pending fetch and aborts its signal", async () => {
    const { adapter, fetcher } = provider(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})), 5);
    await expect(adapter.advise(snapshot)).rejects.toMatchObject({ code: "timeout" });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("keeps the deadline active while waiting for the response body", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const { adapter, fetcher } = provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)), 5);
    await expect(adapter.advise(snapshot)).rejects.toMatchObject({ code: "timeout" });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(body.locked).toBe(false);
  });

  it("fails closed without a secret or with invalid deadlines", () => {
    expect(() => new GeminiAiAdvisor({ apiKey: " " })).toThrow(new AiAdvisorError("missing_configuration"));
    expect(() => new GeminiAiAdvisor({ apiKey, timeoutMs: 0 })).toThrow(new AiAdvisorError("missing_configuration"));
  });
});
