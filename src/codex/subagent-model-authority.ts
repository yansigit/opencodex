import type { OcxConfig } from "../types";
import { isEligibleV2SubagentEntry, readCatalog, readCodexCatalogPath } from "./catalog";
import { catalogEntryEfforts } from "./catalog/effort";
import type { RawEntry } from "./catalog/parsing";
import { resolveNativeDefaultState, type NativeDefaultState } from "./subagent-defaults";

export const SUBAGENT_MODEL_AUTHORITY_VERSION = 1 as const;

export interface SubagentModelAuthorityInput {
  schemaVersion: typeof SUBAGENT_MODEL_AUTHORITY_VERSION;
  role: string;
  agentType: string;
  typedDispatchRequired?: boolean;
  requestedModel?: string;
  requestedEffort?: string;
  spawnAgent: {
    surface: "v1" | "v2";
    supportsAgentType: boolean;
    supportsModel: boolean;
    supportsEffort: boolean;
    supportsForkTurns: boolean;
  };
  confirmation?: { decision: "approve" | "decline" };
  interactive?: boolean;
}

export interface SubagentModelAuthorityHost {
  catalogState: "fresh" | "stale" | "not_running" | "unknown";
  nativeDefaultState: NativeDefaultState;
  preferredModel: string | null;
  preferredEffort: string | null;
  executableModels: Array<{ model: string; efforts: string[] }>;
}

export type SubagentModelAuthorityResult = {
  schemaVersion: typeof SUBAGENT_MODEL_AUTHORITY_VERSION;
  decision: "forward" | "omit" | "confirm" | "blocked";
  requestClassification: "inherit" | "preferred" | "exception";
  reason: string;
  spawn?: {
    agent_type?: string;
    model?: string;
    reasoning_effort?: string;
    fork_turns?: "none";
  };
  confirmation?: {
    role: string;
    preferredModel: string | null;
    requestedModel: string;
    scope: "single spawn";
  };
};

export function parseSubagentModelAuthorityInput(value: unknown): SubagentModelAuthorityInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const spawn = input.spawnAgent;
  if (!spawn || typeof spawn !== "object" || Array.isArray(spawn)) return null;
  const tool = spawn as Record<string, unknown>;
  if (input.schemaVersion !== SUBAGENT_MODEL_AUTHORITY_VERSION
    || typeof input.role !== "string"
    || typeof input.agentType !== "string"
    || (input.typedDispatchRequired !== undefined && typeof input.typedDispatchRequired !== "boolean")
    || (input.requestedModel !== undefined && typeof input.requestedModel !== "string")
    || (input.requestedEffort !== undefined && typeof input.requestedEffort !== "string")
    || (input.interactive !== undefined && typeof input.interactive !== "boolean")
    || (tool.surface !== "v1" && tool.surface !== "v2")
    || ["supportsAgentType", "supportsModel", "supportsEffort", "supportsForkTurns"]
      .some(key => typeof tool[key] !== "boolean")) return null;
  if (input.confirmation !== undefined) {
    if (!input.confirmation || typeof input.confirmation !== "object" || Array.isArray(input.confirmation)) return null;
    const decision = (input.confirmation as Record<string, unknown>).decision;
    if (decision !== "approve" && decision !== "decline") return null;
  }
  return value as SubagentModelAuthorityInput;
}

function result(
  decision: SubagentModelAuthorityResult["decision"],
  requestClassification: SubagentModelAuthorityResult["requestClassification"],
  reason: string,
  extra: Pick<SubagentModelAuthorityResult, "spawn" | "confirmation"> = {},
): SubagentModelAuthorityResult {
  return { schemaVersion: SUBAGENT_MODEL_AUTHORITY_VERSION, decision, requestClassification, reason, ...extra };
}

export function resolveSubagentModelAuthority(
  input: SubagentModelAuthorityInput,
  host: SubagentModelAuthorityHost,
): SubagentModelAuthorityResult {
  const requestedModel = input.requestedModel?.trim() || undefined;
  const preferredModel = host.preferredModel?.trim() || undefined;
  const classification = requestedModel === undefined
    ? "inherit"
    : requestedModel === preferredModel ? "preferred" : "exception";
  if (input.schemaVersion !== SUBAGENT_MODEL_AUTHORITY_VERSION) {
    return result("blocked", classification, "unsupported authority schema version");
  }
  if (!input.role.trim() || !input.agentType.trim()) {
    return result("blocked", classification, "role and agentType must be non-empty");
  }
  if (input.typedDispatchRequired && !input.spawnAgent.supportsAgentType) {
    return result("blocked", classification, "spawn_agent does not support required agent_type dispatch");
  }
  if (host.catalogState === "stale" || host.catalogState === "unknown") {
    return result("blocked", classification, "OpenCodex model authority is not current; sync or restart Codex and retry");
  }

  const chosenModel = requestedModel ?? preferredModel;
  const executable = chosenModel
    ? host.executableModels.find(candidate => candidate.model === chosenModel)
    : undefined;
  if (chosenModel && !executable) {
    return result("blocked", classification, `model ${JSON.stringify(chosenModel)} is not executable on this collaboration surface`);
  }
  if (chosenModel && !input.spawnAgent.supportsModel) {
    return result("blocked", classification, "spawn_agent does not support model overrides");
  }
  const effort = input.requestedEffort?.trim() || (requestedModel ? undefined : host.preferredEffort?.trim()) || undefined;
  if (effort && !input.spawnAgent.supportsEffort) {
    return result("blocked", classification, "spawn_agent does not support reasoning_effort overrides");
  }
  if (effort && executable && !executable.efforts.includes(effort)) {
    return result("blocked", classification, `reasoning effort ${JSON.stringify(effort)} is unavailable for ${JSON.stringify(chosenModel)}`);
  }

  if (classification === "exception") {
    if (input.confirmation?.decision === "decline") {
      return result("blocked", classification, "single-spawn model exception was declined");
    }
    if (input.confirmation?.decision !== "approve") {
      if (input.interactive === false) {
        return result("blocked", classification, "single-spawn model exception requires interactive confirmation");
      }
      return result("confirm", classification, "confirm this model exception for one spawn", {
        confirmation: {
          role: input.role,
          preferredModel: preferredModel ?? null,
          requestedModel: requestedModel!,
          scope: "single spawn",
        },
      });
    }
  }

  if (!chosenModel) {
    return host.nativeDefaultState === "active"
      ? result("omit", classification, "native OpenCodex defaults are active")
      : result("blocked", classification, `native OpenCodex defaults are ${host.nativeDefaultState}`);
  }
  const spawn: NonNullable<SubagentModelAuthorityResult["spawn"]> = {
    ...(input.spawnAgent.supportsAgentType ? { agent_type: input.agentType } : {}),
    model: chosenModel,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...((input.spawnAgent.supportsForkTurns && (chosenModel || effort)) ? { fork_turns: "none" as const } : {}),
  };
  return result("forward", classification, classification === "exception"
    ? "single-spawn model exception approved"
    : "OpenCodex preferred model is executable", { spawn });
}

function executableModels(entries: readonly RawEntry[], surface: "v1" | "v2"): SubagentModelAuthorityHost["executableModels"] {
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    const model = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!model || seen.has(model) || entry.visibility !== "list" || (surface === "v2" && !isEligibleV2SubagentEntry(entry))) return [];
    seen.add(model);
    return [{ model, efforts: catalogEntryEfforts(entry) }];
  });
}

export async function resolveOpenCodexSubagentModelAuthority(
  input: SubagentModelAuthorityInput,
  config: OcxConfig,
): Promise<SubagentModelAuthorityResult> {
  const { collectCodexAppServerCatalogStateForRequest } = await import("./app-server-processes");
  const catalogState = await collectCodexAppServerCatalogStateForRequest();
  const models = executableModels(readCatalog(readCodexCatalogPath())?.models ?? [], input.spawnAgent.surface);
  const configured = config.injectionModel?.trim() || null;
  const exact = configured ? models.find(candidate => candidate.model === configured)?.model ?? null : null;
  const host: SubagentModelAuthorityHost = {
    catalogState: catalogState.state,
    nativeDefaultState: await resolveNativeDefaultState(config),
    preferredModel: exact,
    preferredEffort: config.injectionEffort?.trim() || null,
    executableModels: models,
  };
  return resolveSubagentModelAuthority(input, host);
}
