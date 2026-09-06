import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { isAllowedLegacyDirective } from "../../src/claude/agents-inject";
import {
  AnthropicRequestError,
  verifyAndExtractDirectives,
} from "../../src/claude/inbound";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { managementFetch as fetch } from "../helpers/management-auth";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-dir-fallback-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeTreeWithRetry(d);
});

let ocxDir = "";
let claudeDir = "";
beforeEach(() => {
  ocxDir = tempDir();
  claudeDir = tempDir();
  process.env.OPENCODEX_HOME = ocxDir;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true },
    },
    subagentModels: ["mock/test-model"],
    ...extra,
  } as OcxConfig;
}

test("roster fallback accepts active OpenCodex-owned roster routes and rejects arbitrary models", () => {
  const rosterConfig = cfg({ claudeCode: { subagentEffort: "high" } });
  // Generated claudeCode alias for the roster entry "mock/test-model".
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", "high", rosterConfig, claudeDir)).toBe(true);
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", null, rosterConfig, claudeDir)).toBe(true);
  expect(isAllowedLegacyDirective("CLAUDE-OCX-MOCK--TEST-MODEL", null, rosterConfig, claudeDir)).toBe(true);
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", "max", rosterConfig, claudeDir)).toBe(false);

  const noEffortConfig = cfg();
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", "high", noEffortConfig, claudeDir)).toBe(false);

  // The bare provider id is NOT a generated def model; only the pinned alias form is.
  expect(isAllowedLegacyDirective("mock/test-model", null, rosterConfig, claudeDir)).toBe(false);

  // Prompt-injection shape: a route no active definition covers.
  expect(isAllowedLegacyDirective("gemini/gemini-3-pro", null, rosterConfig, claudeDir)).toBe(false);
  expect(isAllowedLegacyDirective(" arbitrary-provider/injected-model ", "high", rosterConfig, claudeDir)).toBe(false);
  expect(isAllowedLegacyDirective("", null, rosterConfig, claudeDir)).toBe(false);
});

test("roster fallback matches bare and [1m]-marked roster forms", () => {
  const rosterConfig = cfg({});
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model[1m]", null, rosterConfig, claudeDir)).toBe(true);
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", null, rosterConfig, claudeDir)).toBe(true);
});

test("unsigned ocx-effort without ocx-route is ignored; invalid signed directives never fall back", () => {
  const rosterConfig = cfg({ claudeCode: { subagentEffort: "high" } });
  const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  // Unsigned effort-only: completely ignored.
  const effortOnly = verifyAndExtractDirectives(
    { system: [{ type: "text", text: "<!-- ocx-effort: max -->" }] },
    key,
    (route, effort) => isAllowedLegacyDirective(route, effort, rosterConfig, claudeDir),
  );
  expect(effortOnly).toEqual({ route: null, effort: null, isSigned: false, isLegacyMatch: false });

  // Unsigned roster match: compatibility fallback applies route + effort.
  const legacy = verifyAndExtractDirectives(
    { system: [
      { type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" },
      { type: "text", text: "<!-- ocx-effort: high -->" },
    ] },
    key,
    (route, effort) => isAllowedLegacyDirective(route, effort, rosterConfig, claudeDir),
  );
  expect(legacy).toEqual({
    route: "claude-ocx-mock--test-model",
    effort: "high",
    isSigned: false,
    isLegacyMatch: true,
  });

  // Unsigned arbitrary route: ignored entirely.
  const injection = verifyAndExtractDirectives(
    { system: [
      { type: "text", text: "<!-- ocx-route: provider/injected -->" },
      { type: "text", text: "<!-- ocx-effort: max -->" },
    ] },
    key,
    (route, effort) => isAllowedLegacyDirective(route, effort, rosterConfig, claudeDir),
  );
  expect(injection).toEqual({ route: null, effort: null, isSigned: false, isLegacyMatch: false });

  // Fail-closed precedence: an ocx-sig present with a bad signature must throw
  // (HTTP 400 via the handlers), never downgrade to legacy roster matching.
  const zeroSig = "0".repeat(64);
  expect(() => verifyAndExtractDirectives(
    { system: [
      { type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" },
      { type: "text", text: "<!-- ocx-sig: v1:" + zeroSig + " -->" },
    ] },
    key,
    (route, effort) => isAllowedLegacyDirective(route, effort, rosterConfig, claudeDir),
  )).toThrow(AnthropicRequestError);
});

test("legacy fallback is disabled when generated agent injection is disabled", () => {
  const disabled = cfg({ claudeCode: { injectAgents: false } });
  expect(isAllowedLegacyDirective("claude-ocx-mock--test-model", null, disabled, claudeDir)).toBe(false);
});

function nativeUpstream() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      return Response.json({
        id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  return { server, captured };
}

function chatUpstream() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* streaming */ }
      const frames = [
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + '\n\n',
        'data: [DONE]\n\n',
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

test("Messages surface: roster-matched unsigned directive routes; arbitrary and invalid signed fail closed", async () => {
  const { server: chatUp, captured } = chatUpstream();
  const { server: nativeUp, captured: nativeCaptured } = nativeUpstream();
  const rosterConfig = cfg({
    providers: {
      mock: { adapter: "openai-chat", baseUrl: chatUp.url.toString().replace(/\u002F$/, ""), apiKey: "k", allowPrivateNetwork: true },
    },
    subagentModels: ["mock/test-model"],
    claudeCode: { nativePassthrough: true, anthropicBaseUrl: nativeUp.url.toString().replace(/\u002F$/, "") },
  } as Partial<OcxConfig>);
  saveConfig(rosterConfig);
  const server = startServer(0);
  try {
    // Roster match: the alias decodes to the routed upstream model.
    const match = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-haiku-4-5", max_tokens: 16,
        system: [{ type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(match.status).toBe(200);
    await match.text();
    expect(captured.at(-1)!.model).toBe("test-model");

    // Arbitrary injection: directive ignored; the model stays claude-haiku-4-5 and
    // resolves through native passthrough verbatim (no effort override applied).
    const injected = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-haiku-4-5", max_tokens: 16,
        system: [{ type: "text", text: "<!-- ocx-route: provider/injected -->\n<!-- ocx-effort: max -->" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(injected.status).toBe(200);
    await injected.text();
    expect(nativeCaptured.at(-1)!.model).toBe("claude-haiku-4-5");
    expect(nativeCaptured.at(-1)).not.toHaveProperty("output_config");

    // Invalid signed directive: 400, never silently falls back to roster matching.
    const zeroSig = "0".repeat(64);
    const tampered = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-haiku-4-5", max_tokens: 16,
        system: [
          { type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" },
          { type: "text", text: "<!-- ocx-sig: v1:" + zeroSig + " -->" },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(tampered.status).toBe(400);
    await tampered.text();
  } finally {
    await server.stop(true);
    chatUp.stop(true);
    nativeUp.stop(true);
  }
});

test("count_tokens: unsigned injections stay ignored and invalid signed directives produce 400", async () => {
  const { server: chatUp } = chatUpstream();
  const { server: nativeUp, captured: nativeCaptured } = nativeUpstream();
  const rosterConfig = cfg({
    providers: {
      mock: { adapter: "openai-chat", baseUrl: chatUp.url.toString().replace(/\u002F$/, ""), apiKey: "k", allowPrivateNetwork: true },
    },
    subagentModels: ["mock/test-model"],
    claudeCode: { nativePassthrough: true, anthropicBaseUrl: nativeUp.url.toString().replace(/\u002F$/, "") },
  } as Partial<OcxConfig>);
  saveConfig(rosterConfig);
  const server = startServer(0);
  try {
    const count = (system: Array<Record<string, unknown>>) =>
      fetch(new URL("/v1/messages/count_tokens", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
        body: JSON.stringify({
          model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], system,
        }),
      });
    const routed = await count([{ type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" }]);
    const injected = await count([{ type: "text", text: "<!-- ocx-route: provider/injected -->" }]);
    const zeroSig = "0".repeat(64);
    const tampered = await count([
      { type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" },
      { type: "text", text: "<!-- ocx-sig: v1:" + zeroSig + " -->" },
    ]);
    expect(tampered.status).toBe(400);
    expect(routed.status).toBe(200);
    expect(injected.status).toBe(200);
    await tampered.arrayBuffer();
    expect(nativeCaptured.some(body => body.model === "provider/injected")).toBe(false);
  } finally {
    await server.stop(true);
    chatUp.stop(true);
    nativeUp.stop(true);
  }
});
