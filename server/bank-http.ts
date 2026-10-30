import { BankProviderError } from "./bank-provider.ts";

/** Deadline covers fetch and streaming/parsing; cancellation does not rely on fetch honoring abort. */
export async function bankRequest<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new BankProviderError(503, "invalid_configuration");
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new BankProviderError(0, "timeout")); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  catch (error) { if (error instanceof BankProviderError) throw error; throw new BankProviderError(0, "connection_error"); }
  finally { clearTimeout(timer); }
}

export async function bankJson(request: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await request(url, { ...init, redirect: "error", signal });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new BankProviderError(response.status, "provider_error"); }
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) throw new BankProviderError(502, "malformed_response");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 2_000_000) { cancel(); throw new BankProviderError(502, "malformed_response"); } chunks.push(part.value); }
    if (signal.aborted) throw new BankProviderError(0, "timeout");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new BankProviderError(502, "malformed_response"); }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
