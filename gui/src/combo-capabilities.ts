import type { ComboTarget } from "./combo-workspace-data";
import type { ModelOption } from "./components/combo-workspace-types";

/** Whether every selected target advertises image input (incomplete rows fail closed). */
export function comboImagesSupported(targets: ComboTarget[], models: ModelOption[]): boolean {
  if (targets.length === 0) return false;
  const imageTargets = new Set(
    models
      .filter((model) => model.inputModalities?.includes("image"))
      .map((model) => `${model.provider}\0${model.id}`),
  );
  return targets.every((target) => {
    const provider = target.provider.trim();
    const modelId = target.model.trim();
    if (!provider || !modelId) return false;
    return imageTargets.has(`${provider}\0${modelId}`);
  });
}
