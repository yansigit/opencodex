import { describe, expect, test } from "bun:test";
import {
  evaluateLivePolicy,
  liveConfig,
  parseLiveOptions,
  runHermetic,
  sanitizedChildEnv,
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
  });

  test("requires both explicit consent and the environment gate for live mode", () => {
    expect(evaluateLivePolicy({ confirmFlag: false, allowEnv: false })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: true, allowEnv: false })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: false, allowEnv: true })).toMatchObject({ status: "skipped", requests: 0 });
    expect(evaluateLivePolicy({ confirmFlag: true, allowEnv: true })).toMatchObject({ status: "live_fail", requests: 0 });
  });
  test("strictly parses live route and budget options", () => {
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "1.5"])).toEqual({ provider: "p", model: "m", maxBudgetUsd: 1.5 });
    expect(parseLiveOptions(["--provider", "p"])).toEqual({ error: "provider, model, and max-budget-usd are required" });
    expect(parseLiveOptions(["--provider", "p", "--provider", "q", "--model", "m", "--max-budget-usd", "1"])).toEqual({ error: "invalid live certification arguments" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "0"])).toEqual({ error: "invalid max-budget-usd" });
    expect(parseLiveOptions(["--provider", "p", "--model", "m", "--max-budget-usd", "5.01"])).toEqual({ error: "invalid max-budget-usd" });
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
