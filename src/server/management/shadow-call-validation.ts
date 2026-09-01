import { shadowCallTargetsIntersect, shadowSourceModels } from "../../lib/shadow-call";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { routeConcreteModel, routeModel } from "../../router";
import type { OcxConfig } from "../../types";

/** Validate a prospective persisted shadow-call target against its resolved source identities. */
export function shadowCallTargetError(config: OcxConfig, targetModel: string | undefined): string | null {
  if (!targetModel) return null;
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (openai && !isCanonicalOpenAiForwardProvider(openai)) return null;

  let target;
  try {
    target = routeModel(config, targetModel);
  } catch {
    return "model must resolve to a configured provider";
  }

  const intersectsSource = shadowSourceModels(config.shadowCallIntercept?.sourceModels).some(sourceModel => {
    let source = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourceModel };
    try {
      const resolved = routeConcreteModel(config, sourceModel);
      source = { providerName: resolved.providerName, modelId: sourceModel };
    } catch { /* Unconfigured native Codex source models remain OpenAI-owned. */ }
    return shadowCallTargetsIntersect(source, target);
  });

  return intersectsSource
    ? "shadow-call target must not intersect a source model"
    : null;
}
