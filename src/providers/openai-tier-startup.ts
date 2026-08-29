import {
  backupConfigBeforeOpenAiTierMigration,
  OpenAiTierBackupCollisionError,
  OpenAiTierRollbackPreserveError,
  mutatePersistedConfig,
  preserveOpenAiTierRollbackSnapshot,
} from "../config";
import type { OcxConfig } from "../types";
import { projectOpenAiTierMigration } from "./openai-tiers";

export interface OpenAiTierStartupDeps {
  project: typeof projectOpenAiTierMigration;
  backup: () => void;
  save?: (config: OcxConfig) => void;
  preserveRollback?: (error: OpenAiTierBackupCollisionError) => void;
}

function defaultPreserveRollback(error: OpenAiTierBackupCollisionError): void {
  if (!error.configPath) throw error;
  try {
    const preserved = preserveOpenAiTierRollbackSnapshot(error.configPath);
    console.warn(`[openai-provider-migration] Preserved rollback snapshot at ${preserved}`);
  } catch (cause) {
    if (
      cause instanceof OpenAiTierRollbackPreserveError
      && (cause.code === "missing" || cause.code === "not-rollback")
    ) {
      throw error;
    }
    throw cause;
  }
}

const DEFAULT_DEPS: OpenAiTierStartupDeps = {
  project: projectOpenAiTierMigration,
  backup: backupConfigBeforeOpenAiTierMigration,
};

export function runOpenAiTierStartupMigration(
  config: OcxConfig,
  deps: OpenAiTierStartupDeps = DEFAULT_DEPS,
): OcxConfig {
  const backup = (): void => {
    try {
      deps.backup();
    } catch (error) {
      if (!(error instanceof OpenAiTierBackupCollisionError)) throw error;
      (deps.preserveRollback ?? defaultPreserveRollback)(error);
      deps.backup();
    }
  };
  if (deps.save) {
    const projection = deps.project(config);
    if (!projection.changed) return projection.config;
    backup();
    deps.save(projection.config);
    for (const warning of projection.warnings) console.warn(`[openai-provider-migration] ${warning}`);
    return projection.config;
  }

  let previousSnapshot: string | undefined;
  const outcome = mutatePersistedConfig(fresh => {
    const snapshot = JSON.stringify(fresh);
    const next = deps.project(fresh);
    // mutatePersistedConfig confirms a candidate by invoking us again with the same
    // snapshot after rebasing. Back up only that confirmed preimage.
    if (next.changed && snapshot === previousSnapshot) backup();
    previousSnapshot = snapshot;
    if (next.changed) {
      for (const key of Object.keys(fresh)) delete (fresh as unknown as Record<string, unknown>)[key];
      Object.assign(fresh, next.config);
    }
    return { changed: next.changed, value: next };
  });
  if (outcome.status === "unavailable") return config;
  if (outcome.status === "committed") {
    for (const warning of outcome.value.warnings) console.warn(`[openai-provider-migration] ${warning}`);
  }
  return outcome.value.config;
}
