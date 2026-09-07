/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 * A legacy bare `apiKey` is projected as one row on reads and seeded on first mutation.
 */
import { createHash } from "node:crypto";
import { isAzureIdentityProvider } from "../config/provider-validation";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { AccountQuotaFields } from "./quota-types";
import { commitProviderApiKeySelection } from "./api-key-selection";

export interface ProviderApiKeyInfo extends AccountQuotaFields {
  id: string;
  label?: string;
  /** First/last 4 chars only; env references (`${VAR}`) are shown verbatim (not secrets). */
  masked: string;
  active: boolean;
  addedAt?: number;
}

function isEnvReference(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function maskApiKey(value: string): string {
  // Env and keychain references carry no secret material; show them verbatim so an operator
  // can tell where the key lives.
  if (isEnvReference(value) || value.startsWith("keychain:")) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** Content-derived id: re-adding the same key upserts instead of duplicating. */
export function apiKeyPoolEntryId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** True for providers whose upstream auth is a configured API key (not oauth/forward). */
export function isKeyAuthProvider(provider: OcxProviderConfig): boolean {
  return !isAzureIdentityProvider(provider) && provider.authMode !== "oauth" && provider.authMode !== "forward";
}

/** Trim and reject blank / CRLF-bearing secrets. Shared by pool writes and OAuth upsert. */
export function sanitizeApiKeyValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

/** Seed the pool from a legacy bare `apiKey`, and keep `apiKey` mirrored to the active entry. */
function ensurePool(provider: OcxProviderConfig): NonNullable<OcxProviderConfig["apiKeyPool"]> {
  if (!provider.apiKeyPool) provider.apiKeyPool = [];
  if (provider.apiKeyPool.length === 0 && provider.apiKey) {
    provider.apiKeyPool.push({ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey });
  }
  return provider.apiKeyPool;
}

export function listProviderApiKeys(config: OcxConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  // A GET projects a legacy key without seeding/mutating live configuration.
  const pool = provider.apiKeyPool?.length
    ? provider.apiKeyPool
    : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
  const activeId = (pool.find(entry => entry.key === provider.apiKey) ?? pool[0])?.id ?? null;
  return {
    activeId,
    keys: pool.map(entry => ({
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      masked: maskApiKey(entry.key),
      active: entry.id === activeId,
      ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
    })),
  };
}

/** Add (or upsert) a key and make it ACTIVE. Persists config. */
export function addProviderApiKey(config: OcxConfig, name: string, key: string, label?: string): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  if (typeof key !== "string" || !key.trim()) return { error: "key is required" };
  const trimmed = sanitizeApiKeyValue(key);
  if (!trimmed) return { error: "key must not include line breaks" };
  const id = apiKeyPoolEntryId(trimmed);
  const committed = commitProviderApiKeySelection<{ id: string } | { error: string }>(config, name, fresh => {
    const pool = ensurePool(fresh);
    const existing = pool.find(entry => entry.key === trimmed);
    if (existing) {
      if (label?.trim()) existing.label = label.trim();
      fresh.apiKey = trimmed;
      return { changed: true, selectionChanged: true, value: { id: existing.id } };
    } else {
      if (pool.some(entry => entry.id === id)) {
        return { changed: false, value: { error: "key id collision" } };
      }
      pool.push({ id, key: trimmed, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
    }
    fresh.apiKey = trimmed;
    return { changed: true, selectionChanged: true, value: { id } };
  });
  return committed.status === "committed" ? committed.value : { error: "provider selection unavailable" };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const entry = provider.apiKeyPool?.find(e => e.id === id)
      ?? (!provider.apiKeyPool?.length && provider.apiKey && apiKeyPoolEntryId(provider.apiKey) === id
        ? { id, key: provider.apiKey } : undefined);
    if (!entry) return { changed: false, value: false };
    ensurePool(provider);
    provider.apiKey = entry.key;
    return { changed: true, selectionChanged: true, value: true };
  });
  return committed.status === "committed" && committed.value;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(config: OcxConfig, name: string, id: string, label: string | undefined): boolean {
  const configured = config.providers[name];
  if (!configured || !isKeyAuthProvider(configured)) return false;
  const configuredEntry = configured.apiKeyPool?.find(candidate => candidate.id === id)
    ?? (!configured.apiKeyPool?.length && configured.apiKey && apiKeyPoolEntryId(configured.apiKey) === id
      ? { id, key: configured.apiKey } : undefined);
  if (!configuredEntry) return false;
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const entry = provider.apiKeyPool?.find(candidate => candidate.id === id)
      ?? (!provider.apiKeyPool?.length && provider.apiKey && apiKeyPoolEntryId(provider.apiKey) === id
        ? { id, key: provider.apiKey } : undefined);
    if (!entry) return { changed: false, value: false };
    const persistedEntry = ensurePool(provider).find(candidate => candidate.id === id)!;
    if (label) persistedEntry.label = label;
    else delete persistedEntry.label;
    return { changed: true, value: true };
  });
  return committed.status === "committed" && committed.value;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry) return { changed: false, value: false };
    provider.apiKeyPool = pool.filter(e => e.id !== id);
    if (provider.apiKey === entry.key) {
      const next = provider.apiKeyPool[0];
      if (next) provider.apiKey = next.key;
      else delete provider.apiKey;
    }
    if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
    return { changed: true, value: true };
  });
  return committed.status === "committed" && committed.value;
}
