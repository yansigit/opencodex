import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { serializeSessionBundle } from "../src/oauth/aistudio-session-sync";

describe("aistudio legacy routes and session ingest endpoint", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  let testDir = "";

  function configuredServer() {
    testDir = mkdtempSync(join(tmpdir(), "ocx-aistudio-endpoint-"));
    process.env.OPENCODEX_HOME = testDir;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.openai.com/v1" } },
      corsAllowOrigins: ["chrome-extension://test-extension-id"],
    });
    return startServer(0);
  }

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    testDir = "";
  });

  test("extension requires the proxy key before harvesting and displays its exact origin", () => {
    const source = readFileSync(join(import.meta.dir, "..", "integrations", "aistudio-extension", "popup.js"), "utf8");
    expect(source.indexOf("Proxy API key is required")).toBeLessThan(source.indexOf("await harvestSession()", source.indexOf("btnAutoSync")));
    expect(source).toContain("chrome.runtime.id");
    expect(source).toContain('"x-opencodex-api-key": proxyApiKey');
  });
  test("GET /aistudio/bridge returns HTTP 410 HTML migration notice", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/aistudio/bridge", server.url));
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("HTTP 410 Gone");
      expect(html).toContain("AI Studio Browser Relay Deprecated");
      expect(html).toContain("ocx login");
    } finally {
      server.stop(true);
    }
  });

  test("GET /aistudio/bridge.user.js returns HTTP 410 JS migration notice", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/aistudio/bridge.user.js", server.url));
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toContain("javascript");
      const text = await res.text();
      expect(text).toContain("410 Gone");
      expect(text).toContain("deprecated");
    } finally {
      server.stop(true);
    }
  });

  test("GET /v1/ws/aistudio/status and WebSocket endpoints return HTTP 410", async () => {
    const server = startServer(0);
    try {
      const statusRes = await fetch(new URL("/v1/ws/aistudio/status", server.url));
      expect(statusRes.status).toBe(410);
      const statusJson = await statusRes.json() as any;
      expect(statusJson.error).toBe("gone");

      const wsRes = await fetch(new URL("/v1/ws/aistudio", server.url));
      expect(wsRes.status).toBe(410);

      const altWsRes = await fetch(new URL("/aistudio/ws", server.url));
      expect(altWsRes.status).toBe(410);
    } finally {
      server.stop(true);
    }
  });

  test("OPTIONS /api/aistudio/session preflight allows only a configured extension origin", async () => {
    const server = configuredServer();
    try {
      const res = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://test-extension-id",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type, X-OpenCodex-API-Key",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test-extension-id");
      const allowHeaders = res.headers.get("Access-Control-Allow-Headers") || "";
      expect(allowHeaders).toContain("Content-Type");
      expect(allowHeaders).toContain("X-OpenCodex-API-Key");
      expect(allowHeaders).not.toContain("Authorization");

      const rejected = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://attacker-extension-id",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(rejected.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  test("OPTIONS /api/aistudio/session preflight allows https://aistudio.google.com origin", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "OPTIONS",
        headers: {
          Origin: "https://aistudio.google.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://aistudio.google.com");
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/aistudio/session requires the dedicated key even on loopback", async () => {
    const server = configuredServer();
    try {
      const token = serializeSessionBundle({
        selectedProject: "projects/my-test-proj",
        windowId: "win_123",
        cookies: [{ name: "SAPISID", value: "test_sapisid_val" }],
      });
      const res = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "chrome-extension://test-extension-id",
          "x-opencodex-api-key": "local-secret",
        },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test-extension-id");
      const postJson = await res.json() as any;
      expect(postJson.ok).toBe(true);

      const missing = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "chrome-extension://test-extension-id" },
        body: JSON.stringify({ token }),
      });
      expect(missing.status).toBe(401);

      const bearer = await fetch(new URL("/api/aistudio/session", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "chrome-extension://test-extension-id", Authorization: "Bearer local-secret" },
        body: JSON.stringify({ token }),
      });
      expect(bearer.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
