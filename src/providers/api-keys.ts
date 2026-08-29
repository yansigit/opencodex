/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 * A provider with a legacy bare `apiKey` is seeded into a one-entry pool on first touch.
 */
import { createHash } from "node:crypto";
import { mutatePersistedConfig } from "../config";
import { isAzureIdentityProvider } from "../config/provider-validation";
import type { OcxConfig, OcxProviderConfig } from "../types";

export interface ProviderApiKeyInfo {
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
  if (isEnvReference(value)) return value;
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

function activeEntryId(provider: OcxProviderConfig): string | null {
  const pool = provider.apiKeyPool ?? [];
  if (pool.length === 0) return null;
  return (pool.find(e => e.key === provider.apiKey) ?? pool[0]!).id;
}

function mutateProvider<T>(
  config: OcxConfig,
  name: string,
  mutate: (provider: OcxProviderConfig) => T | null,
): T | null {
  const outcome = mutatePersistedConfig(fresh => {
    const provider = fresh.providers[name];
    if (!provider || !isKeyAuthProvider(provider)) return { changed: false, value: null };
    const before = JSON.stringify(provider);
    const value = mutate(provider);
    return { changed: value !== null && JSON.stringify(provider) !== before, value: value === null ? null : { provider, value } };
  });
  if (outcome.status === "unavailable" || outcome.value === null) return null;
  config.providers[name] = structuredClone(outcome.value.provider);
  return outcome.value.value;
}

export function listProviderApiKeys(config: OcxConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  const pool = ensurePool(provider);
  const activeId = activeEntryId(provider);
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
  const saved = mutateProvider(config, name, fresh => {
    const pool = ensurePool(fresh);
    const existing = pool.find(entry => entry.id === id);
    if (existing) {
      if (label?.trim()) existing.label = label.trim();
    } else {
      pool.push({ id, key: trimmed, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
    }
    fresh.apiKey = trimmed;
    return id;
  });
  return saved === null ? { error: "config is unavailable" } : { id: saved };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  return mutateProvider(config, name, fresh => {
    const entry = ensurePool(fresh).find(candidate => candidate.id === id);
    if (!entry) return null;
    fresh.apiKey = entry.key;
    return true;
  }) === true;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(config: OcxConfig, name: string, id: string, label: string | undefined): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  return mutateProvider(config, name, fresh => {
    const entry = ensurePool(fresh).find(candidate => candidate.id === id);
    if (!entry) return null;
    if (label) entry.label = label;
    else delete entry.label;
    return true;
  }) === true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  return mutateProvider(config, name, fresh => {
    const pool = ensurePool(fresh);
    const entry = pool.find(candidate => candidate.id === id);
    if (!entry) return null;
    fresh.apiKeyPool = pool.filter(candidate => candidate.id !== id);
    if (fresh.apiKey === entry.key) {
      const next = fresh.apiKeyPool[0];
      if (next) fresh.apiKey = next.key;
      else delete fresh.apiKey;
    }
    if (fresh.apiKeyPool.length === 0) delete fresh.apiKeyPool;
    return true;
  }) === true;
}
