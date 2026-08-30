import { describe, expect, test } from "bun:test";
import { buildClaudeMcpSmokeRequest, buildSmokeScenarioRequest, CLAUDE_MCP_SMOKE_TOOL_NAME } from "../src/smoke/live-scenarios";
import { providerHasSmokeCredential, runProviderSmoke } from "../src/smoke/runner";

describe("live smoke scenarios", () => {
  test("builds the three standard response requests", () => {
    expect(buildSmokeScenarioRequest(1, "test-model")).toMatchObject({ model: "test-model", stream: true });
    expect(buildSmokeScenarioRequest(2, "test-model").tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "exec_command" }),
    ]));
    expect(buildSmokeScenarioRequest(3, "test-model", { previousResponseId: "resp_1", toolResult: "smoke_test_123" })).toMatchObject({
      previous_response_id: "resp_1",
      input: expect.arrayContaining([expect.objectContaining({ type: "function_call_output", output: "smoke_test_123" })]),
    });
  });

  test("builds a Claude Messages MCP tool loop without server-hosted MCP fields", () => {
    const first = buildClaudeMcpSmokeRequest("test-model");
    expect(first.tools).toEqual([expect.objectContaining({ name: CLAUDE_MCP_SMOKE_TOOL_NAME })]);
    expect(first.tool_choice).toBeUndefined();

    const second = buildClaudeMcpSmokeRequest("test-model", {
      assistantContent: [{ type: "tool_use", id: "tool_1", name: CLAUDE_MCP_SMOKE_TOOL_NAME, input: { marker: "smoke_test_123" } }],
      toolUseId: "tool_1",
    });
    expect(second.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [expect.objectContaining({ type: "tool_result", tool_use_id: "tool_1" })] }),
    ]));
  });
});

describe("provider smoke runner", () => {
  test("skips providers without a usable credential before spending a live request", () => {
    expect(providerHasSmokeCredential({ authMode: "local" })).toBe(false);
    expect(providerHasSmokeCredential({ authMode: "oauth" }, { access: "token" })).toBe(true);
    expect(providerHasSmokeCredential({ authMode: "forward" })).toBe(true);
  });

  test("runs all levels sequentially and records a pass", async () => {
    const originalFetch = globalThis.fetch;
    const originalHome = process.env.OPENCODEX_HOME;
    const cachePath = `/tmp/ocx-smoke-runner-${Date.now()}.json`;
    process.env.OPENCODEX_HOME = `/tmp/ocx-smoke-home-${Date.now()}`;
    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (new URL(String(input)).pathname === "/v1/messages") {
        const parsed = bodies.at(-1) as Record<string, unknown>;
        const messages = parsed.messages as Array<Record<string, unknown>>;
        const continuation = messages.some(message => Array.isArray(message.content) && message.content.some(item => (item as Record<string, unknown>).type === "tool_result"));
        return Response.json(continuation
          ? { id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text: "MCP_SMOKE_OK" }], stop_reason: "end_turn" }
          : { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: CLAUDE_MCP_SMOKE_TOOL_NAME, input: { marker: "smoke_test_123" } }], stop_reason: "tool_use" });
      }
      const n = bodies.length;
      const payload = n === 2
        ? { type: "response.completed", response: { id: "resp_tool", output: [{ type: "function_call", name: "exec_command", arguments: '{"cmd":"echo \\"smoke_test_123\\""}' }] } }
        : { type: "response.output_text.delta", delta: "hello" };
      const terminal = n === 2 ? "response.completed" : "response.completed";
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify({ type: terminal, response: { id: `resp_${n}`, status: "completed", stop_reason: "stop" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const result = await runProviderSmoke({ provider: "openai", modelId: "test-model", force: true, cachePath });
      expect(result.status).toBe("passed");
      expect(result.level1Passed && result.level2Passed && result.level3Passed).toBe(true);
      expect(result.claudeMcpPassed).toBe(true);
      expect(bodies).toHaveLength(5);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
    }
  });

  test("accepts a direct non-streaming JSON completion response", async () => {
    const originalFetch = globalThis.fetch;
    const cachePath = "/tmp/ocx-smoke-json-" + Date.now() + ".json";
    globalThis.fetch = async (input, init) => {
      const parsed = JSON.parse(String(init?.body));
      if (new URL(String(input)).pathname === "/v1/messages") {
        const messages = parsed.messages as Array<Record<string, unknown>>;
        const continuation = messages.some(message => Array.isArray(message.content) && message.content.some(item => (item as Record<string, unknown>).type === "tool_result"));
        return Response.json(continuation
          ? { id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text: "MCP_SMOKE_OK" }], stop_reason: "end_turn" }
          : { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: CLAUDE_MCP_SMOKE_TOOL_NAME, input: { marker: "smoke_test_123" } }], stop_reason: "tool_use" });
      }
      const hasTools = Array.isArray(parsed.tools);
      const isL3 = Array.isArray(parsed.input) && parsed.input.some((i: { type: string }) => i.type === "function_call_output");
      if (isL3) {
        return new Response(JSON.stringify({ id: "resp_3", status: "completed", output: [] }), { headers: { "content-type": "application/json" } });
      }
      if (hasTools) {
        return new Response(JSON.stringify({
          id: "resp_2",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: 'echo "smoke_test_123"' }) }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [{ type: "message", content: "hello" }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const result = await runProviderSmoke({ provider: "openai", modelId: "test-model", force: true, cachePath });
      expect(result.status).toBe("passed");
      expect(result.level1Passed && result.level2Passed && result.level3Passed).toBe(true);
      expect(result.claudeMcpPassed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runs the Claude MCP loop independently of Responses levels", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(parsed);
      const messages = parsed.messages as Array<Record<string, unknown>>;
      const continuation = messages.some(message => Array.isArray(message.content) && message.content.some(item => (item as Record<string, unknown>).type === "tool_result"));
      return Response.json(continuation
        ? { id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text: "MCP_SMOKE_OK" }], stop_reason: "end_turn" }
        : { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: CLAUDE_MCP_SMOKE_TOOL_NAME, input: { marker: "smoke_test_123" } }], stop_reason: "tool_use" });
    };
    try {
      const result = await runProviderSmoke({ provider: "openai", modelId: "test-model", force: true, claudeMcpOnly: true, cachePath: `/tmp/ocx-smoke-claude-mcp-${Date.now()}.json` });
      expect(result.status).toBe("passed");
      expect(result.claudeMcpPassed).toBe(true);
      expect(result.level1Passed || result.level2Passed || result.level3Passed).toBe(false);
      expect(seen).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves a proxy path prefix for both smoke endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/prefix/v1/messages")) {
        const messages = parsed.messages as Array<Record<string, unknown>>;
        const continuation = messages.some(message => Array.isArray(message.content) && message.content.some(item => (item as Record<string, unknown>).type === "tool_result"));
        return Response.json(continuation
          ? { id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text: "MCP_SMOKE_OK" }], stop_reason: "end_turn" }
          : { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: CLAUDE_MCP_SMOKE_TOOL_NAME, input: {} }], stop_reason: "tool_use" });
      }
      return Response.json({ id: "resp", status: "completed", output: [] });
    };
    try {
      const result = await runProviderSmoke({ provider: "openai", modelId: "test-model", proxyUrl: "https://proxy.test/prefix/v1/responses", force: true, claudeMcpOnly: true, cachePath: `/tmp/ocx-smoke-prefix-${Date.now()}.json` });
      expect(result.status).toBe("passed");
      expect(urls).toEqual(["https://proxy.test/prefix/v1/messages", "https://proxy.test/prefix/v1/messages"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
