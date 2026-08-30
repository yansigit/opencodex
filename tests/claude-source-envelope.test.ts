import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../src/lib/translator-budget";
import { parseRequest } from "../src/responses/parser";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import { claudeCodeSessionId } from "../src/adapters/client-fingerprint";
import { captureClaudeSourceEnvelope } from "../src/server/claude-messages";

function makeParsed(overrides: Partial<ReturnType<typeof parseRequest>> & { _claudeSourceEnvelope?: any } = {}): any {
  return {
    modelId: "claude-4-sonnet",
    stream: false,
    options: {},
    context: { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
    _rawBody: {},
    ...overrides,
  };
}

function budget() {
  return createTranslatorBudget({ maxTurnBytes: 32 * 1024 * 1024, maxCallArgumentBytes: 2 * 1024 * 1024 });
}

describe("claude source envelope – anthropic adapter", () => {
  test("ingress header allowlist reaches the Anthropic adapter unchanged", async () => {
    const source = { model: "client", max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
    const ingress = captureClaudeSourceEnvelope(new Request("http://localhost/v1/messages", {
      headers: { "anthropic-beta": "client-a, client-b", "anthropic-version": "2024-01-02", authorization: "secret" },
    }), source, budget());
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "provider-key" });
    const req = await adapter.buildRequest(makeParsed({ _claudeSourceEnvelope: ingress }), { headers: new Headers(), translatorBudget: budget() } as any);
    expect(req.headers["anthropic-beta"]).toBe("client-a,client-b");
    expect(req.headers["anthropic-version"]).toBe("2024-01-02");
    expect(req.headers["x-api-key"]).toBe("provider-key");
  });

  test("preserves unknown top-level fields and block order", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "sk-test" };
    const adapter = createAnthropicAdapter(provider);
    const envelopeBody: Record<string, unknown> = {
      model: "client-model",
      stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "chain", signature: "AbCdEf1234567890sig==" }, { type: "text", text: "answer" }] },
      ],
      max_tokens: 1234,
      unknown_top_level: "preserve-me",
      system: [{ type: "text", text: "sys" }],
    };
    const headers = { "anthropic-beta": "beta-a, beta-b", "anthropic-version": "2023-06-01" };
    const parsed = makeParsed({ modelId: "claude-sonnet-4", stream: false, _claudeSourceEnvelope: { body: envelopeBody, headers } });
    const incoming = { headers: new Headers(), translatorBudget: budget() };
    const req = await adapter.buildRequest(parsed, incoming as any);
    const body = JSON.parse(req.body);
    expect(body.unknown_top_level).toBe("preserve-me");
    expect(body.model).toBe("claude-sonnet-4");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1234);
    // block order and cache_control preserved (and not auto-placed)
    expect((body.messages as any)[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect((body.messages as any)[1].content[0].type).toBe("thinking");
    expect((body.messages as any)[1].content[0].signature).toBe("AbCdEf1234567890sig==");
  });

  test("validates explicit cache breakpoints without moving or deleting them", async () => {
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" });
    const cache = (ttl?: "1h" | "5m") => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
    const build = (body: Record<string, unknown>) => adapter.buildRequest(
      makeParsed({ _claudeSourceEnvelope: { body, headers: {} } }),
      { headers: new Headers(), translatorBudget: budget() } as any,
    );

    await expect(build({
      model: "x",
      tools: Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, input_schema: {}, cache_control: cache() })),
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow(/too many cache_control breakpoints/);

    await expect(build({
      model: "x",
      tools: [{ name: "short", input_schema: {}, cache_control: cache("5m") }],
      messages: [{ role: "user", content: [{ type: "text", text: "long", cache_control: cache("1h") }] }],
    })).rejects.toThrow(/invalid cache_control ttl ordering/);

    const valid = {
      model: "x",
      tools: [{ name: "long", input_schema: {}, cache_control: cache("1h") }],
      system: [{ type: "text", text: "short", cache_control: cache("5m") }],
      messages: [{ role: "user", content: [{ type: "text", text: "default", cache_control: cache() }] }],
    };
    const request = await build(valid);
    const output = JSON.parse(request.body);
    expect(output.tools[0].cache_control).toEqual(cache("1h"));
    expect(output.system[0].cache_control).toEqual(cache("5m"));
    expect(output.messages[0].content[0].cache_control).toEqual(cache());
  });

  test("does not mutate source envelope on per-attempt clone", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "sk-test" };
    const adapter = createAnthropicAdapter(provider);
    const envelopeBody: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }], custom: "orig" };
    const envelope = { body: envelopeBody as Record<string, unknown>, headers: {} as Record<string, string> };
    const parsed = makeParsed({ modelId: "m2", stream: true, _claudeSourceEnvelope: envelope });
    const b = budget();
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: b } as any);
    // source unchanged
    expect(envelopeBody.model).toBe("x");
    expect(envelopeBody.stream).toBe(false);
    expect((envelopeBody as any).custom).toBe("orig");
    // cloned rewritten
    const out = JSON.parse(req.body);
    expect(out.model).toBe("m2");
    expect(out.stream).toBe(true);
    req.releaseBodyObservation?.();
  });

  test("releases the serialized request budget exactly once", async () => {
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" });
    const body = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }] };
    const b = budget();
    const req = await adapter.buildRequest(
      makeParsed({ _claudeSourceEnvelope: { body, headers: {} } }),
      { headers: new Headers(), translatorBudget: b } as any,
    );
    expect(b.snapshot().currentBytes).toBeGreaterThan(0);
    req.releaseBodyObservation?.();
    expect(b.snapshot().currentBytes).toBe(0);
    b.chargeRetained(7, { kind: "request_copies" });
    req.releaseBodyObservation?.();
    expect(b.snapshot().currentBytes).toBe(7);
    b.releaseRetained(7, { kind: "request_copies" });
  });

  test("OAuth identity block appears first exactly once", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "oauth-token", authMode: "oauth" as const };
    const adapter = createAnthropicAdapter(provider);
    const body: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }], system: [{ type: "text", text: "orig" }] };
    const parsed = makeParsed({ modelId: "m", stream: false, _claudeSourceEnvelope: { body, headers: {} } });
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any);
    const out = JSON.parse(req.body);
    expect(out.system[0].text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(out.system.filter((b: any) => b.text === CLAUDE_CODE_SYSTEM_INSTRUCTION).length).toBe(1);
    // second call with already-present identity should not duplicate
    const body2: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }], system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, { type: "text", text: "second" }] };
    const parsed2 = makeParsed({ modelId: "m", stream: false, _claudeSourceEnvelope: { body: body2, headers: {} } as any });
    const req2 = await adapter.buildRequest(parsed2, { headers: new Headers(), translatorBudget: budget() } as any);
    const out2 = JSON.parse(req2.body);
    expect(out2.system.filter((b: any) => b.text === CLAUDE_CODE_SYSTEM_INSTRUCTION).length).toBe(1);
    expect(out2.system[0].text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
  });

  test("beta merge dedupes preserving client order and appends OAuth tokens", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "tok", authMode: "oauth" as const };
    const adapter = createAnthropicAdapter(provider);
    const body: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }] };
    const parsed = makeParsed({ modelId: "m", stream: false, _claudeSourceEnvelope: { body, headers: { "anthropic-beta": "b, a , b , ,c" } } });
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any);
    const beta = req.headers["anthropic-beta"] as string;
    const parts = beta.split(",");
    // client order deduped: b,a,c then oauth tokens appended if missing
    expect(parts.slice(0, 3)).toEqual(["b", "a", "c"]);
    for (const tok of ANTHROPIC_OAUTH_BETA.split(",")) expect(parts).toContain(tok);
  });

  test("version validation defaults and rejects malformed", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "sk" };
    const adapter = createAnthropicAdapter(provider);
    const body: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }] };
    // absent defaults to 2023-06-01
    const p1 = makeParsed({ _claudeSourceEnvelope: { body, headers: {} } });
    const r1 = await adapter.buildRequest(p1, { headers: new Headers(), translatorBudget: budget() } as any);
    expect(r1.headers["anthropic-version"]).toBe("2023-06-01");
    // malformed throws 400
    const p2 = makeParsed({ _claudeSourceEnvelope: { body, headers: { "anthropic-version": "bad" } } });
    await expect(adapter.buildRequest(p2, { headers: new Headers(), translatorBudget: budget() } as any)).rejects.toMatchObject({ name: "OcxRequestValidationError" });
    await expect(adapter.buildRequest(p2, { headers: new Headers(), translatorBudget: budget() } as any)).rejects.toThrow(/YYYY-MM-DD/);
    const p3 = makeParsed({ _claudeSourceEnvelope: { body, headers: { "anthropic-version": "" } } });
    await expect(adapter.buildRequest(p3, { headers: new Headers(), translatorBudget: budget() } as any)).rejects.toThrow(/non-empty/);
  });

  test("provider auth and headers precedence over source", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "real-key", headers: { "anthropic-beta": "provider-beta", "x-custom": "provider" } };
    const adapter = createAnthropicAdapter(provider);
    const body: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }] };
    const parsed = makeParsed({ _claudeSourceEnvelope: { body, headers: { "anthropic-beta": "client-beta", "anthropic-version": "2023-06-01" } } });
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any);
    // provider.headers wins for x-custom, and also overwrites beta if provider set it
    expect(req.headers["x-custom"]).toBe("provider");
    // anthropic-version from source preserved, not provider
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    // x-api-key derived from provider, not source (source never had it)
    expect(req.headers["x-api-key"]).toBe("real-key");
  });

  test("recomputes OAuth session id from current provider credential", async () => {
    const provider1 = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "token-one", authMode: "oauth" as const };
    const provider2 = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "token-two", authMode: "oauth" as const };
    const body: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }] };
    const parsed1 = makeParsed({ _claudeSourceEnvelope: { body, headers: {} } });
    const parsed2 = makeParsed({ _claudeSourceEnvelope: { body, headers: {} } });
    const r1 = await createAnthropicAdapter(provider1).buildRequest(parsed1, { headers: new Headers(), translatorBudget: budget() } as any);
    const r2 = await createAnthropicAdapter(provider2).buildRequest(parsed2, { headers: new Headers(), translatorBudget: budget() } as any);
    expect(r1.headers["X-Claude-Code-Session-Id"]).toBe(claudeCodeSessionId("token-one"));
    expect(r2.headers["X-Claude-Code-Session-Id"]).toBe(claudeCodeSessionId("token-two"));
    expect(r1.headers["X-Claude-Code-Session-Id"]).not.toBe(r2.headers["X-Claude-Code-Session-Id"]);
  });

  test("budget exceeded on clone/serialize throws TranslatorBudgetExceededError", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "sk" };
    const adapter = createAnthropicAdapter(provider);
    const bigBody: Record<string, unknown> = { model: "x", stream: false, messages: [{ role: "user", content: "hi" }], big: "a".repeat(1000) };
    const tinyBudget = createTranslatorBudget({ maxTurnBytes: 10, maxCallArgumentBytes: 10 });
    const parsed = makeParsed({ _claudeSourceEnvelope: { body: bigBody, headers: {} } });
    try {
      await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: tinyBudget } as any);
      throw new Error("expected TranslatorBudgetExceededError");
    } catch (e) {
      expect(isTranslatorBudgetExceededError(e)).toBe(true);
    }
  });

  test("provider or credential changes reject signed source history", async () => {
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk" });
    const body = {
      model: "x",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "old", signature: "AbCdEf1234567890sig==" }] }],
    };
    const parsed = makeParsed({ _stripReasoningEncryptedContent: true, _claudeSourceEnvelope: { body, headers: {} } });
    await expect(adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any)).rejects.toThrow(/fresh reasoning turn/);
  });

  test("OpenCodex-owned continuity is never sent as a genuine Anthropic signature", async () => {
    const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk" });
    const body = {
      model: "x",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "old", signature: "ocxr1:eyJ2IjoxLCJ0eHQiOiJvbGQifQ" }] }],
    };
    const parsed = makeParsed({ _claudeSourceEnvelope: { body, headers: {} } });
    await expect(adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any)).rejects.toThrow(/OpenCodex-owned reasoning continuity/);
  });

  test("tool name transforms applied on clone", async () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "tok", authMode: "oauth" as const };
    const adapter = createAnthropicAdapter(provider);
    const body: Record<string, unknown> = {
      model: "x", stream: false,
      messages: [{ role: "assistant", content: [
        { type: "tool_use", id: "id1", name: "my_tool", input: {} },
        {
          type: "tool_search_tool_result",
          tool_use_id: "search1",
          content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "my_tool" }] },
        },
      ] }],
      tools: [
        { name: "my_tool", description: "d", input_schema: { type: "object", properties: {} } },
        { name: "tool_search_tool_bm25", type: "tool_search_tool_bm25_20251119" },
      ],
      tool_choice: { type: "tool", name: "my_tool" },
    };
    const parsed = makeParsed({ _claudeSourceEnvelope: { body, headers: {} } });
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget() } as any);
    const out = JSON.parse(req.body);
    expect(out.tools[0].name).toBe("custom_my_tool");
    expect(out.tools[1].name).toBe("tool_search_tool_bm25");
    expect(out.messages[0].content[0].name).toBe("custom_my_tool");
    expect(out.messages[0].content[1].content.tool_references[0].tool_name).toBe("custom_my_tool");
    expect(out.tool_choice.name).toBe("custom_my_tool");
  });
});
