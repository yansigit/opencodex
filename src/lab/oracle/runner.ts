import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedOracleEnv, ensureOracleRawDir, purgeExpiredRaw, readOracleObservation, writeOracleObservation } from "./isolate";
import { createLoopbackProxy } from "./loopback";
import { CURSOR_ORACLE_DEFAULT_TIMEOUT_MS, CURSOR_ORACLE_UPSTREAM, CURSOR_ORACLE_RAW_TTL_MS } from "./constants";
import {
  CURSOR_VERIFIED_CLIENT_VERSION,
  CURSOR_VERIFIED_REQUEST_CONTEXT_MODE,
  CURSOR_VERIFIED_SCHEMA_FINGERPRINT,
} from "../../adapters/cursor/protocol-profile";
import type { CursorOracleObservationV1, CursorOracleRunRequest, CursorOracleRunResult } from "./types";

const SAFE_SCENARIO_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RULE_CANARY = "OCX_CURSOR_ORACLE_RULE_CANARY_V1";

function resolveAgentBin(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`agent bin not found: ${explicit}`);
    return explicit;
  }
  const candidates = [
    process.env.CURSOR_AGENT_BIN,
    process.env.HOME ? join(process.env.HOME, ".local/bin/cursor-agent") : undefined,
    process.env.HOME ? join(process.env.HOME, ".local/bin/agent") : undefined,
    "cursor-agent",
    "agent",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c.includes("/") && existsSync(c)) return c;
  }
  return candidates.find((c) => !c.includes("/")) ?? "cursor-agent";
}

function readAgentVersion(agentBin: string): string | null {
  const result = spawnSync(agentBin, ["--version"], { encoding: "utf8", timeout: 5_000 });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? null;
}

function classifyAgentStderr(value: string): string {
  if (/authentication required|agent login/i.test(value)) return "agent_auth_required";
  if (/workspace trust required|pass --trust/i.test(value)) return "agent_trust_required";
  if (/unknown (?:option|argument)|unexpected argument/i.test(value)) return "agent_cli_incompatible";
  if (/ECONNREFUSED|unavailable/i.test(value)) return "agent_endpoint_unavailable";
  return "agent_stderr";
}

export function readStoredCursorOracle(runId: string, configDir?: string): CursorOracleObservationV1 {
  const value = JSON.parse(readOracleObservation(runId, configDir)) as Partial<CursorOracleObservationV1>;
  if (value.schemaVersion !== 1 || value.oracle !== "cursor" || value.oracleRunId !== runId
    || typeof value.scenario !== "string" || !SAFE_SCENARIO_ID.test(value.scenario)) {
    throw new Error("invalid cursor oracle observation");
  }
  return value as CursorOracleObservationV1;
}

function buildPromptForScenario(scenario: string, model?: string): string {
  return `Read-only Compatibility Lab protocol probe for scenario ${scenario}. Follow the workspace rules and reply with one concise sentence without using tools.`;
}

export function cursorOracleSchemaFingerprint(
  cliVersion: string | null,
  protocol: import("./protocol-observer").CursorOracleProtocolObservation,
): string {
  const locations = new Set(["runRequest", "conversationAction", "requestContext", "requestContext.env"]);
  const shape = {
    requestContextMode: protocol.requestContextMode,
    unknownFieldLayout: [...new Set(protocol.unknownFields
      .filter(field => locations.has(field.location))
      .map(field => `${field.location}:${field.fieldNo}:${field.wireType}`))].sort(),
  };
  return createHash("sha256").update(`v2\0${cliVersion ?? "unknown"}\0${JSON.stringify(shape)}`).digest("hex");
}

export async function runCursorOracle(
  req: CursorOracleRunRequest,
  opts: { configDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CursorOracleRunResult> {
  const scenario = req.scenario;
  if (!SAFE_SCENARIO_ID.test(scenario)) throw new Error("invalid scenario id");
  const model = req.model ?? null;
  if (model !== null && !/^[A-Za-z0-9._:/-]{1,200}$/.test(model)) throw new Error("invalid cursor model id");
  const keepRaw = req.keepRaw ?? false;
  const agentBin = resolveAgentBin(req.agentBin);
  const cliVersion = readAgentVersion(agentBin);
  const startedAt = Date.now();

  try { purgeExpiredRaw(opts.configDir); } catch {}

  const isolated = createIsolatedOracleEnv({ configDir: opts.configDir });
  let loopback: Awaited<ReturnType<typeof createLoopbackProxy>> | null = null;
  let exitCode = 0;
  const diagnostics: Array<{ code: string }> = [];
  let rawPaths: string[] | undefined = keepRaw ? [] : undefined;
  let instructionCanaryObserved = false;

  try {
    const admissionToken = randomBytes(32).toString("hex");
    loopback = await createLoopbackProxy({ configDir: opts.configDir, keepRaw, admissionToken });
    const ephemeralAuth = process.env.CURSOR_API_KEY ?? process.env.CURSOR_TOKEN ?? "";

    const prompt = buildPromptForScenario(scenario, model ?? undefined);
    const promptPath = join(isolated.workspaceDir, "oracle-prompt.txt");
    writeFileSync(promptPath, prompt, { mode: 0o600 });
    const probeFile = join(isolated.workspaceDir, "README.md");
    writeFileSync(probeFile, `# Oracle smoke\nModel: ${model ?? "auto"}\n`, { mode: 0o600 });
    const rulesDir = join(isolated.workspaceDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(rulesDir, "ocx-oracle.mdc"), [
      "---",
      "description: OpenCodex Compatibility Lab rule canary",
      "alwaysApply: true",
      "---",
      `Reply with exactly ${RULE_CANARY}. Do not use tools.`,
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(isolated.configDir, "cli-config.json"), JSON.stringify({
      version: 1,
      network: { useHttp1ForAgent: true },
    }), { mode: 0o600 });

    const env: Record<string, string> = {};
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    // Cursor's login is keyed to the real user home/keychain. Config, data, and
    // workspace stay isolated, but HOME intentionally remains available so the
    // already-authenticated CLI can use its normal credential mechanism.
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    env.CURSOR_API_ENDPOINT = loopback.baseUrl;
    env.CURSOR_CONFIG_DIR = isolated.configDir;
    env.CURSOR_DATA_DIR = isolated.dataDir;
    env.OPENCODEX_HOME = isolated.configDir;
    if (ephemeralAuth) env.CURSOR_API_KEY = ephemeralAuth;
    env.XDG_CONFIG_HOME = join(isolated.homeDir, ".config");
    env.XDG_DATA_HOME = join(isolated.homeDir, ".local/share");

    const args = [
      "--mode", "plan",
      "--trust",
      "--print",
      "--output-format", "stream-json",
      ...(model ? ["--model", model] : []),
      "--workspace", isolated.workspaceDir,
      "--endpoint", loopback.baseUrl,
      "--header", `x-ocx-oracle-token: ${admissionToken}`,
      prompt,
    ];

    diagnostics.push({ code: "agent_spawned" });

    const timeoutMs = opts.timeoutMs ?? CURSOR_ORACLE_DEFAULT_TIMEOUT_MS;
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(agentBin, args, {
        env,
        cwd: isolated.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let sawStderr = false;
      let sawStdout = false;
      let stderrText = "";
      let stdoutTail = "";
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationCode: number | undefined;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (settleTimer) clearTimeout(settleTimer);
        opts.signal?.removeEventListener("abort", abortChild);
        resolve(code);
      };
      const terminate = (code: number, diagnostic: string) => {
        if (terminationCode !== undefined) return;
        terminationCode = code;
        diagnostics.push({ code: diagnostic });
        try { child.kill("SIGTERM"); } catch {}
        forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1_000);
        forceKillTimer.unref?.();
        settleTimer = setTimeout(() => finish(code), 2_000);
        settleTimer.unref?.();
      };
      const abortChild = () => terminate(130, "agent_aborted");
      child.stdout?.on("data", chunk => {
        sawStdout = true;
        const scanned = stdoutTail + String(chunk);
        if (scanned.includes(RULE_CANARY)) instructionCanaryObserved = true;
        stdoutTail = scanned.slice(-(RULE_CANARY.length - 1));
      });
      child.stderr?.on("data", chunk => {
        sawStderr = true;
        if (stderrText.length < 32_768) stderrText += String(chunk).slice(0, 32_768 - stderrText.length);
      });
      const timer = setTimeout(() => terminate(124, "agent_timeout"), timeoutMs);
      opts.signal?.addEventListener("abort", abortChild, { once: true });
      if (opts.signal?.aborted) abortChild();
      child.on("error", (err) => {
        diagnostics.push({ code: "agent_spawn_failed" });
        finish(127);
      });
      child.on("close", (code, signal) => {
        if (signal) diagnostics.push({ code: "agent_signaled" });
        if (sawStderr) diagnostics.push({ code: classifyAgentStderr(stderrText) });
        if (sawStdout) diagnostics.push({ code: "agent_stdout" });
        finish(terminationCode ?? code ?? (signal ? (opts.signal?.aborted ? 130 : 124) : 0));
      });
    });

    const obs = loopback.getObservation();
    if (obs.rawPaths && rawPaths) rawPaths = [...obs.rawPaths];
    diagnostics.push(...obs.diagnostics);
    if (obs.protocol.decodeFailures > 0) diagnostics.push({ code: "protocol_decode_failed" });

    const completedAt = Date.now();
    let outcome: CursorOracleObservationV1["outcome"];
    if (exitCode === 124 || exitCode === 127 || exitCode === 130) outcome = "blocked";
    else if (exitCode === 0) outcome = obs.responseStatus !== null && obs.responseStatus >= 200 && obs.responseStatus < 300 ? "pass" : obs.responseStatus === null ? "inconclusive" : "fail";
    else outcome = "fail";

    let rawDir: string | undefined;
    if (keepRaw) {
      try { rawDir = ensureOracleRawDir(opts.configDir); } catch { diagnostics.push({ code: "raw_dir_unavailable" }); }
    }

    const capturedFingerprint = cursorOracleSchemaFingerprint(cliVersion, obs.protocol);
    const verifiedProfile = cliVersion === CURSOR_VERIFIED_CLIENT_VERSION.replace(/^cli-/, "")
      && capturedFingerprint === CURSOR_VERIFIED_SCHEMA_FINGERPRINT
      && obs.protocol.requestContextMode === CURSOR_VERIFIED_REQUEST_CONTEXT_MODE;
    const observation: CursorOracleObservationV1 = {
      schemaVersion: 1,
      oracleRunId: `cursor-${startedAt.toString(36)}-${randomBytes(6).toString("hex")}`,
      oracle: "cursor",
      cliVersion,
      schemaFingerprint: capturedFingerprint,
      protocolProfile: {
        status: verifiedProfile ? "VERIFIED_PROTOCOL_PROFILE" : "DEGRADED_PROTOCOL_PROFILE",
        requestContextMode: obs.protocol.requestContextMode,
        runSseRequests: obs.endpointCounts.RunSSE ?? 0,
        bidiAppendRequests: obs.endpointCounts.BidiAppend ?? 0,
        endpointCounts: obs.endpointCounts,
        observedClientVersions: obs.clientVersions,
        messages: obs.protocol,
      },
      behavior: { instructionCanaryObserved },
      scenario,
      model,
      startedAt,
      completedAt,
      outcome,
      diagnostics: diagnostics.slice(0, 32),
    };

    writeOracleObservation(observation.oracleRunId, `${JSON.stringify(observation)}\n`, opts.configDir);
    return { observation, rawPaths, exitCode, ...(rawDir ? { rawDir, rawTtlMs: CURSOR_ORACLE_RAW_TTL_MS } : {}) };
  } finally {
    try { if (loopback) await loopback.close(); } catch {}
    try { isolated.cleanup(); } catch {}
  }
}
