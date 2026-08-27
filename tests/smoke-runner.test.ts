import { describe, expect, test } from "bun:test";
import { buildSmokeScenarioRequest } from "../src/smoke/live-scenarios";
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
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
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
      expect(bodies).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
    }
  });

  test("accepts a direct non-streaming JSON completion response", async () => {
    const originalFetch = globalThis.fetch;
    const cachePath = "/tmp/ocx-smoke-json-" + Date.now() + ".json";
    globalThis.fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body));
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
