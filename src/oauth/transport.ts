const OAUTH_TIMEOUT_MS = 30_000;
const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;

export class OAuthTransportError extends Error {
  override readonly name = "OAuthTransportError";
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OAUTH_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* ignore cancellation failures */ }
    throw new OAuthTransportError("OAuth response exceeded 1 MiB");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthTransportError("OAuth response exceeded 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function oauthFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  executor: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  let url: URL;
  try {
    url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  } catch {
    throw new OAuthTransportError("OAuth endpoint is invalid");
  }
  if (url.username || url.password) throw new OAuthTransportError("OAuth endpoint must not contain credentials");
  if (url.protocol !== "https:") throw new OAuthTransportError("OAuth endpoint must use HTTPS");
  const timeout = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    const response = await executor(input, { ...init, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* ignore cancellation failures */ }
      throw new OAuthTransportError(`OAuth endpoint refused the request (HTTP ${response.status})`);
    }
    return await boundedResponse(response, signal);
  } catch (error) {
    if (error instanceof OAuthTransportError) throw error;
    if (init.signal?.aborted) throw init.signal.reason;
    if (timeout.aborted) throw timeout.reason;
    throw new OAuthTransportError("OAuth request failed");
  }
}
