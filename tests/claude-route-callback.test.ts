import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import type { ClaudeSourceEnvelope, OcxConfig } from "../src/types";

const config = {
  providers: {
    fixture: {
      adapter: "openai-chat",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-key",
      models: ["fixture-model"],
    },
  },
} as OcxConfig;

const envelope: ClaudeSourceEnvelope = {
  body: { model: "client-model", messages: [{ role: "user", content: "hello" }], context_management: {} },
  headers: { "anthropic-beta": "context-management-test" },
};

function request() {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/fixture-model", input: "hello", stream: false }),
  });
}

describe("Claude final-route callback", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a callback rejection becomes a sanitized 400 before upstream fetch", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("must not fetch");
    }) as typeof fetch;

    const response = await handleResponses(request(), config, { model: "", provider: "" }, {
      inboundWire: "anthropic",
      claudeSourceEnvelope: envelope,
      onResolvedRoute: ({ adapterName }) => {
        throw new Error(`unsupported feature code context_management for ${adapterName}`);
      },
    });

    expect(response.status).toBe(400);
    expect(fetches).toBe(0);
    const body = await response.json() as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.message).toContain("context_management");
  });
});
