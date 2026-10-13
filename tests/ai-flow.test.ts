import { Hono } from "npm:hono@4.13.7";
import { describe, expect, it, vi } from "vitest";
import { createAiRoutes } from "../server/ai-routes.ts";
import { GeminiAdviceError } from "../server/gemini-advisor.ts";
import { isTrustedMutationRequest, RequestSecurityError } from "../server/security.ts";
import { ValidationError } from "../server/validation.ts";
import { calculateDashboard } from "../shared/finance.ts";
import { createRedactedFinancialSnapshot, type AiAdvisor } from "../shared/ai-advisor.ts";
import type { AiPreview } from "../shared/ai-flow.ts";

const headers = { Origin: "https://budget.example", "X-BudgetApp-Request": "1", "Content-Type": "application/json" };
const dashboard = () => calculateDashboard({ asOfDate: "2026-10-13", accounts: [], transactions: [], plannedTransactions: [], reserves: [] });

function harness(advisor?: AiAdvisor) {
  const getDashboard = vi.fn(async () => dashboard());
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("X-Test-User") !== "owner") return c.json({ error: "Unauthorized" }, 401);
    if (!isTrustedMutationRequest(c.req.raw)) return c.json({ error: "Invalid request origin" }, 403);
    await next();
  });
  app.route("/api/ai", createAiRoutes({ getDashboard, advisor }));
  app.onError((error, c) => {
    if (error instanceof RequestSecurityError) return c.json({ error: error.message }, error.status);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    return c.json({ error: "Unavailable" }, 500);
  });
  const request = (path: string, body: unknown, extra: Record<string, string> = {}) => app.request(`https://budget.example/api/ai/${path}`, {
    method: "POST", headers: { ...headers, "X-Test-User": "owner", ...extra }, body: JSON.stringify(body),
  });
  return { request, getDashboard };
}

describe("explicit AI preview and confirmation", () => {
  it("makes no call at creation or preview, then sends the fixed approved snapshot once", async () => {
    const advise = vi.fn<AiAdvisor["advise"]>(async () => ({ summary: "Synthetic recommendation", considerations: [] }));
    const { request, getDashboard } = harness({ advise });
    expect(advise).not.toHaveBeenCalled();
    expect(getDashboard).not.toHaveBeenCalled();
    const preview = await (await request("preview", {})).json() as AiPreview;
    expect(preview).toMatchObject({ available: true, disabledReason: null });
    expect(preview.payload).toBe(JSON.stringify(createRedactedFinancialSnapshot(dashboard())));
    expect(preview.disclosure).toContain("financial aggregates remain sensitive");
    expect(advise).not.toHaveBeenCalled();
    // Account state could change after preview; send must not recompute the approved data.
    getDashboard.mockRejectedValueOnce(new Error("Dashboard should not be read again"));
    const response = await request("advice", { confirmed: true, payload: preview.payload });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ advice: { summary: "Synthetic recommendation", considerations: [] } });
    expect(advise).toHaveBeenCalledExactlyOnceWith(JSON.parse(preview.payload));
    expect(JSON.stringify(advise.mock.calls[0][0])).toBe(preview.payload);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it("keeps production unavailable even with a valid explicit confirmation", async () => {
    const { request } = harness();
    const preview = await (await request("preview", {})).json() as AiPreview;
    expect(preview).toMatchObject({ available: false });
    expect(preview.disabledReason).toContain("Italy rollout");
    const response = await request("advice", { confirmed: true, payload: preview.payload });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "disabled" });
  });

  it("rejects absent confirmation, changed schema, raw contamination and noncanonical payload before provider access", async () => {
    const advise = vi.fn<AiAdvisor["advise"]>();
    const { request } = harness({ advise });
    const preview = await (await request("preview", {})).json() as AiPreview;
    for (const body of [
      { payload: preview.payload }, { confirmed: false, payload: preview.payload },
      { confirmed: "true", payload: preview.payload }, { confirmed: true, payload: preview.payload, extra: "x" },
      { confirmed: true, payload: "invalid" }, { confirmed: true, payload: ` ${preview.payload}` },
      { confirmed: true, payload: JSON.stringify({ ...JSON.parse(preview.payload), merchant: "RAW_SENTINEL" }) },
      { confirmed: true, payload: JSON.stringify({ ...JSON.parse(preview.payload), schemaVersion: 2 }) },
    ]) expect((await request("advice", body)).status).toBe(400);
    expect(advise).not.toHaveBeenCalled();
  });

  it("applies authentication, origin, JSON and size boundaries before reading finances or calling provider", async () => {
    const advise = vi.fn<AiAdvisor["advise"]>();
    const { request, getDashboard } = harness({ advise });
    for (const path of ["preview", "advice"]) {
      expect((await request(path, {}, { "X-Test-User": "" })).status).toBe(401);
      expect((await request(path, {}, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await request(path, {}, { "X-BudgetApp-Request": "" })).status).toBe(403);
      expect((await request(path, {}, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await request(path, { payload: "x".repeat(33_000) })).status).toBe(413);
    }
    expect((await request("preview", { merchant: "RAW_SENTINEL" })).status).toBe(400);
    expect(getDashboard).not.toHaveBeenCalled();
    expect(advise).not.toHaveBeenCalled();
  });

  it.each([["timeout", 503], ["rate_limit", 429], ["authentication", 503], ["invalid_response", 503]] as const)("returns a safe recoverable %s error without retrying", async (code, status) => {
    const advise = vi.fn<AiAdvisor["advise"]>(async () => { throw new GeminiAdviceError(code); });
    const { request } = harness({ advise });
    const { payload } = await (await request("preview", {})).json() as AiPreview;
    const response = await request("advice", { payload, confirmed: true });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(advise).toHaveBeenCalledTimes(1);
  });

  it("never returns raw provider errors", async () => {
    const { request } = harness({ advise: async () => { throw new Error("RAW_PROVIDER_SECRET"); } });
    const { payload } = await (await request("preview", {})).json() as AiPreview;
    const response = await request("advice", { payload, confirmed: true });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("RAW_PROVIDER_SECRET");
  });
});
