#!/usr/bin/env bun
/** Conservative Claude Code certification runner.
 * Hermetic mode is local-only and never uses the operator's credentials. Live mode requires
 * two explicit consent gates and permits only scenario-bounded provider requests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { buildClaudeEnv } from "../src/cli/claude";
import { gatherRoutedModels } from "../src/codex/catalog";
import { routedSlug, slugEquals } from "../src/providers/slug-codec";
import { knownModelIdsForProvider, routeModel } from "../src/router";
import { startServer } from "../src/server";
import { handleClaudeMessages } from "../src/server/claude-messages";
import { resolveTrustedWindowsTaskkillExe } from "../src/lib/windows-elevation";
import type { OcxConfig } from "../src/types";

const MODEL = "claude-cert-hermetic";
const CLI_MODEL = "claude-sonnet-4-5";
const ADMISSION_TOKEN = ["sk-ant-api03", "hermetic-certification-key"].join("-");
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 45_000;
const LIVE_MARKER = "OCX_CLAUDE_LIVE_OK";
const READ_MARKER = "OCX_CLAUDE_READ_OK";
const SUBAGENT_MARKER = "OCX_CLAUDE_SUBAGENT_OK";
const SUBAGENT_SYSTEM_MARKER = "OCX_CLAUDE_CHILD_SYSTEM";
const CONTEXT_MARKER = "OCX_CLAUDE_CONTEXT_OK";
const LONG_CONTEXT_BYTES = 128 * 1024;
const LIVE_INPUT_BYTE_CEILING = 768 * 1024;
const CREDENTIAL = /(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|CREDENTIAL|SECRET|PASSWORD|TOKEN)/i;
const PROXY = /^(?:HTTP|HTTPS|ALL)_PROXY$/i;
const CAPABILITY_ENV = /^(?:SSH_AUTH_SOCK|KUBECONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_ASKPASS|SSH_ASKPASS|DOCKER_CONFIG|NETRC)$/i;
const RUNTIME_INJECTION_ENV = /^(?:NODE_OPTIONS|BUN_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;

export type CertificationStatus = "live_pass" | "live_fail" | "skipped" | "hermetic_pass" | "hermetic_fail";
export type CertificationScenario = "basic" | "read-continuation" | "subagent" | "long-context";
export interface CertificationReport {
  mode: "hermetic" | "live";
  status: CertificationStatus;
  cliPresent: boolean;
  streaming: boolean;
  toolContinuation: boolean;
  scenario?: CertificationScenario;
  subagentObserved?: boolean;
  maxInputBytes?: number;
  maxPromptBytes?: number;
  discoveryPerformed?: boolean;
  requests: number;
  provider?: string;
  model?: string;
  durationMs?: number;
  httpStatus?: number;
  reason?: string;
}

export interface LiveOptions { provider: string; model: string; maxBudgetUsd: number; scenario: CertificationScenario }
interface ScenarioLimits { requests: number; maxTokens: number; timeoutMs: number }
const SCENARIO_LIMITS: Record<CertificationScenario, ScenarioLimits> = {
  basic: { requests: 1, maxTokens: 256, timeoutMs: 45_000 },
  "read-continuation": { requests: 4, maxTokens: 256, timeoutMs: 90_000 },
  subagent: { requests: 6, maxTokens: 256, timeoutMs: 120_000 },
  "long-context": { requests: 1, maxTokens: 256, timeoutMs: 90_000 },
};

export function parseLiveOptions(args: string[]): LiveOptions | { error: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--live", "--json", "--confirm-live-provider-charges"].includes(flag)) continue;
    if (!["--provider", "--model", "--max-budget-usd", "--scenario"].includes(flag) || values.has(flag)) return { error: "invalid live certification arguments" };
    const next = args[++i];
    if (!next || next.startsWith("--")) return { error: "provider, model, and max-budget-usd are required" };
    values.set(flag, next);
  }
  const provider = values.get("--provider"); const model = values.get("--model"); const budget = values.get("--max-budget-usd");
  if (!provider || !model || !budget || !/^[A-Za-z0-9._/-]+$/.test(provider) || !/^[A-Za-z0-9._/-]+$/.test(model)) return { error: "provider, model, and max-budget-usd are required" };
  const maxBudgetUsd = Number(budget); if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 5) return { error: "invalid max-budget-usd" };
  const scenario = values.get("--scenario") ?? "basic";
  if (!(scenario in SCENARIO_LIMITS)) return { error: "invalid certification scenario" };
  return { provider, model, maxBudgetUsd, scenario: scenario as CertificationScenario };
}

export function sanitizedChildEnv(base: Record<string, string | undefined>, dirs: { home: string; claude: string; ocx: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !CREDENTIAL.test(key) && !PROXY.test(key) && !CAPABILITY_ENV.test(key) && !RUNTIME_INJECTION_ENV.test(key) && !/^(?:AWS_ACCESS_KEY_ID|AWS_PROFILE|AWS_SESSION_TOKEN|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z0-9_]+)$/i.test(key) && key !== "OPENCODEX_HOME" && key !== "CLAUDE_CONFIG_DIR") out[key] = value;
  }
  out.HOME = dirs.home;
  out.CLAUDE_CONFIG_DIR = dirs.claude;
  out.OPENCODEX_HOME = dirs.ocx;
  out.NO_PROXY = "127.0.0.1,localhost,::1";
  out.ANTHROPIC_AUTH_TOKEN = ADMISSION_TOKEN;
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return out;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const n = await reader.read(); if (n.done) break; total += n.value.byteLength; if (total > MAX_OUTPUT) throw new Error("output limit exceeded"); chunks.push(n.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function command(exe: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs = TIMEOUT_MS, input?: string): Promise<{ code: number; out: string; err: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([exe, ...args], { cwd, env, detached: true, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" }); }
  catch { const error = new Error("missing executable"); error.name = "MissingExecutable"; throw error; }
  let termination: Promise<void> | undefined;
  let exited = false;
  const exitedPromise = child.exited.then(code => { exited = true; return code; });
  const terminate = () => termination ??= terminateProcessTree(child, () => exited);
  let timedOut = false;
  let reportTerminationFailure: (error: unknown) => void = () => {};
  const terminationFailure = new Promise<never>((_, reject) => { reportTerminationFailure = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (exited) return;
    void terminate().catch(error => reportTerminationFailure(error));
  }, timeoutMs);
  try {
    if (input !== undefined) { await child.stdin.write(input); child.stdin.end(); }
    const [code, out, err] = await Promise.race([
      Promise.all([exitedPromise, readBounded(child.stdout), readBounded(child.stderr)]),
      terminationFailure,
    ]);
    if (timedOut) throw new Error("timeout");
    return { code, out, err };
  }
  catch (error) {
    if (!exited) {
      try { await terminate(); }
      catch { throw new Error("process_tree_termination_failed", { cause: error }); }
    }
    throw error;
  }
  finally { clearTimeout(timer); }
}

export const runCertificationCommandForTests = command;

export function processTreeTerminationPlan(pid: number, platform: NodeJS.Platform, taskkill = "taskkill.exe"): { command: string[] } | { groupPid: number } {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid child pid");
  return platform === "win32"
    ? { command: [taskkill, "/PID", String(pid), "/T", "/F"] }
    : { groupPid: -pid };
}

async function terminateProcessTree(child: { pid: number; exited: Promise<number>; kill(signal?: NodeJS.Signals): void }, hasExited: () => boolean): Promise<void> {
  if (hasExited()) return;
  const waitForExit = async (): Promise<boolean> => await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
  if (process.platform === "win32") {
    if (hasExited()) return;
    let plan: { command: string[] };
    try { plan = processTreeTerminationPlan(child.pid, "win32", resolveTrustedWindowsTaskkillExe()) as { command: string[] }; }
    catch { throw new Error("process_tree_termination_failed"); }
    let exitCode: number;
    try { exitCode = Bun.spawnSync(plan.command, { stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode; }
    catch { exitCode = -1; }
    if (exitCode !== 0) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      if (await waitForExit()) throw new Error("process_tree_termination_failed");
      throw new Error("process_tree_termination_failed");
    }
    if (!(await waitForExit()) && !hasExited()) throw new Error("process_tree_termination_failed");
    return;
  }
  if (hasExited()) return;
  let signalledGroup = false;
  try {
    const plan = processTreeTerminationPlan(child.pid, process.platform) as { groupPid: number };
    process.kill(plan.groupPid, "SIGKILL");
    signalledGroup = true;
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  if (await waitForExit()) {
    if (!signalledGroup) throw new Error("process_tree_termination_failed");
    return;
  }
  throw new Error("process_tree_termination_failed");
}

function config(baseUrl: string): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "claude-cert", apiKeys: [{ id: "claude-cert", name: "claude-cert", key: ADMISSION_TOKEN, createdAt: "" }], claudeCode: { nativePassthrough: false, authMode: "proxy", modelMap: { [CLI_MODEL]: `claude-cert/${MODEL}` } }, providers: { "claude-cert": { adapter: "anthropic", baseUrl, authMode: "key", apiKey: "hermetic-cert-key", allowPrivateNetwork: true, liveModels: false, models: [MODEL] } } } as OcxConfig;
}

function sse(events: Array<{ event: string; data: unknown }>): Response { return new Response(events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } }); }

export async function runHermetic(cli = process.env.CLAUDE_BIN?.trim() || "claude"): Promise<CertificationReport> {
  const root = mkdtempSync(join(tmpdir(), "ocx-claude-cert-")); const dirs = { home: join(root, "home"), claude: join(root, "claude"), ocx: join(root, "ocx") };
  Object.values(dirs).forEach(d => mkdirSync(d, { recursive: true, mode: 0o700 }));
  const requests: unknown[] = []; const upstreamPaths: string[] = []; let upstream: ReturnType<typeof Bun.serve> | undefined; let proxy: ReturnType<typeof startServer> | undefined;
  const previousOcxHome = process.env.OPENCODEX_HOME;
  try {
    const markerPath = join(root, "marker.txt"); writeFileSync(markerPath, "CLAUDE_CERT_MARKER\n", { mode: 0o600 });
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const path = new URL(req.url).pathname; upstreamPaths.push(path); if (path !== "/v1/messages") return new Response("not found", { status: 404 }); const body = await req.json(); requests.push(body); const hasToolResult = JSON.stringify(body).includes("tool_result"); const first = !hasToolResult; const msg = { id: "msg_cert", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }; const events = first ? [{ event: "message_start", data: { type: "message_start", message: msg } }, { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "cert_tool", name: "Read", input: {} } } }, { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: markerPath }) } } }, { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } }, { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } } }, { event: "message_stop", data: { type: "message_stop" } }] : [{ event: "message_start", data: { type: "message_start", message: msg } }, { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CLAUDE_CERT_OK" } } }, { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } }, { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } }, { event: "message_stop", data: { type: "message_stop" } }]; return sse(events); } });
    process.env.OPENCODEX_HOME = dirs.ocx; saveConfig(config(new URL("/v1", upstream.url).toString())); proxy = startServer(0);
    const env = buildClaudeEnv(config(new URL("/v1", proxy.url).toString()), { baseUrl: proxy.url.toString(), admissionToken: ADMISSION_TOKEN }, sanitizedChildEnv(process.env, dirs), {}, { preBunAnthropicSlots: [] }); env.ANTHROPIC_MODEL = CLI_MODEL;
    let result; try { result = await command(cli, ["-p", "Read the marker file and print its contents.", "--model", CLI_MODEL, "--allowedTools", "Read", "--permission-mode", "dontAsk", "--output-format", "text"], root, env); } catch (error) { const missing = error instanceof Error && error.name === "MissingExecutable"; return { mode: "hermetic", status: missing ? "skipped" : "hermetic_fail", cliPresent: !missing, streaming: false, toolContinuation: false, requests: 0, reason: missing ? "Claude Code CLI unavailable" : (error instanceof Error ? error.message : "hermetic subprocess failure") }; }
    const text = `${result.out}\n${result.err}`; const first = requests[0] as { stream?: unknown } | undefined; const second = requests[1] as { messages?: unknown } | undefined; const streaming = first?.stream === true; const toolContinuation = typeof second?.messages === "object" && JSON.stringify(second.messages).includes("tool_result");
    const passed = result.code === 0 && text.includes("CLAUDE_CERT_OK") && streaming && toolContinuation && upstreamPaths.every(path => path.replace(/\/+$/, "") === "/v1/messages");
    return { mode: "hermetic", status: passed ? "hermetic_pass" : "hermetic_fail", cliPresent: true, streaming, toolContinuation, requests: requests.length, reason: passed ? undefined : (result.code !== 0 ? "Claude Code exited non-zero" : "hermetic protocol validation failed") };
  } finally { if (proxy) await proxy.stop(true); upstream?.stop(true); if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousOcxHome; rmSync(root, { recursive: true, force: true }); }
}

export function evaluateLivePolicy(args: { confirmFlag: boolean; allowEnv: boolean }): CertificationReport {
  if (!args.confirmFlag || !args.allowEnv) return { mode: "live", status: "skipped", cliPresent: false, streaming: false, toolContinuation: false, requests: 0, reason: "live certification requires --confirm-live-provider-charges and OCX_ALLOW_CLAUDE_LIVE_CERT=1" };
  return { mode: "live", status: "live_fail", cliPresent: false, streaming: false, toolContinuation: false, requests: 0, reason: "live inference harness is not enabled; no provider call was attempted" };
}

interface LiveObservation {
  requests: number;
  streaming: boolean;
  toolContinuation: boolean;
  subagentObserved: boolean;
  maxInputBytes: number;
  maxPromptBytes: number;
  limitExceeded: boolean;
  inputLimitExceeded: boolean;
  hadHttpError: boolean;
  httpStatus?: number;
}

function containsContentType(value: unknown, expected: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => containsContentType(item, expected));
  const record = value as Record<string, unknown>;
  return record.type === expected || Object.values(record).some(item => containsContentType(item, expected));
}

function messageTextBytes(body: Record<string, unknown>): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") total += new TextEncoder().encode(record.text).byteLength;
    else for (const item of Object.values(record)) visit(item);
  };
  if (typeof body.messages === "string") total += new TextEncoder().encode(body.messages).byteLength;
  else visit(body.messages);
  return total;
}

function hasToolExchange(
  body: Record<string, unknown>,
  toolName: string,
  matchesInput: (input: Record<string, unknown>) => boolean,
  matchesResult: (result: Record<string, unknown>) => boolean,
): boolean {
  const uses = new Set<string>();
  const results = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && record.name === toolName && typeof record.id === "string" && record.input && typeof record.input === "object" && !Array.isArray(record.input) && matchesInput(record.input as Record<string, unknown>)) uses.add(record.id);
    if (record.type === "tool_result" && typeof record.tool_use_id === "string" && matchesResult(record)) results.add(record.tool_use_id);
    for (const item of Object.values(record)) visit(item);
  };
  visit(body.messages);
  return [...uses].some(id => results.has(id));
}

export function inspectScenarioRequestBody(
  scenario: CertificationScenario,
  body: Record<string, unknown>,
  root: string,
): { promptBytes: number; toolContinuation: boolean; subagentObserved: boolean } {
  const systemText = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
  const toolContinuation = scenario === "read-continuation"
    ? hasToolExchange(body, "Read", input => input.file_path === join(root, "read-marker.txt"), result => JSON.stringify(result.content ?? "").includes(READ_MARKER))
    : scenario === "subagent"
      ? hasToolExchange(body, "Agent", input => input.subagent_type === "cert-worker", result => JSON.stringify(result.content ?? "").includes(SUBAGENT_MARKER))
      : containsContentType(body, "tool_result");
  return { promptBytes: messageTextBytes(body), toolContinuation, subagentObserved: systemText.includes(SUBAGENT_SYSTEM_MARKER) };
}

export function assessLiveScenario(
  scenario: CertificationScenario,
  observation: LiveObservation,
  exitCode: number,
  output: string,
): { passed: boolean; reason?: string } {
  if (observation.limitExceeded) return { passed: false, reason: "request_limit" };
  if (observation.inputLimitExceeded) return { passed: false, reason: "input_limit" };
  if (observation.hadHttpError || (observation.httpStatus !== undefined && observation.httpStatus >= 400)) return { passed: false, reason: "upstream_http" };
  if (exitCode !== 0) return { passed: false, reason: "client_nonzero" };
  if (!observation.streaming) return { passed: false, reason: "non_streaming" };
  if (scenario === "basic") {
    if (observation.requests !== 1) return { passed: false, reason: "request_count" };
    return output.trim() === LIVE_MARKER ? { passed: true } : { passed: false, reason: "marker_mismatch" };
  }
  if (scenario === "read-continuation") {
    if (!observation.toolContinuation || observation.requests < 2) return { passed: false, reason: "tool_not_used" };
    return output.includes(READ_MARKER) ? { passed: true } : { passed: false, reason: "marker_mismatch" };
  }
  if (scenario === "subagent") {
    if (!observation.subagentObserved || !observation.toolContinuation || observation.requests < 2) return { passed: false, reason: "subagent_not_observed" };
    return output.includes(SUBAGENT_MARKER) ? { passed: true } : { passed: false, reason: "marker_mismatch" };
  }
  if (observation.requests !== 1) return { passed: false, reason: "request_count" };
  if (observation.maxPromptBytes < LONG_CONTEXT_BYTES) return { passed: false, reason: "context_too_short" };
  return output.trim() === CONTEXT_MARKER ? { passed: true } : { passed: false, reason: "marker_mismatch" };
}

function longContextPrompt(): string {
  const sentence = "amber cedar delta ember fjord granite harbor iris juniper kinetic lumen mosaic. ";
  const filler = sentence.repeat(Math.ceil(LONG_CONTEXT_BYTES / sentence.length)).slice(0, LONG_CONTEXT_BYTES);
  return `${filler}\nThe verification marker is ${CONTEXT_MARKER}. Reply with exactly that marker and nothing else.`;
}

function scenarioCommand(scenario: CertificationScenario, root: string): { args: string[]; input?: string } {
  const common = ["--model", CLI_MODEL, "--restricted", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text"];
  if (scenario === "basic") return { args: ["-p", `Reply with exactly ${LIVE_MARKER} and nothing else.`, ...common, "--tools", ""] };
  if (scenario === "read-continuation") return { args: ["-p", `Use the Read tool once on ${join(root, "read-marker.txt")}, then reply with exactly ${READ_MARKER}.`, ...common, "--allowedTools", "Read"] };
  if (scenario === "subagent") {
    const agents = JSON.stringify({ "cert-worker": { description: "Certification worker", prompt: `${SUBAGENT_SYSTEM_MARKER}. Reply with exactly ${SUBAGENT_MARKER}.`, tools: [], model: CLI_MODEL, maxTurns: 1 } });
    return { args: ["-p", `Use the Agent tool to delegate to cert-worker. Then reply with exactly ${SUBAGENT_MARKER}.`, ...common, "--agents", agents, "--allowedTools", "Agent"] };
  }
  return { args: ["-p", ...common, "--tools", ""], input: longContextPrompt() };
}

export function liveConfig(
  source: OcxConfig,
  providerName: string,
  modelId: string,
  discoveredModelIds: readonly string[] = [],
): OcxConfig {
  const provider = source.providers[providerName];
  if (!provider || provider.disabled === true) throw new Error("route_unavailable");
  if ((source.disabledModels ?? []).some(stored => slugEquals(stored, providerName, modelId))) {
    throw new Error("route_unavailable");
  }
  const knownModels = new Set([
    ...knownModelIdsForProvider(providerName, provider, source),
    ...(provider.models ?? []),
    ...(provider.selectedModels ?? []),
    ...(provider.defaultModel ? [provider.defaultModel] : []),
    ...discoveredModelIds,
  ]);
  const nativeOpenAiModel = providerName === "openai"
    && provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && /^(?:gpt-|o\d)/i.test(modelId);
  if (!knownModels.has(modelId) && !nativeOpenAiModel) throw new Error("route_unavailable");
  const isolatedProvider = {
    ...provider,
    models: knownModels.has(modelId)
      ? [...new Set([...(provider.models ?? []), modelId])]
      : provider.models,
  };
  const target = routeModel(
    { ...source, providers: { ...source.providers, [providerName]: isolatedProvider } },
    routedSlug(providerName, modelId),
  );
  if (target.providerName !== providerName || target.modelId !== modelId || target.combo) throw new Error("route_unavailable");
  return {
    ...source,
    defaultProvider: providerName,
    emptyCompletionRetry: false,
    images: undefined,
    webSearchSidecar: undefined,
    visionSidecar: undefined,
    anthropicAccountPool: { enabled: false },
    cursorAccountPool: { enabled: false },
    oauthAccountFailover: { enabled: false },
    combos: undefined,
    routingProfiles: undefined,
    claudeCode: {
      ...source.claudeCode,
      enabled: true,
      authMode: "proxy",
      nativePassthrough: false,
      webSearchSidecar: undefined,
      visionSidecar: undefined,
      modelMap: { [CLI_MODEL]: routedSlug(providerName, modelId) },
    },
    providers: {
      [providerName]: {
        ...isolatedProvider,
        retryOn429: undefined,
        replayTransientFailures: false,
        transientRetryOn5xx: undefined,
        oauthAccountFailover: { ...provider.oauthAccountFailover, enabled: false },
      },
    },
  };
}

export async function runLive(options: LiveOptions, cli = process.env.CLAUDE_BIN?.trim() || "claude"): Promise<CertificationReport> {
  const started = Date.now();
  const limits = SCENARIO_LIMITS[options.scenario];
  let discoveryPerformed = false;
  let source: OcxConfig;
  let cfg: OcxConfig;
  try {
    source = loadConfig();
    const provider = source.providers[options.provider];
    if (!provider || provider.disabled === true) throw new Error("route_unavailable");
    const nativeOpenAiModel = options.provider === "openai"
      && provider.adapter === "openai-responses"
      && provider.authMode === "forward"
      && /^(?:gpt-|o\d)/i.test(options.model);
    const alreadyKnown = knownModelIdsForProvider(options.provider, provider, source).includes(options.model)
      || provider.selectedModels?.includes(options.model) === true
      || nativeOpenAiModel;
    if (!alreadyKnown) discoveryPerformed = true;
    const discoveredModelIds = alreadyKnown
      ? []
      : (await gatherRoutedModels({
          ...source,
          defaultProvider: options.provider,
          providers: { [options.provider]: provider },
          combos: undefined,
          routingProfiles: undefined,
        })).filter(model => model.provider === options.provider).map(model => model.id);
    cfg = liveConfig(source, options.provider, options.model, discoveredModelIds);
  } catch {
    return { mode: "live", status: "live_fail", cliPresent: true, streaming: false, toolContinuation: false, scenario: options.scenario, discoveryPerformed, requests: 0, provider: options.provider, model: options.model, durationMs: Date.now() - started, reason: "route_unavailable" };
  }

  const root = mkdtempSync(join(tmpdir(), "ocx-claude-live-cert-"));
  const dirs = { home: join(root, "home"), claude: join(root, "claude"), ocx: join(root, "ocx") };
  Object.values(dirs).forEach(dir => mkdirSync(dir, { recursive: true, mode: 0o700 }));
  const observation: LiveObservation = { requests: 0, streaming: false, toolContinuation: false, subagentObserved: false, maxInputBytes: 0, maxPromptBytes: 0, limitExceeded: false, inputLimitExceeded: false, hadHttpError: false };
  let bridge: ReturnType<typeof Bun.serve> | undefined;
  try {
    bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
        const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
        const apiKey = req.headers.get("x-api-key")?.trim();
        if (bearer !== ADMISSION_TOKEN && apiKey !== ADMISSION_TOKEN) {
          return Response.json({ type: "error", error: { type: "authentication_error", message: "certification bridge authentication required" } }, { status: 401 });
        }
        if (observation.requests >= limits.requests) {
          observation.limitExceeded = true;
          return Response.json({ type: "error", error: { type: "rate_limit_error", message: "certification request limit reached" } }, { status: 429 });
        }
        observation.requests++;
        const declaredBytes = Number(req.headers.get("content-length") ?? 0);
        if (Number.isFinite(declaredBytes) && declaredBytes > LIVE_INPUT_BYTE_CEILING) {
          observation.inputLimitExceeded = true;
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "certification input limit reached" } }, { status: 413 });
        }
        const rawBody = await req.clone().text();
        const inputBytes = new TextEncoder().encode(rawBody).byteLength;
        observation.maxInputBytes = Math.max(observation.maxInputBytes, inputBytes);
        if (inputBytes > LIVE_INPUT_BYTE_CEILING) {
          observation.inputLimitExceeded = true;
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "certification input limit reached" } }, { status: 413 });
        }
        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawBody);
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch { body = {}; }
        observation.streaming = observation.requests === 1 ? body.stream === true : observation.streaming && body.stream === true;
        const evidence = inspectScenarioRequestBody(options.scenario, body, root);
        observation.maxPromptBytes = Math.max(observation.maxPromptBytes, evidence.promptBytes);
        observation.toolContinuation ||= evidence.toolContinuation;
        observation.subagentObserved ||= evidence.subagentObserved;
        const boundedRequest = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify({ ...body, max_tokens: limits.maxTokens }),
          signal: req.signal,
        });
        const response = await handleClaudeMessages(
          boundedRequest,
          cfg,
          { provider: options.provider, model: options.model, surface: "claude" },
          undefined,
          cfg,
        );
        observation.httpStatus = response.status;
        observation.hadHttpError ||= response.status >= 400;
        return response;
      },
    });
    const env = buildClaudeEnv(
      cfg,
      { baseUrl: bridge.url.toString(), admissionToken: ADMISSION_TOKEN },
      sanitizedChildEnv(process.env, dirs),
      {},
      { preBunAnthropicSlots: [] },
    );
    env.ANTHROPIC_MODEL = CLI_MODEL;
    env.CLAUDE_CODE_MAX_TURNS = String(limits.requests);
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = "1";
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
    env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS = "1";
    if (options.scenario === "read-continuation") writeFileSync(join(root, "read-marker.txt"), `${READ_MARKER}\n`, { mode: 0o600 });
    const invocation = scenarioCommand(options.scenario, root);
    let result: Awaited<ReturnType<typeof command>>;
    try {
      result = await command(cli, [...invocation.args, "--max-budget-usd", String(options.maxBudgetUsd)], root, env, limits.timeoutMs, invocation.input);
    } catch (error) {
      const missing = error instanceof Error && error.name === "MissingExecutable";
      return { mode: "live", status: missing ? "skipped" : "live_fail", cliPresent: !missing, streaming: observation.streaming, toolContinuation: observation.toolContinuation, scenario: options.scenario, subagentObserved: observation.subagentObserved, maxInputBytes: observation.maxInputBytes, maxPromptBytes: observation.maxPromptBytes, discoveryPerformed, requests: observation.requests, provider: options.provider, model: options.model, durationMs: Date.now() - started, httpStatus: observation.httpStatus, reason: missing ? "cli_unavailable" : (error instanceof Error && error.message === "timeout" ? "timeout" : "subprocess_failure") };
    }
    const assessment = assessLiveScenario(options.scenario, observation, result.code, result.out);
    if (!assessment.passed && assessment.reason === "client_nonzero" && /budget|cost limit|max-budget/i.test(result.err)) assessment.reason = "client_budget";
    return { mode: "live", status: assessment.passed ? "live_pass" : "live_fail", cliPresent: true, streaming: observation.streaming, toolContinuation: observation.toolContinuation, scenario: options.scenario, subagentObserved: observation.subagentObserved, maxInputBytes: observation.maxInputBytes, maxPromptBytes: observation.maxPromptBytes, discoveryPerformed, requests: observation.requests, provider: options.provider, model: options.model, durationMs: Date.now() - started, httpStatus: observation.httpStatus, reason: assessment.reason };
  } finally {
    bridge?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2); const live = args.includes("--live"); const json = args.includes("--json");
  let report: CertificationReport;
  if (live) {
    const policy = evaluateLivePolicy({ confirmFlag: args.includes("--confirm-live-provider-charges"), allowEnv: process.env.OCX_ALLOW_CLAUDE_LIVE_CERT === "1" });
    if (policy.status === "skipped") report = policy;
    else {
      const options = parseLiveOptions(args);
      report = "error" in options
        ? { ...policy, reason: options.error }
        : await runLive(options);
    }
  } else report = await runHermetic();
  console.log(json ? JSON.stringify(report) : `${report.status}: ${report.reason ?? "ok"}`); process.exitCode = report.status.endsWith("fail") ? 1 : 0;
}
if (import.meta.main) await main();
