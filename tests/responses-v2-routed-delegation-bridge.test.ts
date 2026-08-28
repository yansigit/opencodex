import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/agent-task-recovery";

const savedCodexHome = process.env.CODEX_HOME;
const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-routed-delegation-bridge-"));

beforeAll(() => {
  writeFileSync(join(codexHome, "config.toml"), "[features.multi_agent_v2]\nenabled = true\n");
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    defaultProvider: "openai",
    multiAgentMode: "v2",
    v2RoutedDelegationBridge: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt("acct-bridge")}`,
      "chatgpt-account-id": "acct-bridge",
      originator: "codex_cli_rs",
    },
    body: JSON.stringify(body),
  });
}

function rootBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5.6-luna",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] }],
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object" } },
        { type: "function", name: "send_message", parameters: { type: "object" } },
      ],
    }],
    stream: false,
    ...extra,
  };
}

describe("Responses V2 routed delegation bridge runtime", () => {
  test("injects a canonical V2 root and normalizes its JSON mirror call before caching", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "resp_bridge",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_bridge",
          call_id: "call_bridge",
          namespace: "ocx_agents",
          name: "spawn_agent",
          arguments: "{\"task\":\"sentinel\"}",
        }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody()), config(), { model: "", provider: "" });
      const output = await response.json() as { output: Array<Record<string, unknown>> };

      expect(requests).toHaveLength(1);
      expect((requests[0]?.tools as Array<Record<string, unknown>>)[0]?.name).toBe("collaboration");
      expect((requests[0]?.tools as Array<Record<string, unknown>>)[1]).toMatchObject({
        type: "namespace", name: "ocx_agents", tools: [{ name: "spawn_agent" }, { name: "send_message" }],
      });
      expect(output.output[0]).toMatchObject({
        namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the same JSON normalization for the canonical websocket path", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ id: "resp_ws", status: "completed", output: [{
      type: "function_call", id: "fc_ws", call_id: "call_ws", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
    }] })) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody()), config(), { model: "", provider: "" }, { inboundTransport: "websocket" });
      expect((await response.json() as { output: Array<Record<string, unknown>> }).output[0]).toMatchObject({
        namespace: "collaboration", encrypted_function_args: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails a mirror namespace collision before upstream I/O", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("collision must not fetch");
    }) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody({ tools: [
        ...(rootBody().tools as unknown[]),
        { type: "namespace", name: "ocx_agents", tools: [] },
      ] })), config(), { model: "", provider: "" });

      expect(response.status).toBe(400);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rewrites split SSE calls only for an eligible root", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response([
      "data: ", JSON.stringify({ type: "response.output_item.added", item: {
        type: "function_call", id: "fc_bridge", call_id: "call_bridge", namespace: "ocx_agents", name: "spawn_agent", arguments: "",
      } }), "\n\n",
      "data: ", JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_bridge", arguments: "{}" }), "\n\n",
      "data: ", JSON.stringify({ type: "response.completed", response: { id: "resp_sse", status: "completed", output: [{
        type: "function_call", id: "fc_bridge", call_id: "call_bridge", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
      }] } }), "\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody({ stream: true })), config(), { model: "", provider: "" });
      const text = await response.text();

      expect(text).toContain('"namespace":"collaboration"');
      expect(text).toContain('"encrypted_function_args":[]');
      expect(text).not.toContain('"namespace":"ocx_agents"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps a capped SSE mirror out of both the client and replay normalization", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let turn = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      turn += 1;
      if (turn === 1) return new Response([
        ...Array.from({ length: 128 }, (_, index) => `data: ${JSON.stringify({
          type: "response.output_item.added", item: {
            type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, namespace: "ocx_agents", name: "spawn_agent", arguments: "",
          },
        })}\n\n`),
        "data: ", JSON.stringify({ type: "response.completed", response: { id: "resp_idless", status: "completed", output: [{
          type: "function_call", id: "fc_cap", call_id: "call_cap", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
        }] } }), "\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "resp_second", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const first = await handleResponses(request(rootBody({ stream: true })), config(), { model: "", provider: "" });
      expect(await first.text()).toContain('"namespace":"ocx_agents"');
      await handleResponses(request(rootBody({ previous_response_id: "resp_idless" })), config(), { model: "", provider: "" });

      expect(JSON.stringify(requests[1]?.input)).toContain('"namespace":"ocx_agents"');
      expect(JSON.stringify(requests[1]?.input)).not.toContain('"encrypted_function_args":[]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("leaves the canonical catalog unchanged when disabled", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: "resp_disabled", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const disabled = config();
      disabled.v2RoutedDelegationBridge = false;
      await handleResponses(request(rootBody()), disabled, { model: "", provider: "" });

      expect(requests[0]?.tools).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
