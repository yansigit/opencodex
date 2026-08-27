import type { Cost4, ExpectedPriceOverlay } from "./expected-prices";

export interface CommandCodeModelPricing {
  id: string;
  name: string;
  slug?: string;
  contextWindow?: number;
  cost4: Cost4;
}

export const COMMAND_CODE_MODELS_DATA_URL = "https://commandcode.ai/models.data";
export const COMMAND_CODE_PRICING_SOURCE = "https://commandcode.ai/models + https://commandcode.ai/models.data";

/**
 * Parse Command Code models and 4-tuple per-1M token rates from the Turbo-stream
 * payload served by https://commandcode.ai/models.data.
 */
export function parseCommandCodeModelsData(raw: unknown): CommandCodeModelPricing[] {
  if (!Array.isArray(raw) || raw.length < 10) return [];
  const modelIndices = raw[9];
  if (!Array.isArray(modelIndices)) return [];

  const resolve = (val: unknown): unknown => {
    if (typeof val === "number") {
      if (val < 0) return val === -5 ? null : undefined;
      if (val < raw.length) return raw[val];
    }
    return val;
  };

  const results: CommandCodeModelPricing[] = [];
  for (const idx of modelIndices) {
    if (typeof idx !== "number" || idx < 0 || idx >= raw.length) continue;
    const obj = raw[idx];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith("_")) continue;
      const keyIdx = Number.parseInt(k.slice(1), 10);
      if (!Number.isFinite(keyIdx) || keyIdx < 0 || keyIdx >= raw.length) continue;
      const keyName = raw[keyIdx];
      if (typeof keyName === "string" && keyName.length > 0) {
        fields[keyName] = resolve(v);
      }
    }

    const id = typeof fields.id === "string" ? fields.id.trim() : "";
    if (!id) continue;

    const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : id;
    const slug = typeof fields.slug === "string" && fields.slug.trim() ? fields.slug.trim() : undefined;
    const contextWindow = typeof fields.contextWindow === "number" && Number.isFinite(fields.contextWindow)
      ? fields.contextWindow
      : undefined;

    const input = typeof fields.inputCost === "number" && Number.isFinite(fields.inputCost) && fields.inputCost >= 0
      ? fields.inputCost
      : 0;
    const output = typeof fields.outputCost === "number" && Number.isFinite(fields.outputCost) && fields.outputCost >= 0
      ? fields.outputCost
      : 0;
    const cacheRead = typeof fields.cacheReadCost === "number" && Number.isFinite(fields.cacheReadCost) && fields.cacheReadCost >= 0
      ? fields.cacheReadCost
      : 0;
    const cacheWrite = typeof fields.cacheWriteCost === "number" && Number.isFinite(fields.cacheWriteCost) && fields.cacheWriteCost >= 0
      ? fields.cacheWriteCost
      : 0;

    results.push({
      id,
      name,
      ...(slug ? { slug } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      cost4: { input, output, cacheRead, cacheWrite },
    });
  }

  return results;
}

/**
 * Fetch and decode the latest Command Code model pricing from commandcode.ai.
 */
export async function fetchCommandCodeModelPricing(options?: {
  url?: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<CommandCodeModelPricing[]> {
  const fetcher = options?.fetchFn ?? fetch;
  const url = options?.url ?? COMMAND_CODE_MODELS_DATA_URL;
  const res = await fetcher(url, { signal: options?.signal });
  if (!res.ok) throw new Error(`Failed to fetch Command Code models data: ${res.status}`);
  const data = await res.json();
  return parseCommandCodeModelsData(data);
}

/**
 * Convert parsed Command Code models to opencodex ExpectedPriceOverlay entries.
 */
export function commandCodePricingToExpectedOverlays(
  models: readonly CommandCodeModelPricing[],
  verifiedAt = "2026-08-26",
): ExpectedPriceOverlay[] {
  return models
    .filter(m => m.cost4.input > 0 || m.cost4.output > 0 || m.cost4.cacheRead > 0 || m.cost4.cacheWrite > 0)
    .map(m => ({
      provider: "command-code",
      modelId: m.id,
      cost4: m.cost4,
      source: COMMAND_CODE_PRICING_SOURCE,
      verifiedAt,
      status: "verified",
    }));
}

