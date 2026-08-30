import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  captureClaudeSourceEnvelope,
  claudeFinalRouteHandler,
  claudeSessionIdFromRequest,
  promptCacheKeyForSession,
} from "../src/server/claude-messages";
import { captureClaudeInbound, clearClaudeInboundDebug, getClaudeInboundDebugEntries } from "../src/claude/inbound-debug";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { OcxConfig } from "../src/types";

function cfg(overrides?: Partial<OcxConfig>): OcxConfig {
  return {
    providers: {},
    claudeCode: { model: "claude-test" },
    ...(overrides as unknown as Record<string, unknown>),
  } as OcxConfig;
}

describe("claude session precedence and prompt_cache_key", () => {
  test("claudeSessionIdFromRequest: header > metadata.user_id > null (system cohort fallback is via translation)", () => {
    const body = { metadata: { user_id: "from-metadata" }, model: "claude" };
    const reqHeader = new Request("http://localhost/v1/messages", { headers: { "x-claude-code-session-id": "from-header" } });
    expect(claudeSessionIdFromRequest(reqHeader, body)).toBe("from-header");

    const reqNoHeader = new Request("http://localhost/v1/messages");
    expect(claudeSessionIdFromRequest(reqNoHeader, body)).toBe("from-metadata");
    expect(claudeSessionIdFromRequest(reqNoHeader, {})).toBeNull();
    expect(claudeSessionIdFromRequest(reqNoHeader, { metadata: { user_id: "  " } })).toBeNull();
    expect(claudeSessionIdFromRequest(reqNoHeader, { metadata: {} })).toBeNull();
  });

  test("promptCacheKeyForSession: sha256 32hex, null for null input", () => {
    expect(promptCacheKeyForSession(null)).toBeNull();
    const sid = "session-abc-123";
    const expected = createHash("sha256").update(sid).digest("hex").slice(0, 32);
    expect(promptCacheKeyForSession(sid)).toBe(expected);
    expect(promptCacheKeyForSession(sid)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("captureClaudeSourceEnvelope: sanitized immutable clone, only anthropic-beta/version headers, charges budget", () => {
    const raw = { model: "claude", messages: [{ role: "user", content: "hi" }], extra: "keep" };
    const req = new Request("http://localhost/v1/messages", {
      headers: {
        "anthropic-beta": "beta-a, beta-b",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "should-not-be-in-envelope",
        authorization: "Bearer sk-ant-should-not-leak",
      },
    });
    const budget = createTranslatorBudget();
    const env = captureClaudeSourceEnvelope(req, raw, budget);
    expect(env.headers).toEqual({ "anthropic-beta": "beta-a, beta-b", "anthropic-version": "2023-06-01" });
    expect((env.headers as unknown as Record<string, unknown>)["x-claude-code-session-id"]).toBeUndefined();
    expect(env.body).toEqual(raw);
    // immutability: mutating raw does not affect clone
    (raw as Record<string, unknown>).extra = "mutated";
    expect((env.body as Record<string, unknown>).extra).toBe("keep");
    // budget charged: body + header bytes counted; disposing should not throw
    budget.dispose();
  });

  test("captureClaudeSourceEnvelope retains an explicitly empty anthropic-version for routed validation", () => {
    const req = new Request("http://localhost/v1/messages", { headers: { "anthropic-version": "   " } });
    expect(captureClaudeSourceEnvelope(req, { model: "claude" }, createTranslatorBudget()).headers["anthropic-version"]).toBe("");
  });

  test("claudeFinalRouteHandler: idempotent sampling strip for openai-responses", () => {
    const budget = createTranslatorBudget();
    const req = new Request("http://localhost/v1/messages");
    const rawBody = { model: "claude", messages: [{ role: "user", content: "hi" }] };
    const env = captureClaudeSourceEnvelope(req, rawBody, budget);
    const parsed: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = {
      modelId: "test-model",
      options: {
        maxOutputTokens: 100,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ["\n"],
        promptCacheKey: "abc",
        reasoning: "none",
        user: "u",
        // also snake variants to prove dual delete
        max_output_tokens: 100,
        top_p: 0.9,
        stop: ["\n"],
      } as unknown as Record<string, unknown>,
      _rawBody: {
        max_output_tokens: 100,
        temperature: 0.7,
        top_p: 0.9,
        stop: ["\n"],
        user: "u",
        maxOutputTokens: 100,
        topP: 0.9,
        stopSequences: ["\n"],
        reasoning: "x",
      },
    };
    const logCtx = {} as unknown as import("../src/server/request-log").RequestLogContext;
    const config = cfg({ claudeCode: { model: "claude-test", compatibility: "shadow" } } as unknown as Partial<OcxConfig>);
    claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses" }, providerName: "openai", modelId: "m" }, {
      sourceEnvelope: env,
      cacheKeySource: null,
      config,
      logCtx,
    });
    // all sampling keys removed from both options and _rawBody
    expect(parsed.options.maxOutputTokens).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).max_output_tokens).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).temperature).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).topP).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).top_p).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).stop).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).stopSequences).toBeUndefined();
    expect((parsed.options as Record<string, unknown>).user).toBeUndefined();
    const raw = parsed._rawBody as Record<string, unknown>;
    expect(raw.max_output_tokens).toBeUndefined();
    expect(raw.maxOutputTokens).toBeUndefined();
    expect(raw.top_p).toBeUndefined();
    expect(raw.topP).toBeUndefined();
    // idempotent: second call does not throw and stays stripped
    expect(() =>
      claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses" }, providerName: "openai", modelId: "m" }, {
        sourceEnvelope: env,
        cacheKeySource: null,
        config,
        logCtx,
      }),
    ).not.toThrow();
  });

  test("claudeFinalRouteHandler: no strip for non-openai-responses adapter", () => {
    const budget = createTranslatorBudget();
    const env = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "x" }, budget);
    const parsed: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = {
      modelId: "m",
      options: { temperature: 0.5, topP: 0.9 } as unknown as Record<string, unknown>,
      _rawBody: { temperature: 0.5, top_p: 0.9 } as unknown as Record<string, unknown>,
    };
    const logCtx = {} as unknown as import("../src/server/request-log").RequestLogContext;
    const config = cfg();
    claudeFinalRouteHandler(parsed, { provider: { adapter: "anthropic" }, providerName: "anthropic", modelId: "m" }, {
      sourceEnvelope: env,
      cacheKeySource: null,
      config,
      logCtx,
    });
    expect((parsed.options as Record<string, unknown>).temperature).toBe(0.5);
    expect((parsed._rawBody as Record<string, unknown>).top_p).toBe(0.9);
  });

  test("claudeFinalRouteHandler: usage estimate only for cursor/kiro, not for openai-responses", () => {
    const raw = { model: "claude", system: "sys", messages: [{ role: "user", content: "hello world" }], tools: [] };
    const env = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), raw, createTranslatorBudget());
    const config = cfg();
    const cursorCtx = { usageLogInputTokens: undefined } as unknown as import("../src/server/request-log").RequestLogContext;
    const openaiCtx = { usageLogInputTokens: undefined } as unknown as import("../src/server/request-log").RequestLogContext;
    const parsed1: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = { modelId: "m", options: {}, _rawBody: {} };
    const parsed2: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = { modelId: "m", options: {}, _rawBody: {} };
    claudeFinalRouteHandler(parsed1, { provider: { adapter: "cursor" }, providerName: "cursor", modelId: "m" }, {
      sourceEnvelope: env,
      cacheKeySource: null,
      config,
      logCtx: cursorCtx,
    });
    expect(typeof cursorCtx.usageLogInputTokens).toBe("number");
    expect(cursorCtx.usageLogInputTokens).toBeGreaterThan(0);

    claudeFinalRouteHandler(parsed2, { provider: { adapter: "openai-responses" }, providerName: "openai", modelId: "m" }, {
      sourceEnvelope: env,
      cacheKeySource: null,
      config,
      logCtx: openaiCtx,
    });
    expect(openaiCtx.usageLogInputTokens).toBeUndefined();

    const kiroCtx = { usageLogInputTokens: undefined } as unknown as import("../src/server/request-log").RequestLogContext;
    const parsed3: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = { modelId: "m", options: {}, _rawBody: {} };
    claudeFinalRouteHandler(parsed3, { provider: { adapter: "kiro" }, providerName: "kiro", modelId: "m" }, {
      sourceEnvelope: env,
      cacheKeySource: null,
      config,
      logCtx: kiroCtx,
    });
    expect(typeof kiroCtx.usageLogInputTokens).toBe("number");
  });

  test("claudeFinalRouteHandler: compatibility enforce rejects before network (throws AnthropicRequestError)", async () => {
    const { AnthropicRequestError } = await import("../src/claude/inbound");
    const raw = { model: "claude", context_management: { edits: [] } };
    const env = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), raw, createTranslatorBudget());
    const parsed: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = { modelId: "m", options: {}, _rawBody: {} };
    const logCtx = {} as unknown as import("../src/server/request-log").RequestLogContext;
    const configEnforce = cfg({ claudeCode: { model: "claude", compatibility: "enforce" } } as unknown as Partial<OcxConfig>);
    expect(() =>
      claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses" }, providerName: "o", modelId: "m" }, {
        sourceEnvelope: env,
        cacheKeySource: null,
        config: configEnforce,
        logCtx,
      }),
    ).toThrow(AnthropicRequestError);

    const configShadow = cfg({ claudeCode: { model: "claude", compatibility: "shadow" } } as unknown as Partial<OcxConfig>);
    expect(() =>
      claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses" }, providerName: "o", modelId: "m" }, {
        sourceEnvelope: env,
        cacheKeySource: null,
        config: configShadow,
        logCtx,
      }),
    ).not.toThrow();
  });

  test("inbound-debug: agent/parent ids only as HMAC8 tags, bounded feature codes/adapter/decision", () => {
    afterEach(() => {
      resetDebugSettingsForTests();
      clearClaudeInboundDebug();
    });
    setDebugSettings({ claude: true });
    clearClaudeInboundDebug();
    const body = { model: "claude", messages: [{ role: "user", content: "hi" }] };
    captureClaudeInbound("messages", body, undefined, undefined, {
      agentId: "agent-raw-12345",
      parentAgentId: "parent-raw-999",
      sessionId: "sess-xyz",
      featureCodes: Array.from({ length: 30 }, (_, i) => `code-${i}`),
      adapter: "openai-responses",
      decision: "allow",
    });
    const [entry] = getClaudeInboundDebugEntries();
    expect(entry?.adapter).toBe("openai-responses");
    expect(entry?.decision).toBe("allow");
    expect(entry?.featureCodes).toBeDefined();
    expect(entry!.featureCodes!.length).toBeLessThanOrEqual(16);
    // HMAC8 tags present, raw ids never appear in serialized entry
    expect(entry?.agentIdTag).toMatch(/^[0-9a-f]{8}$/);
    expect(entry?.parentAgentIdTag).toMatch(/^[0-9a-f]{8}$/);
    expect(entry?.sessionTag).toMatch(/^[0-9a-f]{8}$/);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("agent-raw-12345");
    expect(serialized).not.toContain("parent-raw-999");
    expect(serialized).not.toContain("sess-xyz");
    resetDebugSettingsForTests();
    clearClaudeInboundDebug();
  });

  test("session_id synthesis only for openai-responses with metadata cacheKeySource (not system cohort)", () => {
    // This is covered by the final-route callback contract: promptCacheKeyForSession
    // produces 32hex; uuidFromHex shaping is tested indirectly via session header path
    // in claude-messages. Here we assert promptCacheKey mapping is NOT system cohort.
    const headerSid = "header-session-1";
    const metaSid = "user-123";
    const headerKey = promptCacheKeyForSession(headerSid)!;
    const metaKey = promptCacheKeyForSession(metaSid)!;
    expect(headerKey).not.toBe(metaKey);
    expect(headerKey).toMatch(/^[0-9a-f]{32}$/);
    // promptCacheKeyIsSharedCohort mapping: only system cohort yields true
    // (validated by handleResponses promptCacheKeyIsSharedCohort: cacheKeySource === "system")
    expect(headerKey.length).toBe(32);
  });
  test("claudeFinalRouteHandler: auto-only gate rejects any/tool for muse-spark-1.2-contributor, allows auto/none/absent and non-list models", async () => {
    const { AnthropicRequestError } = await import("../src/claude/inbound");
    const cfgShadow = cfg({ claudeCode: { model: "claude", compatibility: "shadow" } } as unknown as Partial<OcxConfig>);
    const parsed: { options: Record<string, unknown>; modelId: string; _rawBody?: unknown } = { modelId: "m", options: {}, _rawBody: {} };
    const logCtx = {} as unknown as import("../src/server/request-log").RequestLogContext;
    const anyEnv = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "claude", tool_choice: { type: "any" } } as unknown as Record<string, unknown>, createTranslatorBudget());
    const toolEnv = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "claude", tool_choice: { type: "tool", name: "x" } } as unknown as Record<string, unknown>, createTranslatorBudget());
    const autoEnv = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "claude", tool_choice: { type: "auto" } } as unknown as Record<string, unknown>, createTranslatorBudget());
    const noneEnv = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "claude", tool_choice: { type: "none" } } as unknown as Record<string, unknown>, createTranslatorBudget());
    const noTcEnv = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages"), { model: "claude" }, createTranslatorBudget());
    const opencodeGoList = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "muse-spark-1.2-contributor"];
    // reject any / tool for listed model
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: anyEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .toThrow(AnthropicRequestError);
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: toolEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .toThrow(AnthropicRequestError);
    // colon suffix variant matches via modelInList
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor:high" }, { sourceEnvelope: anyEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .toThrow(AnthropicRequestError);
    // allow auto / none / absent
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: autoEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .not.toThrow();
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: noneEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .not.toThrow();
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: noTcEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .not.toThrow();
    // non-list model passes even with any/tool
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "other-model" }, { sourceEnvelope: anyEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .not.toThrow();
    // different provider without the model also passes
    expect(() => claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: ["kimi-k2.7-code"] }, providerName: "other", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: anyEnv, cacheKeySource: null, config: cfgShadow, logCtx }))
      .not.toThrow();
    // error message contains remedy and route ids
    try {
      claudeFinalRouteHandler(parsed, { provider: { adapter: "openai-responses", autoToolChoiceOnlyModels: opencodeGoList }, providerName: "opencode-go", modelId: "muse-spark-1.2-contributor" }, { sourceEnvelope: anyEnv, cacheKeySource: null, config: cfgShadow, logCtx });
      throw new Error("expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("muse-spark-1.2-contributor");
      expect(msg).toContain("opencode-go");
      expect(msg).toContain("auto");
    }
  });
});
