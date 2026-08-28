import { describe, expect, test } from "bun:test";
import {
  createV2RoutedDelegationSseRewrite,
  injectV2RoutedDelegationBridge,
  rewriteV2RoutedDelegationCallsInJson,
} from "../src/server/responses/v2-routed-delegation-bridge";
import type { OcxParsedRequest } from "../src/types";

const GUIDANCE = "Use this routed-child mirror for collaboration operations.";

function parsed(body: Record<string, unknown>): OcxParsedRequest {
  return {
    modelId: "gpt-5.6-terra",
    stream: false,
    context: {
      messages: [],
      tools: [{ namespace: "collaboration", name: "spawn_agent", description: "native spawn", parameters: { type: "object", properties: { task: { type: "string" } } } }],
    },
    options: {},
    _rawBody: body,
  };
}

const spawn = { type: "function", name: "spawn_agent", description: "native spawn", parameters: { type: "object", properties: { task: { type: "string" } } }, strict: true };
const send = { type: "function", name: "send_message", description: "native send", parameters: { type: "object" } };
const followup = { type: "function", name: "followup_task", description: "native follow", parameters: { type: "object" } };

describe("V2 routed delegation bridge", () => {
  test("mirrors available collaboration functions without changing native declarations", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [spawn, send, { type: "function", name: "list_agents", parameters: {} }] }] };
    const request = parsed(body);
    const native = structuredClone(body.tools[0]);

    const active = injectV2RoutedDelegationBridge(request);

    expect(active?.names).toEqual(new Set(["spawn_agent", "send_message"]));
    expect(body.tools[0]).toEqual(native);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[1]).toEqual({
      type: "namespace",
      name: "ocx_agents",
      tools: [
        { ...spawn, description: `${GUIDANCE} spawn_agent.` },
        { ...send, description: `${GUIDANCE} send_message.` },
      ],
    });
    expect(request.context.tools).toEqual([
      { namespace: "collaboration", name: "spawn_agent", description: "native spawn", parameters: spawn.parameters },
      { namespace: "ocx_agents", name: "spawn_agent", description: `${GUIDANCE} spawn_agent.`, parameters: spawn.parameters },
      { namespace: "ocx_agents", name: "send_message", description: `${GUIDANCE} send_message.`, parameters: send.parameters },
    ]);
  });

  test("mirrors every catalog shape, exactly the available three functions, and is idempotent", () => {
    const body = {
      tools: [{ type: "namespace", name: "collaboration", tools: [spawn] }],
      input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "collaboration", tools: [send, followup] }] }],
    };
    const request = parsed(body);
    const first = injectV2RoutedDelegationBridge(request);
    const raw = structuredClone(body);
    const second = injectV2RoutedDelegationBridge(request);

    expect(first?.names).toEqual(new Set(["spawn_agent", "send_message", "followup_task"]));
    expect(second?.names).toEqual(first?.names);
    expect(body).toEqual(raw);
    expect((body.tools[1] as { tools: unknown[] }).tools).toHaveLength(1);
    expect(((body.input[0] as { tools: unknown[] }).tools[1] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  test("fails closed for a conflicting ocx_agents namespace", () => {
    const request = parsed({ tools: [
      { type: "namespace", name: "collaboration", tools: [spawn] },
      { type: "namespace", name: "ocx_agents", tools: [] },
    ] });
    expect(() => injectV2RoutedDelegationBridge(request)).toThrow("v2 routed delegation bridge namespace collision");
  });

  test("normalizes only armed mirror calls in JSON", () => {
    const active = { names: new Set(["spawn_agent"]) };
    const input = JSON.stringify({ output: [
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "{}", status: "completed" },
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_2", call_id: "call_2", arguments: "{}" },
      { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_3", call_id: "call_3", arguments: "{}" },
      { type: "function_call", namespace: 4, name: "spawn_agent", id: "fc_4", call_id: "call_4", arguments: "{}" },
    ] });

    expect(JSON.parse(rewriteV2RoutedDelegationCallsInJson(input, active))).toEqual({ output: [
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "{}", status: "completed", encrypted_function_args: [] },
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_2", call_id: "call_2", arguments: "{}" },
      { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_3", call_id: "call_3", arguments: "{}" },
      { type: "function_call", namespace: 4, name: "spawn_agent", id: "fc_4", call_id: "call_4", arguments: "{}" },
    ] });
  });

  test("normalizes SSE item snapshots and only matching interleaved argument events", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "", status: "in_progress" } });
    const unrelated = JSON.stringify({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_2", call_id: "call_2", arguments: "" } });

    expect(JSON.parse(rewrite(added))).toMatchObject({ item: { namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [] } });
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 4, delta: "{" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 3, arguments: "{}" })))).toMatchObject({ encrypted_function_args: [] });
    expect(JSON.parse(rewrite(unrelated))).toMatchObject({ item: { namespace: "ocx_agents", name: "list_agents" } });
  });
});
