import { describe, expect, test } from "bun:test";
import { buildSmokeScenarioRequest } from "../src/smoke/live-scenarios";
import { runProviderSmoke } from "../src/smoke/runner";

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
});
