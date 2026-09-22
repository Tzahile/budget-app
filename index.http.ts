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
  createTransfer,
  deleteAccount,
  deletePlanned,
  deleteReserve,
  deleteTransaction,
  deactivatePlanned,
  getAppData,
  ingestTransactions,
  reconcileAccount,
  seedDemoData,
  updateAccount,
  updatePlanned,
  updateReserve,
  updateTransaction,
  updateTransfer,
  undoPlannedCompletion,
  deleteTransfer,
  decideIngestedTransferCandidate,
} from "./server/repository.ts";
import { parseCsvTransactions, type CsvColumnMapping } from "./server/ingestion.ts";
import { isTrustedMutationRequest, readJsonObject, SECURITY_HEADERS } from "./server/security.ts";
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

app.use("*", async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
});

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
  if (!isTrustedMutationRequest(c.req.raw)) {
    return c.json({ error: "Invalid request origin" }, 403);
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

app.post("/api/transfers", async (c) => {
  await createTransfer(transferInput(await readBody(c.req.raw)));
  return c.json({ ok: true }, 201);
});

app.put("/api/transfers/:id", async (c) => {
  await updateTransfer(safeId(c.req.param("id")), transferInput(await readBody(c.req.raw)));
  return c.json({ ok: true });
});

app.delete("/api/transfers/:id", async (c) => {
  await deleteTransfer(safeId(c.req.param("id")));
  return c.body(null, 204);
});

app.post("/api/imports/csv", async (c) => {
  const body = await readBody(c.req.raw);
  const accountId = safeId(stringField(body, "accountId", 64));
  const csv = exactStringField(body, "csv", 500_000);
  const mapping = csvMapping(body.mapping);
  const parsed = parseCsvTransactions(csv, mapping);
  if (parsed.errors.length) return c.json({ ok: false, errors: parsed.errors }, 422);
  const result = await ingestTransactions({
    accountId, filename: stringField(body, "filename", 160), source: "csv", transactions: parsed.transactions,
  });
  return c.json({ ok: true, ...result, rowCount: parsed.transactions.length }, 201);
});

app.post("/api/ingested-transfer-candidates/:id/decision", async (c) => {
  const body = await readBody(c.req.raw);
  await decideIngestedTransferCandidate(
    safeId(c.req.param("id")),
    enumField(body, "decision", ["confirm", "reject", "defer"] as const),
  );
  return c.json({ ok: true });
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
  await createReserve(reserveInput(body));
  return c.json({ ok: true }, 201);
});

app.put("/api/reserves/:id", async (c) => {
  const body = await readBody(c.req.raw);
  await updateReserve(safeId(c.req.param("id")), {
    ...reserveInput(body),
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
  // Error text can contain database/provider context. Keep production logs useful
  // for operational triage without turning them into a financial-data sink.
  if (status >= 500) console.error("BudgetApp request failed", error.name);
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
  return readJsonObject(request);
}

function safeId(value: string): string {
  return uuidField(value);
}

function csvMapping(value: unknown): CsvColumnMapping {
  const mapping = objectBody(value);
  return {
    date: stringField(mapping, "date", 100),
    amount: stringField(mapping, "amount", 100),
    description: stringField(mapping, "description", 100),
    externalId: optionalString(mapping, "externalId", 100) ?? undefined,
    status: optionalString(mapping, "status", 100) ?? undefined,
  };
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

function transferInput(body: Record<string, unknown>) {
  const fromAccountId = safeId(stringField(body, "fromAccountId", 64));
  const toAccountId = safeId(stringField(body, "toAccountId", 64));
  if (fromAccountId === toAccountId) throw new ValidationError("Choose two different accounts");
  return {
    fromAccountId,
    toAccountId,
    date: dateField(body, "date"),
    amountCents: centsField(body),
    description: stringField(body, "description", 160),
  };
}

function reserveInput(body: Record<string, unknown>) {
  const targetAmount = body.targetAmountCents;
  const targetDate = body.targetDate;
  const hasTargetAmount = targetAmount != null;
  const hasTargetDate = targetDate != null && targetDate !== "";
  if (hasTargetAmount !== hasTargetDate) {
    throw new ValidationError("targetAmountCents and targetDate must be provided together");
  }
  const linkedPlannedTransactionId = optionalString(body, "linkedPlannedTransactionId", 64);
  if (linkedPlannedTransactionId && !hasTargetAmount) {
    throw new ValidationError("Only a target-date reserve can link a planned expense");
  }
  return {
    name: stringField(body, "name", 80),
    // Continue accepting the original field so existing API clients can keep
    // creating simple reserves after the database field gains goal semantics.
    fundedAmountCents: body.fundedAmountCents == null && body.amountCents != null
      ? centsField(body, "amountCents", true)
      : centsField(body, "fundedAmountCents", true),
    targetAmountCents: hasTargetAmount ? centsField(body, "targetAmountCents") : null,
    targetDate: hasTargetDate ? dateField(body, "targetDate") : null,
    linkedPlannedTransactionId: linkedPlannedTransactionId ? safeId(linkedPlannedTransactionId) : null,
    note: optionalString(body, "note", 300) ?? "",
  };
}

export default oauthMiddleware(app.fetch);
