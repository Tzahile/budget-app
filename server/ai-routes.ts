import { Hono } from "npm:hono@4.13.7";
import { createRedactedFinancialSnapshot, type AiAdvisor, type RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";
import { AI_DISABLED_REASON, AI_DISCLOSURE, type AiPreview } from "../shared/ai-flow.ts";
import type { DashboardSummary } from "../shared/types.ts";
import { GeminiAdviceError, serializeApprovedSnapshot } from "./gemini-advisor.ts";
import { readJsonObject } from "./security.ts";
import { ValidationError } from "./validation.ts";

/** Mount only behind the application's authentication, origin and security middleware. */
export function createAiRoutes(dependencies: {
  getDashboard: () => Promise<DashboardSummary>;
  /** Test-only injection until the documented live-provider gate is resolved. */
  advisor?: AiAdvisor;
}) {
  const routes = new Hono();
  routes.post("/preview", async (c) => {
    const body = await readJsonObject(c.req.raw);
    if (Object.keys(body).length) throw new ValidationError("AI preview takes no financial input");
    const snapshot = createRedactedFinancialSnapshot(await dependencies.getDashboard());
    const preview: AiPreview = {
      payload: serializeApprovedSnapshot(snapshot), disclosure: AI_DISCLOSURE,
      available: !!dependencies.advisor,
      disabledReason: dependencies.advisor ? null : AI_DISABLED_REASON,
    };
    return c.json(preview);
  });

  routes.post("/advice", async (c) => {
    const body = await readJsonObject(c.req.raw);
    if (Object.keys(body).length !== 2 || body.confirmed !== true || typeof body.payload !== "string") {
      throw new ValidationError("Explicit confirmation and the preview payload are required");
    }
    let snapshot: RedactedFinancialSnapshot;
    try {
      snapshot = JSON.parse(body.payload) as RedactedFinancialSnapshot;
      if (serializeApprovedSnapshot(snapshot) !== body.payload) throw new Error();
    } catch {
      throw new ValidationError("The approved AI payload is invalid; create a new preview");
    }
    // Production never injects a provider: no environment flag, key or billing fallback.
    if (!dependencies.advisor) return c.json({ error: AI_DISABLED_REASON, code: "disabled" }, 503);
    try {
      // Deliberately send the confirmed snapshot, never fresh dashboard data.
      return c.json({ advice: await dependencies.advisor.advise(snapshot) });
    } catch (error) {
      const code = error instanceof GeminiAdviceError ? error.code : "provider";
      const message = code === "rate_limit" ? "AI rate limit reached; try again later." :
        code === "timeout" ? "AI request timed out; try again later." : "AI advice is unavailable; try again later.";
      return c.json({ error: message, code }, code === "rate_limit" ? 429 : 503);
    }
  });
  return routes;
}
