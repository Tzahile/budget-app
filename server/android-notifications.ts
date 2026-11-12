import { Hono } from "npm:hono@4.13.7";
import { assertSupportedCurrency } from "../shared/currency.ts";
import type { CanonicalTransactionInput } from "./ingestion.ts";
import { db, ensureSchema } from "./db.ts";
import { ingestTransactions } from "./repository.ts";
import { readJsonObject } from "./security.ts";
import { dateField, enumField, objectBody, signedCentsField, stringField, uuidField, ValidationError } from "./validation.ts";

/** Normalized, user-reviewed facts only. Never accept notification text or bank identifiers. */
export interface ReviewedAndroidNotification {
  schemaVersion: 1;
  eventId: string;
  accountId: string;
  date: string;
  amountCents: number;
  currency: "EUR";
  kind: "income" | "expense" | "refund";
}

const eventKeys = ["schemaVersion", "eventId", "accountId", "date", "amountCents", "currency", "kind"];
export const ANDROID_NOTIFICATION_DISCLOSURE = "Notification amounts can be incomplete or duplicated by a statement or bank sync. Verify the account, booked date, signed amount and kind before confirming. This adds one cleared transaction and changes the account balance. Raw notification text stays on the device; no notification is imported automatically.";

export function parseAndroidNotification(value: unknown): ReviewedAndroidNotification {
  const body = objectBody(value);
  if (Object.keys(body).length !== eventKeys.length || Object.keys(body).some((key) => !eventKeys.includes(key)) || body.schemaVersion !== 1) {
    throw new ValidationError("Unsupported notification fields or schema");
  }
  assertSupportedCurrency(body.currency);
  const amountCents = signedCentsField(body, "amountCents");
  const kind = enumField(body, "kind", ["income", "expense", "refund"] as const);
  if (amountCents === 0 || (kind === "expense" ? amountCents > 0 : amountCents < 0)) {
    throw new ValidationError("Notification amount and kind disagree");
  }
  return {
    schemaVersion: 1,
    eventId: uuidField(stringField(body, "eventId", 36), "eventId").toLowerCase(),
    accountId: uuidField(stringField(body, "accountId", 36), "accountId").toLowerCase(),
    date: dateField(body, "date"), amountCents, currency: body.currency, kind,
  };
}

export function normalizeAndroidNotification(value: ReviewedAndroidNotification): CanonicalTransactionInput {
  const event = parseAndroidNotification(value);
  return {
    occurredOn: event.date, amountCents: event.amountCents, currency: event.currency,
    kind: event.kind, status: "cleared", description: `Android notification ${event.kind}`,
    // A delivery ID is not a bank transaction ID and cannot prove economic identity.
    auditMetadata: { adapter: "android_notification", schemaVersion: "1" },
  };
}

async function fingerprint(event: ReviewedAndroidNotification): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function validateAccount(event: ReviewedAndroidNotification): Promise<void> {
  await ensureSchema();
  const result = await db.execute({ sql: "SELECT currency, is_active FROM accounts WHERE id = ?", args: [event.accountId] });
  const account = result.rows[0];
  if (!account || !account.is_active) throw new ValidationError("Choose an active account");
  assertSupportedCurrency(account.currency);
}

/** Mount behind the same OAuth, household allowlist and origin checks as other financial APIs. */
export function createAndroidNotificationRoutes(enabled: () => boolean) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    if (!enabled()) return c.json({ error: "Android notification ingestion is disabled", code: "disabled" }, 503);
    await next();
  });
  routes.post("/preview", async (c) => {
    const body = await readJsonObject(c.req.raw, 2_000);
    if (Object.keys(body).length !== 1 || !("event" in body)) throw new ValidationError("An event is required");
    const event = parseAndroidNotification(body.event);
    await validateAccount(event);
    return c.json({ event, transaction: normalizeAndroidNotification(event), disclosure: ANDROID_NOTIFICATION_DISCLOSURE });
  });
  routes.post("/confirm", async (c) => {
    const body = await readJsonObject(c.req.raw, 2_000);
    if (Object.keys(body).length !== 2 || !("event" in body) || body.confirmed !== true) {
      throw new ValidationError("Explicit confirmation of the reviewed event is required");
    }
    const event = parseAndroidNotification(body.event);
    const result = await ingestTransactions({
      accountId: event.accountId, source: "android_notification", filename: "Android notification",
      retryKey: event.eventId, retryFingerprint: await fingerprint(event),
      transactions: [normalizeAndroidNotification(event)],
    });
    return c.json(result, result.replayed ? 200 : 201);
  });
  return routes;
}
