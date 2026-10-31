import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEnableBankingClient } from "../server/enable-banking.ts";
import { bankRequest, bankJson } from "../server/bank-http.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-10-31T12:00:00Z");
let pem: string;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  publicKey = pair.publicKey;
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(""))}\n-----END PRIVATE KEY-----`;
});
const aspsp = { name: "BBVA", country: "IT", psu_types: ["personal"], auth_methods: [{ name: "redirect-personal", approach: "REDIRECT", psu_type: "personal", credentials: [] }] };
const session = { session_id: sessionId, accounts: [{ uid: accountId, identification_hash: "synthetic-stable-identity" }], aspsp: { name: "BBVA", country: "IT" }, psu_type: "personal", access: { valid_until: "2999-01-01T00:00:00Z" } };
const transaction = { entry_reference: "synthetic-stable-entry", transaction_id: "unstable-do-not-use", booking_date: "2026-10-30", status: "BOOK", transaction_amount: { amount: "12.34", currency: "EUR" }, credit_debit_indicator: "DBIT", remittance_information: ["Synthetic purchase"] };
function fixture(responses: Record<string, unknown>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url)); expect(parsed.origin).toBe("https://api.enablebanking.com");
    const path = parsed.pathname + parsed.search; calls.push({ path, init: init ?? {} });
    if (!(path in responses)) return new Response(null, { status: 404 });
    const value = responses[path]; return value instanceof Response ? value : Response.json(value);
  }) as unknown as typeof fetch;
  return { calls, client: createEnableBankingClient({ fetch: fetcher, now: () => now,
    env: (key) => key === "BUDGET_APP_ENABLE_BANKING_APP_ID" ? appId : key === "BUDGET_APP_ENABLE_BANKING_PRIVATE_KEY" ? pem : undefined }) };
}
function decode(input: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(input.replace(/-/g, "+").replace(/_/g, "/")), (v) => v.charCodeAt(0)); }

describe("Enable Banking server adapter", () => {
  it("signs short-lived RS256 JWTs and selects credential-free personal redirect authorization", async () => {
    const { client, calls } = fixture({ "/aspsps?country=IT&psu_type=personal&service=AIS": { aspsps: [aspsp] }, "/auth": { url: `https://auth.enablebanking.com/ais/start?sessionid=${sessionId}`, authorization_id: sessionId } });
    const state = "a".repeat(64);
    expect(await client.createRequisition("BBVA", "https://budget.example/api/bank/callback", state)).toMatchObject({ id: sessionId, institutionId: "BBVA", reference: state });
    const jwt = String((calls[0].init.headers as Record<string, string>).Authorization).slice(7);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ typ: "JWT", alg: "RS256", kid: appId });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now / 1000, exp: now / 1000 + 300 });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ access: { valid_until: "2026-11-01T12:00:00.000Z" }, aspsp: { name: "BBVA", country: "IT" }, psu_type: "personal", auth_method: "redirect-personal", state, redirect_url: "https://budget.example/api/bank/callback" });
    expect(calls.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("PRIVATE KEY");
  });

  it("exchanges one-time code, validates session identities/expiry, reads EUR details and only maps booked balances", async () => {
    const { client, calls } = fixture({ "/sessions": session,
      [`/sessions/${sessionId}`]: { ...session, status: "AUTHORIZED", accounts: [accountId], accounts_data: session.accounts },
      [`/accounts/${accountId}/details`]: { uid: accountId, currency: "EUR" },
      [`/accounts/${accountId}/balances`]: { balances: [ { balance_type: "CLAV", balance_amount: { amount: "1.00", currency: "EUR" } }, { balance_type: "ITBD", balance_amount: { amount: "2.00", currency: "EUR" } }] },
    });
    expect(await client.exchangeAuthorization!("synthetic-code")).toMatchObject({ id: sessionId, status: "LN", expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(await client.getRequisition(sessionId)).toMatchObject({ accountIdentities: { [accountId]: "synthetic-stable-identity" } });
    expect(await client.getAccount(accountId)).toEqual({ id: accountId, status: "READY", name: null, iban: null });
    expect((await client.getBalances(accountId)).map(({ type }) => type)).toEqual(["CLAV", "interimBooked"]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: "synthetic-code" });
  });

  it("fetches every bounded page and uses stable entry_reference, never unstable transaction_id", async () => {
    const { client } = fixture({ [`/accounts/${accountId}/transactions?transaction_status=BOOK`]: { transactions: [transaction], continuation_key: "page2" },
      [`/accounts/${accountId}/transactions?transaction_status=BOOK&continuation_key=page2`]: { transactions: [{ ...transaction, entry_reference: "synthetic-stable-entry-2", transaction_id: "unstable-2", credit_debit_indicator: "CRDT" }] } });
    expect(await client.getTransactions(accountId)).toEqual([
      { occurredOn: "2026-10-30", amountCents: -1234, description: "Synthetic purchase", externalId: "synthetic-stable-entry", status: "cleared", auditMetadata: { adapter: "enable_banking" } },
      { occurredOn: "2026-10-30", amountCents: 1234, description: "Synthetic purchase", externalId: "synthetic-stable-entry-2", status: "cleared", auditMetadata: { adapter: "enable_banking" } },
    ]);
  });

  it("rejects missing stable entry references instead of duplicating changed descriptions", async () => {
    const missing = { ...transaction, entry_reference: undefined, transaction_id: "unstable-session-id" };
    const { client } = fixture({ [`/accounts/${accountId}/transactions?transaction_status=BOOK`]: { transactions: [transaction, missing] } });
    await expect(client.getTransactions(accountId)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects foreign/partial/looping pages without returning a partial result", async () => {
    for (const bad of [{ ...transaction, transaction_amount: { amount: "1.00", currency: "USD" } }, { ...transaction, status: "HOLD" }, { ...transaction, credit_debit_indicator: "UNKNOWN" }, { ...transaction, booking_date: "2026-02-30" }]) {
      const { client } = fixture({ [`/accounts/${accountId}/transactions?transaction_status=BOOK`]: { transactions: [transaction, bad] } });
      await expect(client.getTransactions(accountId)).rejects.toThrow();
    }
    const { client } = fixture({ [`/accounts/${accountId}/transactions?transaction_status=BOOK`]: { transactions: [], continuation_key: "loop" }, [`/accounts/${accountId}/transactions?transaction_status=BOOK&continuation_key=loop`]: { transactions: [], continuation_key: "loop" } });
    await expect(client.getTransactions(accountId)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("does not make requests without configuration and suppresses provider bodies", async () => {
    const fetcher = vi.fn();
    await expect(createEnableBankingClient({ fetch: fetcher, env: () => undefined }).listItalianInstitutions()).rejects.toMatchObject({ code: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    const { client } = fixture({ [`/sessions/${sessionId}`]: new Response("RAW_SECRET_SENTINEL", { status: 429 }) });
    await expect(client.getRequisition(sessionId)).rejects.toMatchObject({ status: 429, code: "provider_error" });
  });
});

it("bounds fetches and non-aborting response streams and caps body bytes", async () => {
  await expect(bankRequest(async () => new Promise(() => undefined), 5)).rejects.toMatchObject({ code: "timeout" });
  const hanging = new Response(new ReadableStream({ start() {} }));
  await expect(bankRequest((signal) => bankJson((async () => hanging) as typeof fetch, "https://provider.example", {}, signal), 5)).rejects.toMatchObject({ code: "timeout" });
  const big = new Response("x".repeat(2_000_001));
  await expect(bankRequest((signal) => bankJson((async () => big) as typeof fetch, "https://provider.example", {}, signal))).rejects.toMatchObject({ code: "malformed_response" });
});
