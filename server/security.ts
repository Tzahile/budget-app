import { objectBody } from "./validation.ts";

export const MAX_JSON_BODY_BYTES = 32_000;

export class RequestSecurityError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
    this.name = "RequestSecurityError";
  }
}

/**
 * Browser session cookies authenticate this app, so every state-changing API
 * request must prove it was made by this origin's JavaScript client.
 */
export function isTrustedMutationRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  return request.headers.get("Origin") === new URL(request.url).origin &&
    request.headers.get("X-BudgetApp-Request") === "1";
}

export function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(";", 1)[0].trim() === "application/json";
}

/** Read JSON with a hard byte limit even when Content-Length is absent or lies. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new RequestSecurityError("Content-Type must be application/json", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength != null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestSecurityError("Invalid Content-Length", 400);
    }
    if (length > MAX_JSON_BODY_BYTES) throw new RequestSecurityError("Request body is too large", 413);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestSecurityError("A JSON object is required", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new RequestSecurityError("Request body is too large", 413);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return objectBody(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)));
  } catch (error) {
    if (error instanceof RequestSecurityError) throw error;
    throw new RequestSecurityError("A JSON object is required", 400);
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' https://cdn.twind.style https://esm.town; style-src 'self' 'unsafe-inline'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
