import { configuredAdminToken } from "../../src/lib/admin-secrets";
import {
  mutatePersistedConfig,
  saveConfigPreservingClaudeCode,
  type PersistedConfigMutation,
  type PersistedConfigMutationOutcome,
} from "../../src/config";
import type { ManagementApiDeps } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";

function isLocalManagementRequest(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://127.0.0.1");
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    return loopback && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Test transport: authenticate local management requests without changing data/upstream traffic. */
export function managementFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isLocalManagementRequest(input)) return globalThis.fetch(input, init);
  const headers = managementHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("x-opencodex-api-key")) return globalThis.fetch(input, init);
  if (input instanceof Request) {
    return globalThis.fetch(new Request(input, { headers }), init ? { ...init, headers } : undefined);
  }
  return globalThis.fetch(input, { ...init, headers });
}

/** Headers for callers that must retain a captured fetch implementation. */
export function managementHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const token = configuredAdminToken();
  if (token && !headers.has("x-opencodex-api-key")) headers.set("x-opencodex-api-key", token);
  return headers;
}

/** Direct-handler test request with the Host header an actual HTTP server would provide. */
export class ManagementRequest extends globalThis.Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const raw = input instanceof globalThis.Request ? input.url : String(input);
    const url = new URL(raw, "http://127.0.0.1");
    const headers = new Headers(init?.headers ?? (input instanceof globalThis.Request ? input.headers : undefined));
    if (isLocalManagementRequest(input) && !headers.has("Host")) headers.set("Host", url.host);
    super(input, { ...init, headers });
  }
}

/** Direct management dispatches that deliberately use a fixture rather than disk. */
export function inMemoryManagementPersistence(config: OcxConfig): Pick<ManagementApiDeps, "saveConfigPreservingClaudeCode" | "mutatePersistedConfig"> {
  return {
    saveConfigPreservingClaudeCode: () => {},
    mutatePersistedConfig<T>(mutate: (persisted: OcxConfig) => PersistedConfigMutation<T>): PersistedConfigMutationOutcome<T> {
      const candidate = structuredClone(config);
      const result = mutate(candidate);
      if (!result.changed) return { status: "unchanged", value: result.value };
      for (const key of Object.keys(config)) delete (config as Record<string, unknown>)[key];
      Object.assign(config, candidate);
      return { status: "committed", value: result.value };
    },
  };
}

/** Direct management dispatches whose test has already isolated OPENCODEX_HOME. */
export function isolatedDiskManagementPersistence(): Pick<ManagementApiDeps, "saveConfigPreservingClaudeCode" | "mutatePersistedConfig"> {
  return { saveConfigPreservingClaudeCode, mutatePersistedConfig };
}
