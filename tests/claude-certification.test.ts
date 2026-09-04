import { describe, expect, test } from "bun:test";
import {
  evaluateLivePolicy,
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
      UNRELATED: "kept",
    }, { home: "/tmp/cert-home", claude: "/tmp/cert-claude", ocx: "/tmp/cert-ocx" });

    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/cert-home",
      CLAUDE_CONFIG_DIR: "/tmp/cert-claude",
      OPENCODEX_HOME: "/tmp/cert-ocx",
      NO_PROXY: "127.0.0.1,localhost,::1",
      ANTHROPIC_AUTH_TOKEN: "ocx_data_claude_cert",
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
