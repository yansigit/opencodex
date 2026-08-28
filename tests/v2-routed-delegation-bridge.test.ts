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

  test("accepts a key-reordered injected mirror as idempotent", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [spawn] }] };
    const request = parsed(body);
    injectV2RoutedDelegationBridge(request);
    const mirror = body.tools[1] as { tools: Array<Record<string, unknown>> };
    mirror.tools[0] = Object.fromEntries(Object.entries(mirror.tools[0]!).reverse());

    expect(() => injectV2RoutedDelegationBridge(request)).not.toThrow();
  });

  test("leaves a collaboration group with no mirrorable function inactive", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "wait_agent", parameters: {} }] }] };
    const request = parsed(body);
    const before = structuredClone(body);
    const tools = structuredClone(request.context.tools);

    expect(injectV2RoutedDelegationBridge(request)).toBeUndefined();
    expect(body).toEqual(before);
    expect(request.context.tools).toEqual(tools);
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

  test("preserves owned __proto__ data while normalizing untrusted JSON", () => {
    const input = '{"__proto__":{"polluted":true},"type":"function_call","namespace":"ocx_agents","name":"spawn_agent"}';
    const output = JSON.parse(rewriteV2RoutedDelegationCallsInJson(input, { names: new Set(["spawn_agent"]) }));

    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(output.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  test("normalizes SSE item snapshots and only matching interleaved argument events", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "", status: "in_progress" } });
    const unrelated = JSON.stringify({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_2", call_id: "call_2", arguments: "" } });

    expect(JSON.parse(rewrite(added))).toMatchObject({ item: { namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [] } });
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "native_fc", output_index: 3, delta: "{" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 4, delta: "{" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 3, arguments: "{}" })))).toMatchObject({ encrypted_function_args: [] });
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 3, delta: "late" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(unrelated))).toMatchObject({ item: { namespace: "ocx_agents", name: "list_agents" } });
  });

  test("leaves ID-less mirror snapshots and index-only arguments untouched", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const snapshot = JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent" } });

    expect(rewrite(snapshot)).toBe(snapshot);
    const argument = JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 3, delta: "{}" });
    expect(rewrite(argument)).toBe(argument);
  });

  test("caps retained SSE mirror bindings", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    for (let index = 0; index < 129; index++) {
      const snapshot = rewrite(JSON.stringify({ type: "response.output_item.added", output_index: index, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: `fc_${index}` } }));
      if (index === 128) expect(JSON.parse(snapshot)).toMatchObject({ item: { namespace: "ocx_agents", name: "spawn_agent" } });
    }

    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_128", output_index: 128, delta: "{}" }))).encrypted_function_args).toBeUndefined();
  });

  test("keeps only authorized nonblank ids through completed aggregates", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const snapshot = (id: string, output_index: number) => JSON.stringify({ type: "response.output_item.added", output_index, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id } });
    for (let index = 0; index < 128; index++) rewrite(snapshot(`fc_${index}`, index));
    expect(rewrite(snapshot("fc_capped", 128))).toContain('"namespace":"ocx_agents"');
    expect(rewrite(snapshot(" ", 129))).toContain('"namespace":"ocx_agents"');
    const completed = JSON.parse(rewrite(JSON.stringify({ type: "response.completed", response: { output: [
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_0" },
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_capped" },
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: " " },
    ] } })));

    expect(completed.response.output.map((item: { namespace: string }) => item.namespace)).toEqual(["collaboration", "ocx_agents", "ocx_agents"]);
    expect(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_0", delta: "late" }))).toContain('"item_id":"fc_0"');
  });

  test("an unknown item-id terminal does not affect an authorized call", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    rewrite(JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_known" } }));
    const unknown = JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_unknown", arguments: "{}" });

    expect(rewrite(unknown)).toBe(unknown);
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_known", delta: "{}" }))).encrypted_function_args).toEqual([]);
  });

  test("does not reauthorize arguments after a call closes", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_closed" } });
    rewrite(added);
    rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_closed", arguments: "{}" }));
    rewrite(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_closed" } }));

    const late = JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_closed", delta: "late" });
    expect(rewrite(late)).toBe(late);
  });

  test("keeps capped ids rejected after a slot frees", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = (id: string) => JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id } });
    for (let index = 0; index < 128; index++) rewrite(added(`fc_${index}`));
    const capped = added("fc_capped");
    expect(rewrite(capped)).toBe(capped);
    rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_0", arguments: "{}" }));
    const done = JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_capped" } });
    expect(rewrite(done)).toBe(done);
    expect(rewrite(JSON.stringify({ type: "response.completed", response: { output: [{ type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_capped" }] } }))).toContain('"namespace":"ocx_agents"');
  });
});
