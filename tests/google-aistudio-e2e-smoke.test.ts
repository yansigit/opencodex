import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { saveAiStudioSession } from "../src/oauth/aistudio-session-sync";
import { startServer } from "../src/server";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalFetch = globalThis.fetch;
let testDir = "";
let previousOpenCodexHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  globalAiStudioRelayHub.reset();
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-aistudio-smoke-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-aistudio-smoke-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalAiStudioRelayHub.reset();
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(testDir, { recursive: true, force: true });
});

describe("Google AI Studio Web Provider — End-to-End Smoke Tests", () => {
  test("E2E Smoke: routes Responses API prompt to Google AI Studio with SAPISIDHASH auth and MakerSuite parser", async () => {
    const config: OcxConfig = {
      port: 0,
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
          defaultModel: "gemini-3.7-flash",
          models: ["gemini-3.7-flash", "gemini-2.5-flash"],
          liveModels: false,
          requestPacing: { enabled: false },
        },
      },
      defaultProvider: "google-aistudio",
    };
    saveConfig(config);

    const sessionPath = join(testDir, "aistudio-session.json");
    saveAiStudioSession(
      {
        selectedProject: "gen-lang-client-smoke-test",
        windowId: "smoke-win-999",
        cookies: [
          { name: "SAPISID", value: "smoke_sapisid_token_123" },
          { name: "__Secure-1PSID", value: "smoke_psid_token_456" },
        ],
      },
      sessionPath,
    );

    let interceptedUrl = "";
    let interceptedAuth = "";
    let interceptedCookie = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("alkalimakersuite-pa.clients6.google.com")) {
        interceptedUrl = urlStr;
        const hdrs = (init?.headers as Record<string, string>) || {};
        interceptedAuth = hdrs["Authorization"] || "";
        interceptedCookie = hdrs["Cookie"] || "";

        const streamBody = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[[null, "Hello from real Google AI Studio inference!"]]\n'));
            controller.close();
          },
        });

        return new Response(streamBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-aistudio/gemini-3.7-flash",
          stream: false,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Say hello!" }],
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(interceptedUrl).toContain("alkalimakersuite-pa.clients6.google.com/v1internal:generateContent");
      expect(interceptedAuth).toMatch(/^SAPISIDHASH \d+_[a-f0-9]{40}$/);
      expect(interceptedCookie).toContain("SAPISID=smoke_sapisid_token_123");

      const data = await res.json() as any;
      expect(data).toBeDefined();
      expect(data.output).toBeDefined();
      expect(data.output[0]?.content?.some((c: any) => c.text?.includes("Hello from real Google AI Studio inference!"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("E2E Smoke: routes Chat Completions prompt via WebSocket relay bridge", async () => {
    const config: OcxConfig = {
      port: 0,
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
          defaultModel: "gemini-2.5-flash",
          models: ["gemini-2.5-flash"],
          liveModels: false,
          requestPacing: { enabled: false },
        },
      },
      defaultProvider: "google-aistudio",
    };
    saveConfig(config);

    const sentFrames: string[] = [];
    const mockWs = {
      send: (data: string) => {
        sentFrames.push(data);
        const msg = JSON.parse(data);
        if (msg.type === "http_request") {
          setTimeout(() => {
            globalAiStudioRelayHub.handleClientMessage("browser_session_smoke", JSON.stringify({
              id: msg.id,
              type: "stream_chunk",
              payload: {
                data: 'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Browser Relay!"}]},"finishReason":"STOP"}]}\n\n',
              },
            }));
            globalAiStudioRelayHub.handleClientMessage("browser_session_smoke", JSON.stringify({
              id: msg.id,
              type: "stream_end",
              payload: {},
            }));
          }, 5);
        }
      },
      close: () => {},
    };

    globalAiStudioRelayHub.registerSession("browser_session_smoke", mockWs as any);

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-aistudio/gemini-2.5-flash",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.choices[0]?.message?.content).toBe("Hello from Browser Relay!");
    } finally {
      globalAiStudioRelayHub.unregisterSession("browser_session_smoke");
      server.stop(true);
    }
  });

  test("E2E Smoke: complex coding agent tool call invocation and multi-turn execution loop", async () => {
    const config: OcxConfig = {
      port: 0,
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
          defaultModel: "gemini-3.7-flash",
          models: ["gemini-3.7-flash"],
          liveModels: false,
          requestPacing: { enabled: false },
        },
      },
      defaultProvider: "google-aistudio",
    };
    saveConfig(config);

    saveAiStudioSession({
      selectedProject: "gen-lang-client-complex-agent",
      windowId: "win-agent-999",
      cookies: [{ name: "SAPISID", value: "sapisid_agent_token" }],
    });

    let turnCount = 0;
    let lastRequestBody: any = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("alkalimakersuite-pa.clients6.google.com")) {
        turnCount++;
        lastRequestBody = JSON.parse(String(init?.body || "{}"));

        if (turnCount === 1) {
          const sse = [
            "data: " + JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "apply_patch",
                          args: { input: "*** Begin Patch\n+console.log(\"hello\");\n*** End Patch" },
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            "",
            "data: " + JSON.stringify({ candidates: [{ finishReason: "STOP" }] }),
            "",
            "",
          ].join("\n");
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        } else {
          const sse = [
            "data: " + JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: "The patch applied successfully." },
                      { text: "I have applied the patch successfully." },
                    ],
                  },
                },
              ],
            }),
            "",
            "data: " + JSON.stringify({ candidates: [{ finishReason: "STOP" }] }),
            "",
            "",
          ].join("\n");
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const turn1Res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-aistudio/gemini-3.7-flash",
          stream: false,
          tools: [
            {
              type: "function",
              name: "apply_patch",
              description: "Applies a code patch",
              parameters: {
                type: "object",
                properties: { input: { type: "string" } },
                required: ["input"],
              },
            },
          ],
          input: [
            { role: "user", content: [{ type: "input_text", text: "Patch the file" }] },
          ],
        }),
      });

      expect(turn1Res.status).toBe(200);
      const turn1Data = await turn1Res.json() as any;
      expect(turn1Data.output).toBeDefined();
      const toolCall = turn1Data.output.find((item: any) => item.type === "function_call");
      expect(toolCall).toBeDefined();
      expect(toolCall.name).toBe("apply_patch");
      expect(toolCall.arguments).toContain("Begin Patch");

      const turn2Res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-aistudio/gemini-3.7-flash",
          stream: false,
          input: [
            { role: "user", content: [{ type: "input_text", text: "Patch the file" }] },
            {
              type: "function_call",
              call_id: toolCall.call_id,
              name: "apply_patch",
              arguments: toolCall.arguments,
            },
            {
              type: "function_call_output",
              call_id: toolCall.call_id,
              output: JSON.stringify({ status: "success", applied: true }),
            },
          ],
        }),
      });

      expect(turn2Res.status).toBe(200);
      const turn2Data = await turn2Res.json() as any;
      expect(turn2Data.output).toBeDefined();
      const messageItem = turn2Data.output.find((item: any) => item.type === "message");
      expect(messageItem).toBeDefined();
      expect(messageItem.content.some((c: any) => c.text?.includes("applied the patch successfully"))).toBe(true);

      expect(lastRequestBody.contents).toBeDefined();
      expect(lastRequestBody.contents.some((c: any) => c.parts.some((p: any) => p.functionResponse))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("E2E Smoke: multi-agent subagent delegation and tool orchestration", async () => {
    const config: OcxConfig = {
      port: 0,
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
          defaultModel: "gemini-3.7-flash",
          models: ["gemini-3.7-flash"],
          liveModels: false,
          requestPacing: { enabled: false },
        },
      },
      defaultProvider: "google-aistudio",
    };
    saveConfig(config);

    saveAiStudioSession({
      selectedProject: "gen-lang-client-subagents",
      windowId: "win-subagents-123",
      cookies: [{ name: "SAPISID", value: "sapisid_multiagent" }],
    });

    let interceptedBody: any = null;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("alkalimakersuite-pa.clients6.google.com")) {
        interceptedBody = JSON.parse(String(init?.body || "{}"));
        const sse = [
          "data: " + JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: "I need to spawn a subagent to research in parallel." },
                    {
                      functionCall: {
                        name: "collaboration__spawn_agent",
                        args: {
                          task_name: "subagent_explorer",
                          message: "Explore codebase architecture",
                          model: "google-aistudio/gemini-3.7-flash",
                        },
                      },
                    },
                  ],
                },
              },
            ],
          }),
          "",
          "data: " + JSON.stringify({ candidates: [{ finishReason: "STOP" }] }),
          "",
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-aistudio/gemini-3.7-flash",
          stream: false,
          tools: [
            {
              type: "function",
              name: "collaboration__spawn_agent",
              description: "Spawns a subagent",
              parameters: {
                type: "object",
                properties: {
                  task_name: { type: "string" },
                  message: { type: "string" },
                  model: { type: "string" },
                },
                required: ["task_name", "message"],
              },
            },
          ],
          input: [
            { role: "user", content: [{ type: "input_text", text: "Spawn a subagent to explore" }] },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.output).toBeDefined();

      const spawnCall = data.output.find((item: any) => item.type === "function_call");
      expect(spawnCall).toBeDefined();
      expect(spawnCall.name).toBe("collaboration__spawn_agent");
      expect(spawnCall.arguments).toContain("subagent_explorer");

      expect(interceptedBody.tools).toBeDefined();
      expect(interceptedBody.tools[0].functionDeclarations.some((f: any) => f.name === "collaboration__spawn_agent")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
