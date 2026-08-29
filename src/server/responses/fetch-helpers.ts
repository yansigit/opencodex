import type { Server } from "bun";
import {
  codexWsUpstreamFetch,
  currentBunRuntimeIdentity,
  shouldUseCodexWsUpstream,
  type CodexWsUpstreamOptions,
  type BunRuntimeGateInput,
} from "./ws-upstream";
import type { OcxProviderConfig } from "../../types";
import type { WsData } from "../ws-bridge";
import { waitForProviderRequestSlot } from "../../providers/request-pacing";
import { withUpstreamHttpVersion } from "../../lib/upstream-http-version";
import { providerTlsFetch } from "../../lib/provider-tls-profile";
import { testProviderFetch } from "../../lib/test-provider-fetch";
import { runtimeProviderFetch } from "../../lib/provider-runtime-fetch";

export { withUpstreamHttpVersion };

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}



export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

/** Canonical origin (scheme + host) for failure-attribution keys: http and
 * https for the same host must not share one ledger entry (#914 review). */
export function safeOriginLabel(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "upstream";
  }
}



export interface PaceAwareFetch {
  waitForPacing?: (signal?: AbortSignal) => Promise<void>;
  unpacedFetch?: typeof globalThis.fetch;
}

export type ProviderFetch = typeof globalThis.fetch & PaceAwareFetch;

export interface ProviderFetchOptions {
  providerName?: string;
  modelId?: string;
  /** One pacing slot was acquired immediately before this fetch wrapper was created. */
  pacingSlotAcquired?: boolean;
  /** Explicit test/integration executor; never read from serialized provider config. */
  fetch?: typeof globalThis.fetch;
}

export function providerFetch(
  provider: OcxProviderConfig,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  options: ProviderFetchOptions = {},
): ProviderFetch {
  const base = options.fetch ?? testProviderFetch(provider) ?? runtimeProviderFetch(provider, options.providerName) ?? globalThis.fetch;
  const preconnect = (...args: Parameters<typeof globalThis.fetch.preconnect>): void => {
    base.preconnect?.(...args);
  };
  const transport = options.providerName
    ? providerTlsFetch(options.providerName, provider, base)
    : base;
  const httpFetch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      transport(input, { ...withUpstreamHttpVersion(input, init, provider), timeout: 0 }),
    { preconnect },
  ) as typeof globalThis.fetch;
  // ChatGPT Codex backend: eligible streaming turns stay on HTTP/SSE by
  // default. `wsUpstream: true`, or (when that option is omitted)
  // OCX_CODEX_WS_UPSTREAM=true/1, opts into the responses_websockets transport;
  // everything else keeps the provider's HTTP fetch. See ws-upstream.ts for
  // the details.
  const wsOptions: CodexWsUpstreamOptions = {
    wsUpstream: provider.wsUpstream,
    maxWsFrameBytes: provider.maxWsFrameBytes,
  };
  const unpaced = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (typeof input === "string" && init && shouldUseCodexWsUpstream(input, init, runtime, wsOptions)) {
      // The fallback has to be the same HTTP fetch the non-WS branch would have
      // used, protocol pin included: a WS turn that falls back is serving the
      // request over HTTP, and dropping the provider's `upstreamHttpVersion`
      // there would silently negotiate a transport the operator ruled out.
      return codexWsUpstreamFetch(input, init, httpFetch, runtime, wsOptions);
    }
    return httpFetch(input, init);
  };
  let pacingSlotAcquired = options.pacingSlotAcquired === true;
  const waitForPacing = (signal?: AbortSignal) => {
    if (pacingSlotAcquired) {
      pacingSlotAcquired = false;
      return Promise.resolve();
    }
    return options.providerName
      ? waitForProviderRequestSlot(options.providerName, provider, options.modelId, signal)
      : Promise.resolve();
  };
  const wrapped = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    await waitForPacing(init?.signal ?? undefined);
    return unpaced(input, init);
  };
  return Object.assign(wrapped, {
    preconnect,
    waitForPacing,
    unpacedFetch: Object.assign(unpaced, { preconnect }),
  });
}



export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
  _manualRedirect = true,
): Promise<Response> {
  const pacing = executor as ProviderFetch;
  await pacing.waitForPacing?.(abortSignal);
  const fetchExecutor = pacing.unpacedFetch ?? executor;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  const headers = new Headers(init.headers);
  // Compressed SSE can be held until the decompressor has a complete block. Streaming calls
  // default to identity for low-latency frame delivery, while an explicit caller choice wins.
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    const response = await fetchExecutor(url, {
      ...init,
      headers,
      // Upstream URLs are configuration, not navigation. Refuse every redirect
      // so POST bodies and provider headers are never replayed to another hop.
      redirect: "manual",
      signal: AbortSignal.any([abortSignal, timeout.signal]),
      timeout: 0,
    });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* ignore cancellation failures */ }
      throw new Error(`upstream returned ${response.status} redirect; configure the final upstream URL directly`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
