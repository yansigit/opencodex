
import { PROVIDER_REGISTRY } from "./registry";

export function effectiveProviderAlias(
  providerName: string,
  provider?: Pick<OcxProviderConfig, "alias">,
  config?: Pick<OcxConfig, "providers">,
): string | undefined {
  const regAlias = PROVIDER_REGISTRY.find(e => e.id === providerName)?.alias;
  const configuredAlias = provider?.alias;
  const candidate = configuredAlias !== undefined ? configuredAlias.trim() : regAlias;
  if (!candidate) return undefined;
  if (config?.providers) {
    const lower = candidate.toLowerCase();
    const candidateIsRegistryDefault = regAlias?.toLowerCase() === lower;
    const claimedByOther = Object.entries(config.providers).some(([name, p]) => {
      if (name === providerName) return false;
      if (name.toLowerCase() === lower) return true;
      if (typeof p.alias !== "string" || p.alias.trim().toLowerCase() !== lower) return false;
      const otherRegistryAlias = PROVIDER_REGISTRY.find(entry => entry.id === name)?.alias;
      const otherClaimIsRegistryDefault = otherRegistryAlias?.toLowerCase() === lower;
      // A custom alias outranks a materialized registry default. Equal-priority claims are
      // suppressed so direct/legacy configs cannot make routing depend on insertion order.
      return candidateIsRegistryDefault || !otherClaimIsRegistryDefault;
    });
    if (claimedByOther) return undefined;
  }
  return candidate;
}

export function effectiveProviderAliasDecision(
  providerName: string,
  provider?: Pick<OcxProviderConfig, "alias">,
  config?: Pick<OcxConfig, "providers">,
): string | null | undefined {
  const active = effectiveProviderAlias(providerName, provider, config);
  if (active !== undefined) return active;
  const hasRegistryAlias = Boolean(PROVIDER_REGISTRY.find(e => e.id === providerName)?.alias);
  const hasConfiguredAlias = provider?.alias !== undefined;
  if (hasRegistryAlias || hasConfiguredAlias) {
    return null;
  }
  return undefined;
}

import type { OcxConfig, OcxProviderConfig } from "../types";

export const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ordered, most-specific-first built-in aliases. Updated with the provider registry. */
export const DEFAULT_MODEL_ALIASES: ReadonlyArray<{ match: RegExp; alias: string }> = [
  { match: /^claude-opus-5/, alias: "opus" },
  { match: /^claude-sonnet-5/, alias: "sonnet" },
  { match: /^claude-haiku/, alias: "haiku" },
  { match: /^gemini-3(?:\.\d+)?-pro/, alias: "g3p" },
  { match: /^gemini-3(?:\.\d+)?-flash/, alias: "g3f" },
  { match: /^deepseek-v4/, alias: "ds4" },
  { match: /^grok-4/, alias: "grok" },
];

export interface EffectiveModelAlias { alias: string; source: "user" | "builtin" }

function builtinRule(id: string): { match: RegExp; alias: string } | undefined {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  return DEFAULT_MODEL_ALIASES.find(rule => rule.match.test(id) || rule.match.test(tail));
}

export function defaultAliasesEnabled(config: Pick<OcxConfig, "defaultModelAliases">, provider: OcxProviderConfig): boolean {
  return provider.defaultAliases ?? config.defaultModelAliases ?? false;
}

export function effectiveModelAliases(
  config: Pick<OcxConfig, "defaultModelAliases">,
  provider: OcxProviderConfig,
  knownIds: Iterable<string>,
): Map<string, EffectiveModelAlias> {
  const result = new Map<string, EffectiveModelAlias>();
  for (const [id, alias] of Object.entries(provider.modelAliases ?? {})) {
    if (typeof alias === "string" && MODEL_ALIAS_PATTERN.test(alias)) result.set(id, { alias, source: "user" });
  }
  if (!defaultAliasesEnabled(config, provider)) return result;
  const claims = new Map<string, string[]>();
  for (const id of knownIds) {
    if (result.has(id)) continue;
    const rule = builtinRule(id);
    if (!rule) continue;
    const key = rule.alias.toLowerCase();
    claims.set(key, [...(claims.get(key) ?? []), id]);
  }
  for (const [alias, ids] of claims) {
    if (ids.length !== 1) continue;
    const id = ids[0]!;
    // Catalog drift must skip, never shadow, a native id or explicit user alias.
    if ([...knownIds].some(candidate => candidate.toLowerCase() === alias)) continue;
    if ([...result.values()].some(value => value.alias.toLowerCase() === alias)) continue;
    result.set(id, { alias: builtinRule(id)!.alias, source: "builtin" });
  }
  return result;
}

export function resolveModelAlias(
  config: Pick<OcxConfig, "defaultModelAliases">,
  provider: OcxProviderConfig,
  knownIds: Iterable<string>,
  requested: string,
): string | undefined {
  const needle = requested.toLowerCase();
  return [...effectiveModelAliases(config, provider, knownIds)]
    .find(([, value]) => value.alias.toLowerCase() === needle)?.[0];
}
