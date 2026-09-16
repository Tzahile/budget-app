// Val Town infers the HTTP trigger from the `.http.ts` filename.
import { Hono } from "npm:hono@4.13.7";
import { getOAuthUserData, oauthMiddleware } from "https://esm.town/v/std/oauth/middleware.ts";
import { parseVal, serveImmutableFile } from "https://esm.town/v/std/utils/index.ts";
import { assertDateOnly, householdDate } from "./shared/finance.ts";
import { Root } from "./frontend/root.tsx";
import {
  completePlanned,
  cleanupDemoData,
  correctPlannedCompletion,
  createAccount,
  createPlanned,
  createReserve,
  createTransaction,
  deleteAccount,
  deletePlanned,
  deleteReserve,
  deleteTransaction,
  deactivatePlanned,
  getAppData,
  reconcileAccount,
  seedDemoData,
  updateAccount,
  updatePlanned,
  updateReserve,
  updateTransaction,
  undoPlannedCompletion,
} from "./server/repository.ts";
import { DEMO_CLEANUP_CONFIRMATION } from "./shared/types.ts";
import {
  booleanField,
  centsField,
  dateField,
  enumField,
  exactStringField,
  integerField,
  objectBody,
  optionalString,
  signedCentsField,
  stringField,
  uuidField,
  ValidationError,
} from "./server/validation.ts";

const app = new Hono();

app.get("/", (c) => c.html(Root()));
app.get("/__immutable/*", (c) => serveImmutableFile(c.req.path));
app.get("/source", (c) => c.redirect(parseVal(import.meta.url).links.self.val));

app.get("/api/session", async (c) => {
  const session = await getOAuthUserData(c.req.raw);
  if (!session?.user) return c.json({ authenticated: false, authorized: false });
  return c.json({
    authenticated: true,
    authorized: isAuthorized(session.user.username),
    username: session.user.username,
  });
});

app.use("/api/*", async (c, next) => {
  const session = await getOAuthUserData(c.req.raw);
  if (!session?.user) return c.json({ error: "Authentication required" }, 401);
  if (!isAuthorized(session.user.username)) return c.json({ error: "This Val Town account is not allowed" }, 403);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const expectedOrigin = new URL(c.req.url).origin;
    if (origin !== expectedOrigin || c.req.header("X-BudgetApp-Request") !== "1") {
      return c.json({ error: "Invalid request origin" }, 403);
    }
  }
  await next();
});

app.get("/api/data", async (c) => {
  const asOf = c.req.query("asOf") || householdDate();
  assertDateOnly(asOf);
  return c.json(await getAppData(asOf));
});

app.post("/api/accounts", async (c) => {
  const body = await readBody(c.req.raw);
  await createAccount({
    name: stringField(body, "name", 80),
    type: enumField(body, "type", ["checking", "savings", "cash"] as const),
    balanceCents: signedCentsField(body, "balanceCents"),
  });
  return c.json({ ok: true }, 201);
});

app.put("/api/accounts/:id", async (c) => {
  const body = await readBody(c.req.raw);
  await updateAccount(safeId(c.req.param("id")), {
    name: stringField(body, "name", 80),
    type: enumField(body, "type", ["checking", "savings", "cash"] as const),
    isActive: booleanField(body, "isActive", true),
  });
  return c.json({ ok: true });
});

app.post("/api/accounts/:id/reconcile", async (c) => {
  const body = await readBody(c.req.raw);
  await reconcileAccount(safeId(c.req.param("id")), {
    actualBalanceCents: signedCentsField(body, "actualBalanceCents"),
    date: dateField(body, "date"),
    note: optionalString(body, "note", 300) ?? "",
  });
  return c.json({ ok: true }, 201);
});

app.delete("/api/accounts/:id", async (c) => {
  await deleteAccount(safeId(c.req.param("id")));
  return c.body(null, 204);
});

app.post("/api/transactions", async (c) => {
  const body = await readBody(c.req.raw);
  await createTransaction({
    accountId: safeId(stringField(body, "accountId", 64)),
    date: dateField(body, "date"),
    amountCents: centsField(body),
    description: stringField(body, "description", 160),
    kind: enumField(body, "kind", ["income", "expense"] as const),
  });
  return c.json({ ok: true }, 201);
});

app.put("/api/transactions/:id", async (c) => {
  const body = await readBody(c.req.raw);
  await updateTransaction(safeId(c.req.param("id")), {
    accountId: safeId(stringField(body, "accountId", 64)),
    date: dateField(body, "date"),
    amountCents: centsField(body),
    description: stringField(body, "description", 160),
    kind: enumField(body, "kind", ["income", "expense"] as const),
  });
  return c.json({ ok: true });
});

app.delete("/api/transactions/:id", async (c) => {
  await deleteTransaction(safeId(c.req.param("id")));
  return c.body(null, 204);
});

app.post("/api/planned", async (c) => {
  const body = await readBody(c.req.raw);
  await createPlanned(plannedInput(body));
  return c.json({ ok: true }, 201);
});

app.put("/api/planned/:id", async (c) => {
  await updatePlanned(safeId(c.req.param("id")), plannedInput(await readBody(c.req.raw)));
  return c.json({ ok: true });
});

app.post("/api/planned/:id/complete", async (c) => {
  const body = await readBody(c.req.raw);
  const accountId = optionalString(body, "accountId", 64);
  await completePlanned(
    safeId(c.req.param("id")),
    dateField(body, "date"),
    accountId ? safeId(accountId) : null,
  );
  return c.json({ ok: true });
});

app.post("/api/planned-completions/:id/undo", async (c) => {
  const body = await readBody(c.req.raw);
  await undoPlannedCompletion(
    safeId(c.req.param("id")),
    safeId(stringField(body, "expectedEffectiveTransactionId", 64)),
  );
  return c.json({ ok: true });
});

app.post("/api/planned-completions/:id/correct", async (c) => {
  const body = await readBody(c.req.raw);
  await correctPlannedCompletion(safeId(c.req.param("id")), {
    accountId: safeId(stringField(body, "accountId", 64)),
    date: dateField(body, "date"),
    amountCents: centsField(body),
    expectedEffectiveTransactionId: safeId(stringField(body, "expectedEffectiveTransactionId", 64)),
  });
  return c.json({ ok: true });
});

app.post("/api/planned/:id/deactivate", async (c) => {
  await deactivatePlanned(safeId(c.req.param("id")));
  return c.json({ ok: true });
});

app.delete("/api/planned/:id", async (c) => {
  await deletePlanned(safeId(c.req.param("id")));
  return c.body(null, 204);
});

app.post("/api/reserves", async (c) => {
  const body = await readBody(c.req.raw);
  await createReserve({
    name: stringField(body, "name", 80),
    amountCents: centsField(body, "amountCents", true),
    note: optionalString(body, "note", 300) ?? "",
  });
  return c.json({ ok: true }, 201);
});

app.put("/api/reserves/:id", async (c) => {
  const body = await readBody(c.req.raw);
  await updateReserve(safeId(c.req.param("id")), {
    name: stringField(body, "name", 80),
    amountCents: centsField(body, "amountCents", true),
    note: optionalString(body, "note", 300) ?? "",
    isActive: booleanField(body, "isActive", true),
  });
  return c.json({ ok: true });
});

app.delete("/api/reserves/:id", async (c) => {
  await deleteReserve(safeId(c.req.param("id")));
  return c.body(null, 204);
});

app.post("/api/demo", async (c) => c.json({ seeded: await seedDemoData() }));

app.delete("/api/demo", async (c) => {
  const body = await readBody(c.req.raw);
  const confirmation = exactStringField(body, "confirmation", DEMO_CLEANUP_CONFIRMATION.length);
  return c.json({ cleaned: await cleanupDemoData(confirmation) });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = Number((error as Error & { status?: number }).status) ||
    (/constraint/i.test(error.message) ? 409 : error instanceof SyntaxError ? 400 : 500);
  if (status >= 500) console.error("BudgetApp request failed", error.name, error.message);
  return c.json({ error: status >= 500 ? "Unexpected server error" : error.message }, status as 400);
});

function isAuthorized(username: string | null): boolean {
  if (!username) return false;
  const owner = parseVal(import.meta.url).username.toLowerCase();
  const extras = (Deno.env.get("BUDGET_APP_ALLOWED_USERS") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return username.toLowerCase() === owner || extras.includes(username.toLowerCase());
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 32_000) throw Object.assign(new Error("Request body is too large"), { status: 413 });
  return objectBody(await request.json());
}

function safeId(value: string): string {
  return uuidField(value);
}

function plannedInput(body: Record<string, unknown>) {
  const accountId = optionalString(body, "accountId", 64);
  const nextDate = dateField(body, "nextDate");
  const endDate = optionalString(body, "endDate", 10);
  if (endDate) {
    try {
      assertDateOnly(endDate);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "endDate is invalid");
    }
    if (endDate < nextDate) throw new ValidationError("endDate cannot be before nextDate");
  }
  return {
    accountId: accountId ? safeId(accountId) : null,
    description: stringField(body, "description", 160),
    kind: enumField(body, "kind", ["income", "expense"] as const),
    amountCents: centsField(body),
    recurrence: enumField(body, "recurrence", ["once", "weekly", "monthly", "yearly"] as const),
    intervalCount: integerField(body, "intervalCount"),
    nextDate,
    endDate,
    isActive: booleanField(body, "isActive", true),
  };
}

export default oauthMiddleware(app.fetch);
