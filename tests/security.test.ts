import { describe, expect, it } from "vitest";
import { isJsonContentType, isTrustedMutationRequest, MAX_JSON_BODY_BYTES, readJsonObject, RequestSecurityError, SECURITY_HEADERS } from "../server/security.ts";

describe("request security boundaries", () => {
  it("accepts same-origin mutations only when the app request header is present", () => {
    expect(isTrustedMutationRequest(new Request("https://budget.example/api/accounts", { method: "POST", headers: { Origin: "https://budget.example", "X-BudgetApp-Request": "1" } }))).toBe(true);
    expect(isTrustedMutationRequest(new Request("https://budget.example/api/accounts", { method: "POST", headers: { Origin: "https://evil.example", "X-BudgetApp-Request": "1" } }))).toBe(false);
    expect(isTrustedMutationRequest(new Request("https://budget.example/api/accounts", { method: "POST", headers: { Origin: "https://budget.example" } }))).toBe(false);
    expect(isTrustedMutationRequest(new Request("https://budget.example/api/data"))).toBe(true);
  });

  it("requires JSON and rejects an over-limit body even without Content-Length", async () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    await expect(readJsonObject(new Request("https://budget.example/api/accounts", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJsonObject(new Request("https://budget.example/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }) }))).rejects.toMatchObject({ status: 413 });
  });

  it("does not silently accept malformed JSON", async () => {
    await expect(readJsonObject(new Request("https://budget.example/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[" }))).rejects.toBeInstanceOf(RequestSecurityError);
  });

  it("uses browser-facing hardening headers", () => {
    expect(SECURITY_HEADERS["Cache-Control"]).toBe("no-store");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});
