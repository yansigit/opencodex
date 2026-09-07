import { describe, expect, test } from "bun:test";
import { defaultTokenBenchmarkFixtureSet, materializeFixture } from "../../src/claude/token-benchmark";
import { estimateClaudeRequestTokens } from "../../src/server/claude-messages";
import { executeBenchmark, parseArgs, sendBenchmarkFixture, type BenchmarkDeps } from "../../scripts/benchmark-claude-tokens";
import type { OcxConfig } from "../../src/types";

const fakeConfig = { providers: { acme: { adapter: "anthropic", baseUrl: "https://example.invalid", models: ["claude-test"] } }, defaultProvider: "acme" } as any;
const route = { providerName: "acme", provider: fakeConfig.providers.acme, modelId: "claude-test", routeKind: "explicit-provider", routeReason: "explicit-provider-namespace" } as any;

test("strict parser is order independent and rejects malformed flags", () => {
  expect(parseArgs(["--model", "claude-test", "--provider", "acme"])).toEqual({ provider: "acme", model: "claude-test", json: false, confirmed: false });
  expect(() => parseArgs(["--provider", "acme", "--provider", "x", "--model", "m"])).toThrow();
  expect(() => parseArgs(["--provider", "-x", "--model", "m"])).toThrow();
  expect(() => parseArgs(["--provider", "acme", "--model", "m", "--wat"])).toThrow();
  expect(() => parseArgs(["--provider", "acme", "--model", "m", "--json", "--json"])).toThrow();
  expect(() => parseArgs(["--provider", "acme", "--model", "m", "--confirm-live-provider-charges", "--confirm-live-provider-charges"])).toThrow();
  expect(() => parseArgs(["--provider", "acme"])).toThrow();
});

test("no consent performs no config load or sends", async () => {
  let loads = 0; let sends = 0; const out: string[] = [];
  const deps = { loadConfig: () => { loads++; return fakeConfig; }, resolveRoute: () => route, send: async () => { sends++; return new Response(null, { status: 200 }); }, write: (s: string) => out.push(s) } as unknown as BenchmarkDeps;
  expect(await executeBenchmark({ provider: "acme", model: "claude-test", json: false, confirmed: false }, deps)).toBe(2);
  expect(loads).toBe(0); expect(sends).toBe(0); expect(out.join("\n")).toContain("can charge");
});

test("confirmed fake run is sequential, one send per fixture, and JSON is safe", async () => {
  let active = 0; let max = 0; let sends = 0; const out: string[] = [];
  const deps = {
    loadConfig: () => fakeConfig,
    resolveRoute: () => route,
    send: async (fixture: any, _target: unknown, _config: unknown, observe: (o: any) => void) => {
      expect(fixture.stream).toBe(false);
      expect(fixture.max_tokens).toBe(1);
      expect(fixture.model).toBe("claude-test");
      active++; max = Math.max(max, active); sends++; observe({ adapterKind: "anthropic", modelId: "claude-test", usage: { inputTokens: estimateClaudeRequestTokens(fixture, "claude-test"), outputTokens: 1 } }); active--; return new Response("{}", { status: 200 });
    },
    write: (s: string) => out.push(s),
    writeStatus: () => {},
  } as unknown as BenchmarkDeps;
  const code = await executeBenchmark({ provider: "acme", model: "claude-test", json: true, confirmed: true }, deps);
  expect(code).toBe(0); expect(max).toBe(1); expect(sends).toBe(defaultTokenBenchmarkFixtureSet.length); expect(JSON.parse(out.join("\n")).fixtures.length).toBe(8);
  for (const f of defaultTokenBenchmarkFixtureSet) expect(JSON.stringify(materializeFixture(f))).not.toContain("cache_control");
  expect(out.join("\n")).not.toContain("example.invalid");
});

test("invalid or variable targets fail before any send", async () => {
  const cases = [
    { config: { providers: {} }, route },
    { config: { providers: { acme: { ...fakeConfig.providers.acme, disabled: true } } }, route },
    { config: { providers: { acme: { ...fakeConfig.providers.acme, authMode: "oauth" } } }, route: { ...route, provider: { ...route.provider, authMode: "oauth" } } },
    { config: { providers: { acme: { ...fakeConfig.providers.acme, modelAdapters: { "claude-test": "openai-chat" } } } }, route: { ...route, provider: { ...route.provider, modelAdapters: { "claude-test": "openai-chat" } } } },
    { config: fakeConfig, route: { ...route, routeKind: "combo", combo: {} } },
    { config: fakeConfig, route: { ...route, providerName: "other" } },
    { config: fakeConfig, route: { ...route, modelId: "other-model" } },
    { config: fakeConfig, route: { ...route, provider: { ...route.provider, adapter: "openai-chat" } } },
  ];
  for (const entry of cases) {
    let sends = 0;
    const deps = {
      loadConfig: () => entry.config,
      resolveRoute: () => entry.route,
      send: async () => { sends++; return new Response("{}"); },
      write: () => {},
    } as unknown as BenchmarkDeps;
    expect(await executeBenchmark({ provider: "acme", model: "claude-test", json: false, confirmed: true }, deps)).toBe(2);
    expect(sends).toBe(0);
  }
});

test("missing, duplicate, estimated, and cached observations never pass", async () => {
  const modes = ["missing", "duplicate", "estimated", "cached"] as const;
  for (const mode of modes) {
    let sends = 0;
    const deps = {
      loadConfig: () => fakeConfig,
      resolveRoute: () => route,
      send: async (_fixture: unknown, _target: unknown, _config: unknown, observe: (o: any) => void) => {
        sends++;
        const usage = {
          inputTokens: 100,
          outputTokens: 1,
          ...(mode === "estimated" ? { estimated: true } : {}),
          ...(mode === "cached" ? { cacheReadInputTokens: 1 } : {}),
        };
        if (mode !== "missing") observe({ adapterKind: "anthropic", modelId: "claude-test", usage });
        if (mode === "duplicate") observe({ adapterKind: "anthropic", modelId: "claude-test", usage });
        return new Response("{}", { status: 200 });
      },
      write: () => {},
      writeStatus: () => {},
    } as unknown as BenchmarkDeps;
    expect(await executeBenchmark({ provider: "acme", model: "claude-test", json: true, confirmed: true }, deps)).toBe(1);
    expect(sends).toBe(defaultTokenBenchmarkFixtureSet.length);
  }
});

test("transport failures are not retried and error text is never rendered", async () => {
  let sends = 0;
  const out: string[] = [];
  const deps = {
    loadConfig: () => fakeConfig,
    resolveRoute: () => route,
    send: async () => { sends++; throw new Error("SECRET-UPSTREAM-ERROR-SENTINEL"); },
    write: (text: string) => out.push(text),
    writeStatus: () => {},
  } as unknown as BenchmarkDeps;
  expect(await executeBenchmark({ provider: "acme", model: "claude-test", json: true, confirmed: true }, deps)).toBe(1);
  expect(sends).toBe(defaultTokenBenchmarkFixtureSet.length);
  expect(out.join("\n")).not.toContain("SECRET-UPSTREAM-ERROR-SENTINEL");
});

test("production benchmark send uses the routed Anthropic path and observes usage once", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":37}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const config = {
    defaultProvider: "acme",
    providers: {
      acme: {
        adapter: "anthropic",
        baseUrl: upstream.url.toString().replace(/\/$/, ""),
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["claude-test"],
      },
    },
  } as OcxConfig;
  const before = structuredClone(config);
  const target = {
    providerName: "acme",
    provider: config.providers.acme,
    modelId: "claude-test",
    routeKind: "explicit-provider",
  } as any;
  const observations: any[] = [];
  try {
    const fixture = materializeFixture(defaultTokenBenchmarkFixtureSet[0]);
    const response = await sendBenchmarkFixture({ ...fixture, model: "claude-test", stream: false, max_tokens: 1 }, target, config, observation => observations.push(observation));
    expect(response.ok).toBe(true);
    await response.text();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/v1/messages");
    expect(requests[0].body.model).toBe("claude-test");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ adapterKind: "anthropic", modelId: "acme/claude-test", usage: { inputTokens: 37, outputTokens: 1 } });
    expect(config).toEqual(before);
  } finally {
    upstream.stop(true);
  }
});
