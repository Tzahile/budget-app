import { Hono } from "npm:hono@4.13.7";
import { createRedactedFinancialSnapshot, type AiAdvisor, type RedactedFinancialSnapshot } from "../shared/ai-advisor.ts";
import { AI_DISABLED_REASON, AI_DISCLOSURE, type AiPreview } from "../shared/ai-flow.ts";
import type { DashboardSummary } from "../shared/types.ts";
import { GeminiAdviceError, serializeApprovedSnapshot } from "./gemini-advisor.ts";
import { readJsonObject } from "./security.ts";
import { ValidationError } from "./validation.ts";

export interface AiSession {
  username: string;
  accessToken: string;
  expiresAt: number;
}

const previewLifetimeMs = 5 * 60 * 1000;
const encoder = new TextEncoder();

function signatureData(session: AiSession, origin: string, expiresAt: number, payload: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["budgetapp.ai.preview.v1", origin, session.username, session.accessToken, session.expiresAt, expiresAt, payload]));
}

async function previewSigningKey(keyMaterial: string): Promise<CryptoKey> {
  const scopedMaterial = encoder.encode(JSON.stringify(["budgetapp.ai.preview.key.v1", keyMaterial]));
  const key = await crypto.subtle.digest("SHA-256", scopedMaterial);
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signPreview(key: CryptoKey, session: AiSession, origin: string, payload: string, now: number): Promise<string> {
  const expiresAt = Math.min(now + previewLifetimeMs, session.expiresAt);
  const signature = await crypto.subtle.sign("HMAC", key, signatureData(session, origin, expiresAt, payload));
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${expiresAt}.${hex}`;
}

async function verifyPreview(key: CryptoKey, session: AiSession, origin: string, payload: string, proof: string, now: number): Promise<boolean> {
  const match = /^(\d{1,15})\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt <= now || expiresAt > Math.min(now + previewLifetimeMs, session.expiresAt)) return false;
  const signature = Uint8Array.from(match[2].match(/../g) ?? [], (hex) => Number.parseInt(hex, 16));
  return crypto.subtle.verify("HMAC", key, signature, signatureData(session, origin, expiresAt, payload));
}

/** Mount only behind the application's authentication, origin and security middleware. */
export function createAiRoutes(dependencies: {
  getDashboard: () => Promise<DashboardSummary>;
  getSigningKeyMaterial: (origin: string) => Promise<string>;
  /** Test-only injection until the documented live-provider gate is resolved. */
  advisor?: AiAdvisor;
}) {
  const routes = new Hono<{ Variables: { aiSession: AiSession } }>();
  routes.post("/preview", async (c) => {
    const body = await readJsonObject(c.req.raw);
    if (Object.keys(body).length) throw new ValidationError("AI preview takes no financial input");
    const session = c.get("aiSession");
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const origin = new URL(c.req.url).origin;
    const key = await previewSigningKey(await dependencies.getSigningKeyMaterial(origin));
    const payload = serializeApprovedSnapshot(createRedactedFinancialSnapshot(await dependencies.getDashboard()));
    const preview: AiPreview = {
      payload, previewProof: await signPreview(key, session, origin, payload, Date.now()),
      disclosure: AI_DISCLOSURE,
      available: !!dependencies.advisor,
      disabledReason: dependencies.advisor ? null : AI_DISABLED_REASON,
    };
    return c.json(preview);
  });

  routes.post("/advice", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const session = c.get("aiSession");
    if (!session) return c.json({ error: "Authentication required" }, 401);
    if (Object.keys(body).length !== 3 || body.confirmed !== true || typeof body.payload !== "string" || typeof body.previewProof !== "string") {
      throw new ValidationError("Explicit confirmation and a valid AI preview are required");
    }
    const origin = new URL(c.req.url).origin;
    const key = await previewSigningKey(await dependencies.getSigningKeyMaterial(origin));
    if (!await verifyPreview(key, session, origin, body.payload, body.previewProof, Date.now())) {
      throw new ValidationError("The AI preview is invalid or expired; create a new preview");
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
