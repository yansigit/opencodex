import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessLiveScenario,
  assessHighContextCapacity,
  authoritativeHighContextInputTokens,
  evaluateLivePolicy,
  highContextConsent,
  highContextPrompt,
  inspectScenarioRequestBody,
  liveConfig,
  parseLiveOptions,
  processTreeTerminationPlan,
  runCertificationCommandForTests,
  runHermetic,
  sanitizedChildEnv,
  scenarioCommand,
} from "../scripts/claude-certification";

describe("Claude certification runner policy", () => {
  test("sanitizes inherited credentials and proxy settings while using isolated homes", () => {
    const env = sanitizedChildEnv({
      PATH: "/bin",
      HOME: "/operator",
      OPENCODEX_HOME: "/operator/ocx",
      CLAUDE_CONFIG_DIR: "/operator/claude",
      HTTPS_PROXY: "http://proxy.invalid",
      OPENAI_API_KEY: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      AWS_ACCESS_KEY_ID: "must-not-leak",
      AWS_PROFILE: "must-not-leak",
      USERPROFILE: "/operator",
      XDG_CONFIG_HOME: "/operator/config",
      SSH_AUTH_SOCK: "/operator/ssh-agent",
      KUBECONFIG: "/operator/kubeconfig",
      GOOGLE_APPLICATION_CREDENTIALS: "/operator/google.json",
      GIT_ASKPASS: "/operator/askpass",
      NODE_OPTIONS: "--require=/operator/inject.js",
      DYLD_INSERT_LIBRARIES: "/operator/inject.dylib",
      UNRELATED: "kept",
    }, { home: "/tmp/cert-home", claude: "/tmp/cert-claude", ocx: "/tmp/cert-ocx" });

    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/cert-home",
      CLAUDE_CONFIG_DIR: "/tmp/cert-claude",
      OPENCODEX_HOME: "/tmp/cert-ocx",
      NO_PROXY: "127.0.0.1,localhost,::1",
      ANTHROPIC_AUTH_TOKEN: ["sk-ant-api03", "hermetic-certification-key"].join("-"),
      UNRELATED: "kept",
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  test("requires both explicit consent and the environment gate for live mode", () => {
    expect(evaluateLivePolicy({ confirmFlag: false, allowEnv: false })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: true, allowEnv: false })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: false, allowEnv: true })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: true, allowEnv: true })).toMatchObject({ status: "live_fail", requests: 0 });
  });
  test("high-context has additive consent and fail-closed capacity", () => {
    expect(highContextConsent(true, true)).toBe(true);
    expect(highContextConsent(true, false)).toBe(false);
    expect(assessHighContextCapacity([{ provider: "p", id: "m", contextWindow: 999_999, metadataFieldSources: { contextWindow: "registry" } }], "p", "m")).toEqual({ skipped: true, reason: "capacity_undetermined" });
    expect(assessHighContextCapacity([{ provider: "p", id: "m", contextWindow: Number.NaN, metadataFieldSources: { contextWindow: "live" } }], "p", "m")).toEqual({ skipped: true, reason: "capacity_undetermined" });
    expect(assessHighContextCapacity([{ provider: "p", id: "m", contextWindow: 1_000_000, metadataFieldSources: { contextWindow: "derived" } }], "p", "m")).toEqual({ skipped: true, reason: "capacity_undetermined" });
    expect(assessHighContextCapacity([{ provider: "other", id: "m", contextWindow: 1_000_000, metadataFieldSources: { contextWindow: "live" } }], "p", "m")).toEqual({ skipped: true, reason: "capacity_undetermined" });
    expect(assessHighContextCapacity([{ provider: "p", id: "m", contextWindow: 1_000_000, metadataFieldSources: { contextWindow: "snapshot" } }], "p", "m")).toEqual({ declaredContextTokens: 1_000_000, contextSource: "snapshot" });
    expect(new TextEncoder().encode(highContextPrompt()).byteLength).toBe(900_000);
    const command = scenarioCommand("high-context", "/cert");
    expect(command.args.filter(value => value === "--model")).toHaveLength(1);
    expect(command.args).not.toContain("-");
    expect(command.args).toContain("claude-sonnet-4-5[1m]");
    expect(command.input).toBe(highContextPrompt());
  });
  test("accepts only authoritative usage from the resolved adapter and routed model", () => {
    const usage = { inputTokens: 456_789, outputTokens: 1 };
    expect(authoritativeHighContextInputTokens({ adapterKind: "anthropic", modelId: "p/m", usage }, "p", "m", "anthropic")).toBe(456_789);
    expect(authoritativeHighContextInputTokens({ adapterKind: "openai-responses", modelId: "m", usage }, "p", "m", "openai-responses")).toBe(456_789);
    expect(authoritativeHighContextInputTokens({ adapterKind: "anthropic", modelId: "other/m", usage }, "p", "m", "anthropic")).toBeUndefined();
    expect(authoritativeHighContextInputTokens({ adapterKind: "anthropic", modelId: "p/m", usage: { ...usage, estimated: true } }, "p", "m", "anthropic")).toBeUndefined();
  });
  test("strictly parses live route and budget options", () => {
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "1.5"])).toEqual({ provider: "p", model: "m", maxBudgetUsd: 1.5, scenario: "basic" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "1.5", "--scenario", "subagent"])).toEqual({ provider: "p", model: "m", maxBudgetUsd: 1.5, scenario: "subagent" });
    expect(parseLiveOptions(["--provider", "p"])).toEqual({ error: "provider, model, and max-budget-usd are required" });
    expect(parseLiveOptions(["--provider", "p", "--provider", "q", "--model", "m", "--max-budget-usd", "1"])).toEqual({ error: "invalid live certification arguments" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "0"])).toEqual({ error: "invalid max-budget-usd" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "5.01"])).toEqual({ error: "invalid max-budget-usd" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "1", "--scenario", "unknown"])).toEqual({ error: "invalid certification scenario" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "1", "--scenario", "high-context", "--confirm-live-high-context-costs"])).toMatchObject({ scenario: "high-context" });
  });

  test("assesses scenario-specific evidence without retaining request content", () => {
    const base = { requests: 1, streaming: true, toolContinuation: false, subagentObserved: false, maxInputBytes: 140_000, maxPromptBytes: 140_000, limitExceeded: false, inputLimitExceeded: false, hadHttpError: false, httpStatus: 200 };
    expect(assessLiveScenario("basic", base, 0, "OCX_CLAUDE_LIVE_OK\n")).toEqual({ passed: true });
    expect(assessLiveScenario("read-continuation", { ...base, requests: 2, toolContinuation: true }, 0, "OCX_CLAUDE_READ_OK")).toEqual({ passed: true });
    expect(assessLiveScenario("read-continuation", base, 0, "OCX_CLAUDE_READ_OK")).toEqual({ passed: false, reason: "tool_not_used" });
    expect(assessLiveScenario("subagent", { ...base, requests: 2, subagentObserved: true, toolContinuation: true }, 0, "OCX_CLAUDE_SUBAGENT_OK")).toEqual({ passed: true });
    expect(assessLiveScenario("subagent", base, 0, "OCX_CLAUDE_SUBAGENT_OK")).toEqual({ passed: false, reason: "subagent_not_observed" });
    expect(assessLiveScenario("long-context", base, 0, "OCX_CLAUDE_CONTEXT_OK")).toEqual({ passed: true });
    expect(assessLiveScenario("long-context", { ...base, maxPromptBytes: 1_000 }, 0, "OCX_CLAUDE_CONTEXT_OK")).toEqual({ passed: false, reason: "context_too_short" });
    expect(assessLiveScenario("high-context", { ...base, rawUsageObservations: 1, maxPromptBytes: 900_000, providerInputTokens: 400_000 }, 0, "OCX_CLAUDE_HIGH_CONTEXT_OK")).toEqual({ passed: true });
    expect(assessLiveScenario("high-context", { ...base, rawUsageObservations: 0, maxPromptBytes: 900_000 }, 0, "OCX_CLAUDE_HIGH_CONTEXT_OK")).toEqual({ passed: false, reason: "usage_missing_or_too_low" });
    expect(assessLiveScenario("high-context", { ...base, rawUsageObservations: 2, maxPromptBytes: 900_000, providerInputTokens: 500_000 }, 0, "OCX_CLAUDE_HIGH_CONTEXT_OK")).toEqual({ passed: false, reason: "usage_missing_or_too_low" });
    expect(assessLiveScenario("high-context", { ...base, rawUsageObservations: 1, maxPromptBytes: 900_000, providerInputTokens: 500_000 }, 0, "WRONG")).toEqual({ passed: false, reason: "marker_mismatch" });
    expect(assessLiveScenario("basic", { ...base, limitExceeded: true }, 0, "OCX_CLAUDE_LIVE_OK")).toEqual({ passed: false, reason: "request_limit" });
    expect(assessLiveScenario("basic", { ...base, inputLimitExceeded: true }, 0, "OCX_CLAUDE_LIVE_OK")).toEqual({ passed: false, reason: "input_limit" });
    expect(assessLiveScenario("basic", { ...base, hadHttpError: true }, 0, "OCX_CLAUDE_LIVE_OK")).toEqual({ passed: false, reason: "upstream_http" });
    expect(assessLiveScenario("basic", { ...base, streaming: false }, 0, "OCX_CLAUDE_LIVE_OK")).toEqual({ passed: false, reason: "non_streaming" });
    expect(assessLiveScenario("basic", { ...base, requests: 0 }, 0, "OCX_CLAUDE_LIVE_OK")).toEqual({ passed: false, reason: "request_count" });
  });

  test("correlates exact Read and Agent exchanges and counts only user prompt text", () => {
    const read = { messages: [{ content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/cert/read-marker.txt" } },
      { type: "tool_result", tool_use_id: "read-1", content: "OCX_CLAUDE_READ_OK" },
    ] }] };
    expect(inspectScenarioRequestBody("read-continuation", read, "/cert")).toEqual({ promptBytes: 5, toolContinuation: true, subagentObserved: false });
    expect(inspectScenarioRequestBody("read-continuation", { ...read, messages: [{ content: [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/operator/secret" } },
      { type: "tool_result", tool_use_id: "read-1", content: "OCX_CLAUDE_READ_OK" },
    ] }] }, "/cert").toolContinuation).toBe(false);

    const agent = { system: "OCX_CLAUDE_CHILD_SYSTEM", messages: [{ content: [
      { type: "tool_use", id: "agent-1", name: "Agent", input: { subagent_type: "cert-worker" } },
      { type: "tool_result", tool_use_id: "agent-1", content: "OCX_CLAUDE_SUBAGENT_OK" },
    ] }] };
    expect(inspectScenarioRequestBody("subagent", agent, "/cert")).toMatchObject({ toolContinuation: true, subagentObserved: true });
    expect(inspectScenarioRequestBody("subagent", { ...agent, messages: [{ content: [
      { type: "tool_use", id: "agent-1", name: "Agent", input: { subagent_type: "other" } },
      { type: "tool_result", tool_use_id: "agent-1", content: "OCX_CLAUDE_SUBAGENT_OK" },
    ] }] }, "/cert").toolContinuation).toBe(false);
    expect(inspectScenarioRequestBody("long-context", { messages: "plain string prompt" }, "/cert").promptBytes).toBe(19);
  });

  test("pins cross-platform process-tree termination targets", () => {
    expect(processTreeTerminationPlan(42, "linux")).toEqual({ groupPid: -42 });
    expect(processTreeTerminationPlan(42, "darwin")).toEqual({ groupPid: -42 });
    expect(processTreeTerminationPlan(42, "win32", "C:\\Windows\\System32\\taskkill.exe")).toEqual({ command: ["C:\\Windows\\System32\\taskkill.exe", "/PID", "42", "/T", "/F"] });
    expect(() => processTreeTerminationPlan(0, "linux")).toThrow("invalid child pid");
    expect(() => processTreeTerminationPlan(1, "linux")).toThrow("invalid child pid");
    expect(() => processTreeTerminationPlan(1, "win32", "taskkill.exe")).toThrow("invalid child pid");
  });

  test.if(process.platform !== "win32")("timeout and output overflow kill stubborn descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-claude-cert-tree-"));
    const fixture = join(import.meta.dir, "fixtures/claude-cert-process-tree.ts");
    try {
      const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const [mode, expected, timeout] of [["timeout", "timeout", 250], ["overflow", "output limit exceeded", 2_000]] as const) {
        const marker = join(root, `${mode}.json`);
        await expect(runCertificationCommandForTests(process.execPath, [fixture, marker, mode], root, { ...process.env } as Record<string, string>, timeout)).rejects.toThrow(expected);
        expect(existsSync(marker)).toBe(true);
        const { child, grandchild } = JSON.parse(readFileSync(marker, "utf8")) as { child: number; grandchild: number };
        const deadline = Date.now() + 2_000;
        while ((alive(child) || alive(grandchild)) && Date.now() < deadline) await Bun.sleep(10);
        expect(alive(child)).toBe(false);
        expect(alive(grandchild)).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("bounded command returns ordinary subprocess output", async () => {
    const result = await runCertificationCommandForTests(
      process.execPath,
      ["-e", "console.log('cert-ok')"],
      import.meta.dir,
      { ...process.env } as Record<string, string>,
      2_000,
    );
    expect(result).toMatchObject({ code: 0, out: "cert-ok\n", err: "" });
  });

  test("live config rejects an unlisted model and disables alternate request paths", () => {
    const source = {
      defaultProvider: "p",
      providers: { p: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "test", models: ["listed"] } },
      emptyCompletionRetry: true,
      webSearchSidecar: { provider: "p", model: "listed" },
      visionSidecar: { backend: "routed", model: "p/listed" },
      claudeCode: { webSearchSidecar: { backend: "openai", model: "listed" }, visionSidecar: { backend: "routed", model: "p/listed" } },
      oauthAccountFailover: { enabled: true },
      cursorAccountPool: { enabled: true },
    } as never;
    expect(() => liveConfig(source, "p", "missing")).toThrow("route_unavailable");
    expect(() => liveConfig({ ...source, disabledModels: ["p/listed"] }, "p", "listed")).toThrow("route_unavailable");
    const isolated = liveConfig(source, "p", "listed");
    expect(isolated.emptyCompletionRetry).toBe(false);
    expect(isolated.webSearchSidecar).toBeUndefined();
    expect(isolated.visionSidecar).toBeUndefined();
    expect(isolated.claudeCode?.webSearchSidecar).toBeUndefined();
    expect(isolated.claudeCode?.visionSidecar).toBeUndefined();
    expect(isolated.oauthAccountFailover?.enabled).toBe(false);
    expect(isolated.cursorAccountPool?.enabled).toBe(false);
    expect(isolated.providers.p.replayTransientFailures).toBe(false);
    expect(isolated.claudeCode?.nativePassthrough).toBe(false);

    const discovered = liveConfig(source, "p", "vendor/live-only", ["vendor/live-only"]);
    expect(discovered.providers.p.models).toContain("vendor/live-only");
  });

  test("missing Claude CLI is an explicit hermetic skip and does not leak OPENCODEX_HOME", async () => {
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = "/operator/ocx";
    try {
      const report = await runHermetic("definitely-not-a-claude-cert-cli");
      expect(report).toMatchObject({ mode: "hermetic", status: "skipped", cliPresent: false, requests: 0 });
      expect(process.env.OPENCODEX_HOME).toBe("/operator/ocx");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
    }
  });
});
