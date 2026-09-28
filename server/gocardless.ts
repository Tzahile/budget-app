import type { CanonicalTransactionInput } from "./ingestion.ts";

const baseUrl = "https://bankaccountdata.gocardless.com/api/v2";
const requisitionStatuses = new Set(["CR", "GC", "UA", "RJ", "SA", "GA", "LN", "EX"]);

export interface GoCardlessInstitution {
  id: string;
  name: string;
  countries: string[];
  transactionTotalDays: number | null;
}

export interface GoCardlessRequisition {
  id: string;
  status: string;
  accounts: string[];
  link: string | null;
  institutionId: string;
  reference: string | null;
}

export interface GoCardlessAccount {
  id: string;
  status: string;
  name: string | null;
  iban: string | null;
}

export interface GoCardlessBalance {
  amountCents: number;
  type: string;
  referenceDate: string | null;
}

export class GoCardlessError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Bank data request failed (${status}, ${code})`);
  }
}

/** Bank credentials are read only from server environment; tokens stay in memory. */
export function createGoCardlessClient(options: {
  fetch?: typeof fetch;
  env?: (name: string) => string | undefined;
  now?: () => number;
} = {}) {
  const request = options.fetch ?? fetch;
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const now = options.now ?? Date.now;
  let access: string | null = null;
  let accessUntil = 0;
  let refresh: string | null = null;
  let refreshUntil = 0;

  async function json(path: string, init: RequestInit = {}, authenticate = true): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    if (authenticate) headers.Authorization = `Bearer ${await token()}`;
    let response: Response;
    try {
      response = await request(`${baseUrl}${path}`, { ...init, headers, redirect: "error" });
    } catch {
      throw new GoCardlessError(0, "connection_error");
    }
    if (!response.ok) {
      let code = "provider_error";
      try {
        const body = await response.json();
        if (record(body) && typeof body.type === "string" && /^[a-zA-Z_]{1,80}$/.test(body.type)) code = body.type;
      } catch { /* A provider error can contain HTML or an empty body. */ }
      throw new GoCardlessError(response.status, code);
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new GoCardlessError(502, "malformed_response"); }
  }

  async function token(): Promise<string> {
    if (access && now() < accessUntil) return access;
    let data: unknown;
    if (refresh && now() < refreshUntil) {
      try { data = await json("/token/refresh/", { method: "POST", body: JSON.stringify({ refresh }) }, false); }
      catch (error) {
        if (!(error instanceof GoCardlessError) || error.status !== 401) throw error;
        refresh = null;
      }
    }
    if (!data) {
      const secretId = env("BUDGET_APP_GOCARDLESS_SECRET_ID");
      const secretKey = env("BUDGET_APP_GOCARDLESS_SECRET_KEY");
      if (!secretId || !secretKey) throw new GoCardlessError(503, "not_configured");
      data = await json("/token/new/", { method: "POST", body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }) }, false);
    }
    const body = object(data);
    access = string(body.access);
    accessUntil = now() + expiry(body.access_expires);
    if (body.refresh !== undefined) {
      refresh = string(body.refresh);
      refreshUntil = now() + expiry(body.refresh_expires);
    }
    return access;
  }

  async function listItalianInstitutions(): Promise<GoCardlessInstitution[]> {
    const data = await json("/institutions/?country=it");
    if (!Array.isArray(data)) malformed();
    return data.map((value) => {
      const item = object(value);
      const countries = strings(item.countries);
      if (!countries.includes("IT")) malformed();
      return {
        id: string(item.id), name: string(item.name), countries,
        transactionTotalDays: item.transaction_total_days == null ? null : nonnegativeInteger(item.transaction_total_days),
      };
    });
  }

  async function createRequisition(institutionId: string, redirect: string, reference: string): Promise<GoCardlessRequisition> {
    const catalog = await listItalianInstitutions();
    if (!catalog.some((item) => item.id === institutionId)) throw new GoCardlessError(400, "unsupported_institution");
    let callback: URL;
    try { callback = new URL(redirect); }
    catch { throw new GoCardlessError(400, "invalid_redirect"); }
    if (callback.protocol !== "https:") throw new GoCardlessError(400, "invalid_redirect");
    if (!reference || reference.length > 200) throw new GoCardlessError(400, "invalid_reference");
    const data = await json("/requisitions/", {
      method: "POST", body: JSON.stringify({ institution_id: institutionId, redirect: callback.href, reference }),
    });
    const result = requisition(data);
    if (!result.link || result.institutionId !== institutionId || result.reference !== reference) malformed();
    let link: URL;
    try { link = new URL(result.link); }
    catch { malformed(); }
    if (link.origin !== "https://ob.gocardless.com" || link.username || link.password ||
      !link.pathname.startsWith(`/psd2/start/${encodeURIComponent(result.id)}/`)) malformed();
    return result;
  }

  async function getRequisition(id: string): Promise<GoCardlessRequisition> {
    const result = requisition(await json(`/requisitions/${identifier(id)}/`));
    if (result.id !== id) malformed();
    return result;
  }

  async function deleteRequisition(id: string): Promise<void> {
    await json(`/requisitions/${identifier(id)}/`, { method: "DELETE" });
  }

  async function getAccount(id: string): Promise<GoCardlessAccount> {
    const item = object(await json(`/accounts/${identifier(id)}/`));
    if (string(item.id) !== id) malformed();
    return {
      id, status: string(item.status),
      name: optionalString(item.name), iban: optionalString(item.iban),
    };
  }

  async function getBalances(id: string): Promise<GoCardlessBalance[]> {
    const data = object(await json(`/accounts/${identifier(id)}/balances/`));
    if (!Array.isArray(data.balances) || data.balances.length === 0) malformed();
    return data.balances.map((raw) => {
      const item = object(raw);
      const amount = object(item.balanceAmount);
      if (string(amount.currency) !== "EUR") throw new GoCardlessError(422, "unsupported_currency");
      return { amountCents: cents(amount.amount), type: string(item.balanceType), referenceDate: optionalDate(item.referenceDate) };
    });
  }

  async function getTransactions(id: string, dates?: { from: string; to: string }): Promise<CanonicalTransactionInput[]> {
    let query = "";
    if (dates) {
      date(dates.from); date(dates.to);
      if (dates.from > dates.to) throw new GoCardlessError(400, "invalid_date_range");
      query = `?date_from=${dates.from}&date_to=${dates.to}`;
    }
    const page = object(await json(`/accounts/${identifier(id)}/transactions/${query}`));
    // The endpoint is not paginated. Reject any continuation marker rather than silently ingesting a partial result.
    if (page.next != null || page.has_more === true) malformed();
    const items = object(page.transactions);
    if (!Array.isArray(items.booked) || (items.pending !== undefined && !Array.isArray(items.pending))) malformed();
    return [
      ...items.booked.map((item) => normalizeTransaction(item, "cleared")),
      ...(items.pending ?? []).map((item: unknown) => normalizeTransaction(item, "pending")),
    ];
  }

  return { listItalianInstitutions, createRequisition, getRequisition, deleteRequisition, getAccount, getBalances, getTransactions };
}

function normalizeTransaction(raw: unknown, status: "cleared" | "pending"): CanonicalTransactionInput {
  const item = object(raw);
  const amount = object(item.transactionAmount);
  if (string(amount.currency) !== "EUR") throw new GoCardlessError(422, "unsupported_currency");
  const occurredOn = date(item.bookingDate ?? item.valueDate ?? dateFromTime(item.bookingDateTime ?? item.valueDateTime));
  const description = [item.remittanceInformationUnstructured, item.additionalInformation, item.creditorName, item.debtorName]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof description !== "string" || description.trim().length > 500) malformed();
  const externalId = optionalString(item.transactionId) ?? optionalString(item.internalTransactionId) ?? optionalString(item.entryReference);
  if (externalId && externalId.length > 200) malformed();
  const amountCents = cents(amount.amount);
  if (amountCents === 0) malformed();
  return { occurredOn, amountCents, description: description.trim(), externalId, status,
    auditMetadata: { adapter: "gocardless" } };
}

function requisition(raw: unknown): GoCardlessRequisition {
  const item = object(raw);
  const status = string(item.status);
  if (!requisitionStatuses.has(status)) malformed();
  return {
    id: string(item.id), status, institutionId: string(item.institution_id), accounts: strings(item.accounts),
    link: optionalString(item.link), reference: optionalString(item.reference),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> { if (!record(value)) malformed(); return value; }
function string(value: unknown): string { if (typeof value !== "string" || !value.trim()) malformed(); return value; }
function optionalString(value: unknown): string | null { return value == null ? null : string(value); }
function strings(value: unknown): string[] { if (!Array.isArray(value)) malformed(); return value.map(string); }
function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new GoCardlessError(400, "invalid_id");
  return encodeURIComponent(value);
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) malformed();
  return value;
}
function optionalDate(value: unknown): string | null { return value == null ? null : date(value); }
function dateFromTime(value: unknown): unknown { return typeof value === "string" ? value.slice(0, 10) : value; }
function cents(value: unknown): number {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) malformed();
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + (whole.startsWith("-") ? -1 : 1) * Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) malformed();
  return result;
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) malformed();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) malformed();
  return number;
}
function expiry(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) malformed();
  return Math.max(0, (value as number) * 1000 - 60_000);
}
function malformed(): never { throw new GoCardlessError(502, "malformed_response"); }
