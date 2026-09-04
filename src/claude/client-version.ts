/**
 * Read-only Claude Code client version diagnostics.
 *
 * This module deliberately owns only advisory evidence. Launchers remain the
 * authority on whether Claude can actually start.
 */
import { spawnSync } from "node:child_process";
import { commandInvocation, type SpawnInvocation } from "../lib/win-exec";

export const CLAUDE_CODE_COMPATIBILITY_FLOOR = "2.1.201";

export type ClaudeClientState =
  | "compatible"
  | "outdated"
  | "missing"
  | "timed-out"
  | "unparseable";

export type ClaudeClientSource = "path" | "windows-executable" | "windows-command-shim";

export interface ClaudeClientVersion {
  readonly state: ClaudeClientState;
  readonly version: string | null;
  readonly source: ClaudeClientSource;
}

export interface ClaudeVersionProbeOutput {
  readonly stdout?: string | Uint8Array | null;
  readonly status?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error | { readonly code?: unknown } | null;
}

export interface ClaudeVersionProbeOptions {
  readonly encoding: "utf8";
  readonly timeout: 5_000;
  readonly windowsHide: true;
  readonly windowsVerbatimArguments?: boolean;
}

/** Narrow synchronous runner seam for deterministic diagnostic tests. */
export interface ClaudeClientProbeDeps {
  readonly versionProbe?: (
    file: string,
    args: readonly string[],
    options: ClaudeVersionProbeOptions,
  ) => ClaudeVersionProbeOutput;
  readonly platform?: NodeJS.Platform;
  readonly commandInvocation?: (
    command: string,
    args: readonly string[],
    platform?: NodeJS.Platform,
  ) => SpawnInvocation;
}

/** Accept a Claude version only when it begins the version banner. */
export function parseClaudeClientVersion(raw: string | Uint8Array | null | undefined): string | null {
  const text = typeof raw === "string"
    ? raw
    : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "";
  const match = text.match(/^\s*v?(\d+\.\d+\.\d+)(?:\s|$)/i);
  return match?.[1] ?? null;
}

/** Compare strict dotted versions. Returns a negative value when a < b. */
export function compareClaudeClientVersions(a: string, b: string): number {
  const left = a.split(".").map(part => Number.parseInt(part, 10));
  const right = b.split(".").map(part => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function sourceForInvocation(invocation: SpawnInvocation, platform: NodeJS.Platform): ClaudeClientSource {
  if (platform !== "win32") return "path";
  return invocation.options.windowsVerbatimArguments ? "windows-command-shim" : "windows-executable";
}

function errorCode(output: ClaudeVersionProbeOutput): string | null {
  const error = output.error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : null;
}

/** Classify probe evidence without retaining raw process output or errors. */
export function classifyClaudeClientVersion(
  output: ClaudeVersionProbeOutput,
  source: ClaudeClientSource = "path",
): ClaudeClientVersion {
  const code = errorCode(output);
  if (code === "ENOENT" || output.status === 9_009) {
    return { state: "missing", version: null, source };
  }
  if (output.error !== null && output.error !== undefined
    || output.signal !== null && output.signal !== undefined) {
    return { state: "timed-out", version: null, source };
  }
  const version = parseClaudeClientVersion(output.stdout);
  if (!version) return { state: "unparseable", version: null, source };
  return {
    state: compareClaudeClientVersions(version, CLAUDE_CODE_COMPATIBILITY_FLOOR) >= 0
      ? "compatible"
      : "outdated",
    version,
    source,
  };
}

function productionVersionProbe(
  file: string,
  args: readonly string[],
  options: ClaudeVersionProbeOptions,
): ClaudeVersionProbeOutput {
  return spawnSync(file, [...args], options);
}

/**
 * Probe the Claude executable once, synchronously, and degrade to a typed
 * diagnostic on every failure. The result is advisory and contains no raw
 * subprocess data or resolved path.
 */
export function probeClaudeClientVersion(deps: ClaudeClientProbeDeps = {}): ClaudeClientVersion {
  const platform = deps.platform ?? process.platform;
  const buildInvocation = deps.commandInvocation ?? commandInvocation;
  let invocation: SpawnInvocation;
  try {
    invocation = buildInvocation("claude", ["--version"], platform);
  } catch {
    return { state: "timed-out", version: null, source: platform === "win32" ? "windows-executable" : "path" };
  }
  const source = sourceForInvocation(invocation, platform);
  try {
    const output = (deps.versionProbe ?? productionVersionProbe)(invocation.file, invocation.args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      ...invocation.options,
    });
    return classifyClaudeClientVersion(output, source);
  } catch {
    return { state: "timed-out", version: null, source };
  }
}
