import { describe, expect, test } from "bun:test";
import { getAiStudioBridgeHtml, getAiStudioUserScript, globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";
import { startServer } from "../src/server";
import { serializeSessionBundle } from "../src/oauth/aistudio-session-sync";

describe("aistudio bridge HTTP endpoint", () => {
  test("contains valid HTML and websocket bridge script", async () => {
    const req = new Request("http://127.0.0.1:4000/aistudio/bridge");
    expect(req.url).toContain("/aistudio/bridge");
    const html = getAiStudioBridgeHtml(10100);
    expect(html).toContain("Google AI Studio Bridge");
    expect(html).toContain("bridge.user.js");
    expect(html).toContain("ws://127.0.0.1:10100/v1/ws/aistudio");
  });
  test("user script endpoint", async () => {
    const req = new Request("http://127.0.0.1:4000/aistudio/bridge.user.js");
    expect(req.url).toContain("/aistudio/bridge.user.js");
    const userScript = getAiStudioUserScript(10100);
    expect(userScript).toContain("@match        https://aistudio.google.com/*");
    expect(userScript).toContain("ws://127.0.0.1:10100/v1/ws/aistudio");
    expect(userScript).toContain('credentials: "include"');
  });

  test("session ingest route is guarded by data-plane admission on non-loopback binds", async () => {
    const source = await Bun.file(new URL("../src/server/index.ts", import.meta.url)).text();
    const routeStart = source.indexOf('url.pathname === "/api/aistudio/session"');
    const routeEnd = source.indexOf('url.pathname === "/aistudio/bridge"', routeStart);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(routeStart, routeEnd)).toContain("resolveApiAuth(req, policy)");
  });

  test("server serves bridge HTML, userscript, status, and session ingest routes", async () => {
    const server = startServer(0);
    try {
      // GET /aistudio/bridge
      const bridgeRes = await fetch(new URL("/aistudio/bridge", server.url));
      expect(bridgeRes.status).toBe(200);
      expect(bridgeRes.headers.get("content-type")).toContain("text/html");
      const bridgeBody = await bridgeRes.text();
      expect(bridgeBody).toContain("Google AI Studio Bridge");

      // GET /aistudio/bridge.user.js
      const userJsRes = await fetch(new URL("/aistudio/bridge.user.js", server.url));
      expect(userJsRes.status).toBe(200);
      expect(userJsRes.headers.get("content-type")).toContain("javascript");
      const userJsBody = await userJsRes.text();
      expect(userJsBody).toContain("OpenCodex AI Studio Relay Bridge");

      // GET /v1/ws/aistudio/status
      const statusRes = await fetch(new URL("/v1/ws/aistudio/status", server.url));
      expect(statusRes.status).toBe(200);
      const statusJson = await statusRes.json() as any;
      expect(statusJson).toHaveProperty("activeSessions");
      expect(statusJson).toHaveProperty("hasActiveSessions");

      // POST /api/aistudio/session with invalid body -> 400
      const badRes = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });
      expect(badRes.status).toBe(400);

      // POST /api/aistudio/session with valid token
      const token = serializeSessionBundle({
        selectedProject: "projects/my-test-proj",
        windowId: "win_123",
        cookies: [{ name: "SAPISID", value: "test_sapisid_val" }],
      });
      const postRes = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(postRes.status).toBe(200);
      const postJson = await postRes.json() as any;
      expect(postJson.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
