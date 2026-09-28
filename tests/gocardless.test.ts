import { describe, expect, it, vi } from "vitest";
import { createGoCardlessClient, GoCardlessError } from "../server/gocardless.ts";

const institution = { id: "BBVA_IT", name: "BBVA", countries: ["IT"], transaction_total_days: "90" };
const requisition = {
  id: "11111111-1111-4111-8111-111111111111", status: "CR", accounts: [], institution_id: institution.id,
  reference: "local-state", link: "https://ob.gocardless.com/psd2/start/11111111-1111-4111-8111-111111111111/BBVA_IT",
};

function fixture(handlers: Record<string, unknown>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    calls.push({ path, init: init ?? {} });
    const response = handlers[path];
    if (response === undefined) return Response.json({ summary: "Unexpected request" }, { status: 404 });
    return response instanceof Response ? response : Response.json(response);
  }) as unknown as typeof fetch;
  const client = createGoCardlessClient({
    fetch: fetcher, env: (key) => key === "BUDGET_APP_GOCARDLESS_SECRET_ID" ? "synthetic-id" : "synthetic-key", now: () => 0,
  });
  return { client, calls };
}

const auth = { access: "synthetic-access", access_expires: 86400, refresh: "synthetic-refresh", refresh_expires: 2592000 };

describe("GoCardless Bank Account Data adapter", () => {
  it("uses server secrets for tokens and verifies a live Italian catalog before a consent link", async () => {
    const { client, calls } = fixture({
      "/api/v2/token/new/": auth, "/api/v2/institutions/?country=it": [institution],
      "/api/v2/requisitions/": requisition,
    });
    expect(await client.listItalianInstitutions()).toEqual([{
      id: "BBVA_IT", name: "BBVA", countries: ["IT"], transactionTotalDays: 90,
    }]);
    expect(await client.createRequisition("BBVA_IT", "https://example.test/bank/callback", "local-state"))
      .toMatchObject({ id: requisition.id, status: "CR", link: requisition.link });
    expect(calls.filter((call) => call.path === "/api/v2/token/new/")).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ secret_id: "synthetic-id", secret_key: "synthetic-key" });
    expect(calls[2].init.headers).toMatchObject({ Authorization: "Bearer synthetic-access" });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({
      institution_id: "BBVA_IT", redirect: "https://example.test/bank/callback", reference: "local-state",
    });
  });

  it("accepts numeric history limits from a provider catalog", async () => {
    const { client } = fixture({ "/api/v2/token/new/": auth,
      "/api/v2/institutions/?country=it": [{ ...institution, transaction_total_days: 180 }] });
    expect((await client.listItalianInstitutions())[0].transactionTotalDays).toBe(180);
  });

  it("refuses institutions missing from the authenticated Italian catalog", async () => {
    const { client, calls } = fixture({ "/api/v2/token/new/": auth, "/api/v2/institutions/?country=it": [] });
    await expect(client.createRequisition("BBVA_IT", "https://example.test/callback", "state"))
      .rejects.toMatchObject({ code: "unsupported_institution" });
    expect(calls.some((call) => call.path === "/api/v2/requisitions/")).toBe(false);
  });

  it("reads linked accounts, balances and booked and pending transactions; deletes consent", async () => {
    const id = requisition.id;
    const account = "22222222-2222-4222-8222-222222222222";
    const { client, calls } = fixture({
      "/api/v2/token/new/": auth,
      [`/api/v2/requisitions/${id}/`]: { ...requisition, status: "LN", accounts: [account] },
      [`/api/v2/accounts/${account}/`]: { id: account, status: "READY", name: "Current", iban: "IT123" },
      [`/api/v2/accounts/${account}/balances/`]: { balances: [{ balanceAmount: { amount: "102.30", currency: "EUR" }, balanceType: "interimBooked" }] },
      [`/api/v2/accounts/${account}/transactions/?date_from=2026-09-01&date_to=2026-09-30`]: {
        transactions: {
          booked: [{ transactionId: "tx1", bookingDate: "2026-09-20", transactionAmount: { amount: "-3.45", currency: "EUR" },
            remittanceInformationUnstructured: "Coffee" }],
          pending: [{ valueDate: "2026-09-21", transactionAmount: { amount: "10.00", currency: "EUR" }, debtorName: "Employer" }],
        },
      },
    });
    expect(await client.getRequisition(id)).toMatchObject({ status: "LN", accounts: [account] });
    expect(await client.getAccount(account)).toMatchObject({ name: "Current", status: "READY" });
    expect(await client.getBalances(account)).toEqual([{ amountCents: 10230, type: "interimBooked", referenceDate: null }]);
    expect(await client.getTransactions(account, { from: "2026-09-01", to: "2026-09-30" })).toEqual([
      { occurredOn: "2026-09-20", amountCents: -345, description: "Coffee", externalId: "tx1", status: "cleared", auditMetadata: { adapter: "gocardless" } },
      { occurredOn: "2026-09-21", amountCents: 1000, description: "Employer", externalId: null, status: "pending", auditMetadata: { adapter: "gocardless" } },
    ]);
    await expect(client.deleteRequisition(id)).resolves.toBeUndefined();
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });

  it("fails the whole sync on malformed, partial and non-EUR provider results", async () => {
    const account = "22222222-2222-4222-8222-222222222222";
    for (const response of [
      { transactions: { booked: [{ bookingDate: "2026-09-20", transactionAmount: { amount: "1.00", currency: "EUR" }, creditorName: "Good" }, {}] } },
      { transactions: { booked: [] }, next: "next-page" },
      { transactions: { booked: [{ bookingDate: "2026-09-20", transactionAmount: { amount: "1.00", currency: "USD" }, creditorName: "Bad" }] } },
    ]) {
      const { client } = fixture({ "/api/v2/token/new/": auth, [`/api/v2/accounts/${account}/transactions/`]: response });
      await expect(client.getTransactions(account)).rejects.toBeInstanceOf(GoCardlessError);
    }
  });

  it("surfaces expiry and rate limits without exposing provider bodies or secrets", async () => {
    const id = requisition.id;
    const { client } = fixture({
      "/api/v2/token/new/": auth,
      [`/api/v2/requisitions/${id}/`]: Response.json({ summary: "secret data", detail: "sensitive" }, { status: 429 }),
    });
    await expect(client.getRequisition(id)).rejects.toMatchObject({ status: 429, code: "provider_error" });
  });
});
