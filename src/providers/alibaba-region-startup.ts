import { mutatePersistedConfig } from "../config";
import { backupConfigBeforeAlibabaRegionMigration } from "./alibaba-region-backup";
import { projectAlibabaRegionMigration } from "./alibaba-region-migration";
import type { OcxConfig } from "../types";

export interface AlibabaRegionStartupDeps {
  project: typeof projectAlibabaRegionMigration;
  backup: () => void;
  save?: (config: OcxConfig) => void;
}

/**
 * Run the #457 recovery migration at startup.
 *
 * Fail-closed: a backup failure throws, and nothing between here and
 * `startServer` catches it, so the proxy does not start rather than rewriting
 * credentials without a rollback point. That is the same posture the OpenAI tier
 * migration takes.
 */
export function runAlibabaRegionStartupMigration(
  config: OcxConfig,
  deps: AlibabaRegionStartupDeps = {
    project: projectAlibabaRegionMigration,
    backup: () => { backupConfigBeforeAlibabaRegionMigration(); },
  },
): OcxConfig {
  if (deps.save) {
    const projection = deps.project(config);
    if (!projection.changed) {
      for (const warning of projection.warnings) console.warn(`[alibaba-region-migration] ${warning}`);
      return projection.config;
    }
    deps.backup();
    deps.save(projection.config);
    for (const warning of projection.warnings) console.warn(`[alibaba-region-migration] ${warning}`);
    return projection.config;
  }

  let previousSnapshot: string | undefined;
  const outcome = mutatePersistedConfig(fresh => {
    const snapshot = JSON.stringify(fresh);
    const next = deps.project(fresh);
    // The callback is repeated after freshness validation. Back up only the
    // confirmed preimage that is about to be committed.
    if (next.changed && snapshot === previousSnapshot) deps.backup();
    previousSnapshot = snapshot;
    if (next.changed) {
      for (const key of Object.keys(fresh)) delete (fresh as unknown as Record<string, unknown>)[key];
      Object.assign(fresh, next.config);
    }
    return { changed: next.changed, value: next };
  });
  if (outcome.status === "unavailable") return config;
  for (const warning of outcome.value.warnings) console.warn(`[alibaba-region-migration] ${warning}`);
  return outcome.value.config;
}
