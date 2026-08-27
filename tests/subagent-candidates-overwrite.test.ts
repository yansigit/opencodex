import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySubagentModelFallback,
  isSubagentModelUnavailable,
  noteSubagentModelFailure,
  recordSubagentFailureForThreadSpawn,
  resetSubagentModelFallbackStateForTests,
  selectAvailableSubagentModel,
} from "../src/codex/subagent-model-fallback";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearAccountQuota } from "../src/codex/quota";
import { clearCodexUpstreamHealthForAccount } from "../src/codex/routing";
import type { OcxConfig } from "../src/types";

let testDir: string;
const savedCodexHome = process.env.CODEX_HOME;
const savedOpencodexHome = process.env.OPENCODEX_HOME;

function installPoolCredential(accountId: string, now = Date.now()): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `${accountId}_token`,
    refreshToken: `${accountId}_refresh`,
    expiresAt: now + 24 * 60 * 60_000,
    chatgptAccountId: `${accountId}_acc`,
  });
}

function cfg(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      "google-antigravity": {
        adapter: "google",
        apiKey: "test",
        baseUrl: "https://example.invalid",
      },
      cursor: {
        adapter: "cursor",
        apiKey: "test",
        baseUrl: "https://example.invalid",
      },
      "command-code": {
        adapter: "openai-chat",
        apiKey: "test",
        baseUrl: "https://example.invalid",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_a_acc" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-candidates-test-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  installPoolCredential("pool-a");
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("main");
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedOpencodexHome;
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("main");
  clearCodexUpstreamHealthForAccount("pool-a");
  rmSync(testDir, { recursive: true, force: true });
});

describe("subagentCandidates model overwrite and candidate failover", () => {
  test("overwrites requested gpt-5.6-luna with candidate array when candidate is healthy", () => {
    const config = cfg({
      subagentCandidates: [
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ],
    });
    const parsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const headers = new Headers({ "x-openai-subagent": "collab_spawn" });
    const result = applySubagentModelFallback(parsed as never, headers, config);

    expect(result).toEqual({
      from: "gpt-5.6-luna",
      to: "google-antigravity/gemini-3.7-flash",
      skipped: [],
    });
    expect(parsed.modelId).toBe("google-antigravity/gemini-3.7-flash");
    expect((parsed._rawBody as { model?: string }).model).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("role-specific candidate resolution for coder -> Flash", () => {
    const config = cfg({
      subagentCandidates: {
        coder: ["google-antigravity/gemini-3.7-flash"],
        default: ["cursor/composer-2.5"],
      },
    });

    // Request with coder role metadata
    const coderParsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const coderHeaders = new Headers({
      "x-codex-turn-metadata": JSON.stringify({
        subagent_kind: "thread_spawn",
        agent_role: "coder",
      }),
    });
    const coderResult = applySubagentModelFallback(coderParsed as never, coderHeaders, config);
    expect(coderResult?.to).toBe("google-antigravity/gemini-3.7-flash");
    expect(coderParsed.modelId).toBe("google-antigravity/gemini-3.7-flash");

    // Request with default role (no role specified or different role)
    const defaultParsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const defaultHeaders = new Headers({ "x-openai-subagent": "collab_spawn" });
    const defaultResult = applySubagentModelFallback(defaultParsed as never, defaultHeaders, config);
    expect(defaultResult?.to).toBe("cursor/composer-2.5");
    expect(defaultParsed.modelId).toBe("cursor/composer-2.5");
  });

  test("role-specific candidate resolution using x-codex-agent-role header", () => {
    const config = cfg({
      subagentCandidates: {
        coder: ["google-antigravity/gemini-3.7-flash"],
        default: ["cursor/composer-2.5"],
      },
    });
    const parsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const headers = new Headers({
      "x-openai-subagent": "collab_spawn",
      "x-codex-agent-role": "coder",
    });
    const result = applySubagentModelFallback(parsed as never, headers, config);
    expect(result?.to).toBe("google-antigravity/gemini-3.7-flash");
    expect(parsed.modelId).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("automatic hop to Candidate 2 when Candidate 1 is in cooldown after failure", () => {
    const config = cfg({
      subagentCandidates: [
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ],
    });

    // Record stream disconnect failure on Candidate 1
    noteSubagentModelFailure(
      "google-antigravity/gemini-3.7-flash",
      "stream closed before response.completed",
      config,
    );
    expect(isSubagentModelUnavailable("google-antigravity/gemini-3.7-flash", config)).toBe(true);

    const parsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const headers = new Headers({ "x-openai-subagent": "collab_spawn" });
    const result = applySubagentModelFallback(parsed as never, headers, config);

    expect(result).toEqual({
      from: "gpt-5.6-luna",
      to: "cursor/composer-2.5",
      skipped: ["google-antigravity/gemini-3.7-flash"],
    });
    expect(parsed.modelId).toBe("cursor/composer-2.5");
    expect((parsed._rawBody as { model?: string }).model).toBe("cursor/composer-2.5");
  });

  test("broadened failure classification in noteSubagentModelFailure", () => {
    const config = cfg();

    // 5xx errors
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", 502 as never, config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "500 Internal Server Error", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "Provider error 503: Service Unavailable", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    // Timeouts
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "upstream JSON response stalled before completing", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "ETIMEDOUT", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    // Stream disconnects
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "stream closed before response.completed", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    // Network errors
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "fetch failed", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "network error", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    // Client errors should NOT place in cooldown
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "invalid_request_error: missing field", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(false);

    // Legacy ignored error preserved
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("cursor/composer-2.5", "connection refused", config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(false);
  });

  test("recordSubagentFailureForThreadSpawn records failure only on thread spawn requests", () => {
    const config = cfg();
    resetSubagentModelFallbackStateForTests();

    // Spawn request: should record
    const spawnHeaders = new Headers({ "x-openai-subagent": "collab_spawn" });
    recordSubagentFailureForThreadSpawn(spawnHeaders, "cursor/composer-2.5", 502, config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(true);

    resetSubagentModelFallbackStateForTests();

    // Non-spawn request: should NOT record
    const mainHeaders = new Headers();
    recordSubagentFailureForThreadSpawn(mainHeaders, "cursor/composer-2.5", 502, config);
    expect(isSubagentModelUnavailable("cursor/composer-2.5", config)).toBe(false);
  });

  test("applySubagentModelFallback is a no-op on non-spawn main turns even with candidates configured", () => {
    const config = cfg({
      subagentCandidates: ["google-antigravity/gemini-3.7-flash"],
    });
    const parsed = {
      modelId: "gpt-5.6-luna",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-luna" },
    };
    const mainHeaders = new Headers();
    const result = applySubagentModelFallback(parsed as never, mainHeaders, config);
    expect(result).toBeNull();
    expect(parsed.modelId).toBe("gpt-5.6-luna");
  });
});

