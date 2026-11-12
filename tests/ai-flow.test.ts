import { Hono } from "npm:hono@4.13.7";
import { describe, expect, it, vi } from "vitest";
import { createAiRoutes, type AiSession } from "../server/ai-routes.ts";
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
  const app = new Hono<{ Variables: { aiSession: AiSession } }>();
  app.use("/api/*", async (c, next) => {
    const username = c.req.header("X-Test-User");
    if (!username) return c.json({ error: "Unauthorized" }, 401);
    if (!isTrustedMutationRequest(c.req.raw)) return c.json({ error: "Invalid request origin" }, 403);
    c.set("aiSession", { username, accessToken: c.req.header("X-Test-Session") ?? "synthetic-owner-session", expiresAt: Number.MAX_SAFE_INTEGER });
    await next();
  });
  app.route("/api/ai", createAiRoutes({ getDashboard, getSigningKeyMaterial: async () => "synthetic-server-only-key-material", advisor }));
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
    const response = await request("advice", { confirmed: true, payload: preview.payload, previewProof: preview.previewProof });
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
    const response = await request("advice", { confirmed: true, payload: preview.payload, previewProof: preview.previewProof });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "disabled" });
  });

  it("rejects absent confirmation, changed schema, raw contamination and noncanonical payload before provider access", async () => {
    const advise = vi.fn<AiAdvisor["advise"]>();
    const { request } = harness({ advise });
    const preview = await (await request("preview", {})).json() as AiPreview;
    const { payload, previewProof } = preview;
    const valid = { confirmed: true, payload, previewProof };
    for (const body of [
      { payload, previewProof }, { ...valid, confirmed: false },
      { ...valid, confirmed: "true" }, { ...valid, extra: "x" },
      { ...valid, payload: "invalid" }, { ...valid, payload: ` ${payload}` },
      { ...valid, payload: JSON.stringify({ ...JSON.parse(payload), merchant: "RAW_SENTINEL" }) },
      { ...valid, payload: JSON.stringify({ ...JSON.parse(payload), schemaVersion: 2 }) },
    ]) expect((await request("advice", body)).status).toBe(400);
    expect(advise).not.toHaveBeenCalled();
  });

  it("rejects unissued, changed, cross-user, cross-session and expired previews", async () => {
    const advise = vi.fn<AiAdvisor["advise"]>();
    const { request } = harness({ advise });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const { payload, previewProof } = await (await request("preview", {})).json() as AiPreview;
      const valid = { confirmed: true, payload, previewProof };
      const changedPayload = JSON.stringify(createRedactedFinancialSnapshot(calculateDashboard({
        asOfDate: "2026-11-14", accounts: [], transactions: [], plannedTransactions: [], reserves: [],
      })));
      expect(changedPayload).not.toBe(payload);
      expect((await request("advice", { confirmed: true, payload })).status).toBe(400);
      expect((await request("advice", { ...valid, payload: changedPayload })).status).toBe(400);
      expect((await request("advice", { ...valid, previewProof: `1800000300000.${"0".repeat(64)}` })).status).toBe(400);
      expect((await request("advice", valid, { "X-Test-User": "another-authorized-user" })).status).toBe(400);
      expect((await request("advice", valid, { "X-Test-Session": "another-synthetic-session" })).status).toBe(400);
      clock.mockReturnValue(1_800_000_300_000);
      expect((await request("advice", valid)).status).toBe(400);
      expect(advise).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
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
    const { payload, previewProof } = await (await request("preview", {})).json() as AiPreview;
    const response = await request("advice", { payload, previewProof, confirmed: true });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(advise).toHaveBeenCalledTimes(1);
  });

  it("never returns raw provider errors", async () => {
    const { request } = harness({ advise: async () => { throw new Error("RAW_PROVIDER_SECRET"); } });
    const { payload, previewProof } = await (await request("preview", {})).json() as AiPreview;
    const response = await request("advice", { payload, previewProof, confirmed: true });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("RAW_PROVIDER_SECRET");
  });
});
