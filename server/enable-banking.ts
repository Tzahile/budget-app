import { bankJson, bankRequest } from "./bank-http.ts";
import { assertDateOnly } from "../shared/finance.ts";
import { BankProviderError, type BankAuthorization, type BankProviderClient } from "./bank-provider.ts";
import type { CanonicalTransactionInput } from "./ingestion.ts";

const base = "https://api.enablebanking.com";
const encoder = new TextEncoder();
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
function malformed(): never { throw new BankProviderError(502, "malformed_response"); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) malformed();
  return value;
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) malformed(); return value; }
function uuid(value: unknown): string {
  const id = string(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) malformed();
  return id;
}
function timestamp(value: unknown): string {
  const date = string(value, 40);
  if (!/^\d{4}-\d\d-\d\dT/.test(date) || !Number.isFinite(Date.parse(date))) malformed();
  return new Date(date).toISOString();
}
function date(value: unknown): string { const result = string(value, 10); try { assertDateOnly(result); } catch { malformed(); } return result; }
function cents(value: unknown): number {
  const amount = string(value, 30);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) malformed();
  const [whole, fraction = ""] = amount.replace(/^-/, "").split(".");
  const result = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * (amount.startsWith("-") ? -1 : 1);
  if (!Number.isSafeInteger(result)) malformed();
  return result;
}
function amount(value: unknown): number {
  const item = object(value);
  if (item.currency !== "EUR") throw new BankProviderError(422, "unsupported_currency");
  return cents(item.amount);
}
function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }

/** Server-only candidate. Construction and absent configuration make no request. */
export function createEnableBankingClient(options: {
  fetch?: typeof fetch; env?: (key: string) => string | undefined; now?: () => number; timeoutMs?: number;
} = {}): BankProviderClient {
  const request = options.fetch ?? fetch;
  const env = options.env ?? ((key: string) => Deno.env.get(key));
  const now = options.now ?? Date.now;
  let privateKey: Promise<CryptoKey> | undefined;
  async function jwt(): Promise<string> {
    const appId = env("BUDGET_APP_ENABLE_BANKING_APP_ID");
    const pem = env("BUDGET_APP_ENABLE_BANKING_PRIVATE_KEY");
    if (!appId || !pem || !/^[a-f0-9-]{36}$/i.test(appId)) throw new BankProviderError(503, "not_configured");
    try {
      privateKey ??= (async () => {
        const match = pem.match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----\s*$/);
        if (!match) throw new Error();
        const bytes = Uint8Array.from(atob(match[1].replace(/\s/g, "")), (value) => value.charCodeAt(0));
        return crypto.subtle.importKey("pkcs8", bytes, algorithm, false, ["sign"]);
      })().catch(() => { privateKey = undefined; throw new BankProviderError(503, "invalid_configuration"); });
      const iat = Math.floor(now() / 1000);
      const data = `${base64(encoder.encode(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId })))}.${base64(encoder.encode(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 300 })))}`;
      const signature = await crypto.subtle.sign(algorithm, await privateKey, encoder.encode(data));
      return `${data}.${base64(new Uint8Array(signature))}`;
    } catch (error) { if (error instanceof BankProviderError) throw error; throw new BankProviderError(503, "invalid_configuration"); }
  }
  async function json(path: string, method = "GET", body?: unknown): Promise<unknown> {
    return bankRequest(async (signal) => {
      const authorization = await jwt();
      return bankJson(request, `${base}${path}`, { method,
        headers: { Authorization: `Bearer ${authorization}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, signal);
    }, options.timeoutMs);
  }

  const authMethods = new Map<string, string>();
  async function listItalianInstitutions() {
    authMethods.clear();
    const result = object(await json("/aspsps?country=IT&psu_type=personal&service=AIS"));
    return list(result.aspsps, 500).flatMap((value) => {
      const aspsp = object(value);
      if (aspsp.country !== "IT" || !list(aspsp.psu_types, 10).includes("personal") ||
        (aspsp.required_psu_headers != null && list(aspsp.required_psu_headers, 20).length > 0)) return [];
      // Credential collection is explicitly outside BudgetApp's boundary.
      const methods = list(aspsp.auth_methods, 30).map(object);
      const method = methods.find((m) => m.approach === "REDIRECT" && m.psu_type === "personal" && !m.hidden_method && (!m.credentials || list(m.credentials, 20).every((c) => object(c).required !== true)));
      if (!method) return [];
      authMethods.set(string(aspsp.name, 128), string(method.name, 128));
      return [{ id: string(aspsp.name, 128), name: string(aspsp.name, 128), countries: ["IT"], transactionTotalDays: null }];
    });
  }
  function session(value: unknown, id?: string): BankAuthorization {
    const data = object(value); const aspsp = object(data.aspsp);
    if (aspsp.country !== "IT" || data.psu_type !== "personal") malformed();
    const accounts = list(data.accounts_data ?? data.accounts, 50).map((value) => object(value));
    const identities: Record<string, string> = {};
    for (const account of accounts) identities[uuid(account.uid)] = string(account.identification_hash, 1000);
    const ids = Object.keys(identities);
    if (ids.length !== accounts.length || !ids.length) malformed();
    return { id: id ?? uuid(data.session_id), status: !id || data.status === "AUTHORIZED" ? "LN" : "EX", accounts: ids,
      accountIdentities: identities, link: null, institutionId: string(aspsp.name, 128), reference: null,
      expiresAt: timestamp(object(data.access).valid_until) };
  }
  return {
    providerId: "enable-banking",
    listItalianInstitutions,
    async createRequisition(institutionId, redirect, state) {
      if (!(await listItalianInstitutions()).some((item) => item.id === institutionId)) throw new BankProviderError(400, "unsupported_institution");
      const callback = new URL(redirect);
      if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash || !/^[a-f0-9]{64}$/.test(state)) throw new BankProviderError(400, "invalid_redirect");
      const data = object(await json("/auth", "POST", { access: { valid_until: new Date(now() + 86400_000).toISOString() }, aspsp: { name: institutionId, country: "IT" }, psu_type: "personal", auth_method: authMethods.get(institutionId), state, redirect_url: callback.href }));
      const link = new URL(string(data.url, 2000));
      if (link.origin !== "https://auth.enablebanking.com" || link.username || link.password || link.pathname !== "/ais/start") malformed();
      const authorizationId = uuid(data.authorization_id);
      if (link.searchParams.get("sessionid") !== authorizationId) malformed();
      return { id: authorizationId, status: "CR", accounts: [], link: link.href, institutionId, reference: state };
    },
    async exchangeAuthorization(code) { return session(await json("/sessions", "POST", { code: string(code, 2000) })); },
    async getRequisition(id) {
      const data = object(await json(`/sessions/${uuid(id)}`));
      // accounts_data is required for durable reconnect matching; never infer identity from session UIDs.
      if (!data.accounts_data) malformed();
      const result = session(data, id);
      const ids = list(data.accounts, 50).map(uuid);
      if (ids.length !== result.accounts.length || ids.some((uid) => !result.accounts.includes(uid))) malformed();
      return result;
    },
    async deleteRequisition(id) { await json(`/sessions/${uuid(id)}`, "DELETE"); },
    async getAccount(id) {
      const data = object(await json(`/accounts/${uuid(id)}/details`));
      if (data.currency !== "EUR" || (data.uid !== undefined && data.uid !== id)) malformed();
      return { id, status: "READY", name: null, iban: null };
    },
    async getBalances(id) {
      const data = object(await json(`/accounts/${uuid(id)}/balances`));
      return list(data.balances, 30).map((value) => { const item = object(value); const type = string(item.balance_type, 10);
        return { amountCents: amount(item.balance_amount), type: type === "ITBD" ? "interimBooked" : type === "CLBD" ? "closingBooked" : type,
          referenceDate: item.reference_date == null ? null : date(item.reference_date) }; });
    },
    async getTransactions(id, dates) {
      const result: CanonicalTransactionInput[] = []; const seen = new Set<string>(); let continuation: string | null = null;
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ transaction_status: "BOOK" });
        if (dates) { query.set("date_from", date(dates.from)); query.set("date_to", date(dates.to)); }
        if (continuation) query.set("continuation_key", continuation);
        const data = object(await json(`/accounts/${uuid(id)}/transactions?${query}`));
        for (const value of list(data.transactions, 2000)) {
          const item = object(value); if (item.status !== "BOOK") malformed();
          const positive = amount(item.transaction_amount); if (positive <= 0 || !["CRDT", "DBIT"].includes(String(item.credit_debit_indicator))) malformed();
          const lines = item.remittance_information == null ? [] : list(item.remittance_information, 20).map((v) => string(v, 500));
          const description = lines.join(" ") || "Bank transaction"; if (description.length > 500) malformed();
          // Enable Banking transaction_id changes between sessions. A missing
          // entry_reference cannot be safely deduplicated when descriptions change.
          // Refuse the entire page before any financial writes.
          const entryReference = string(item.entry_reference, 200);
          result.push({ occurredOn: date(item.booking_date), amountCents: positive * (item.credit_debit_indicator === "DBIT" ? -1 : 1), description,
            externalId: entryReference, status: "cleared", auditMetadata: { adapter: "enable_banking" } });
          if (result.length > 2000) malformed();
        }
        if (data.continuation_key == null) return result;
        continuation = string(data.continuation_key, 2000); if (seen.has(continuation)) malformed(); seen.add(continuation);
      }
      return malformed();
    },
  };
}
