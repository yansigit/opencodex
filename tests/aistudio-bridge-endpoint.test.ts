import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server";
import { serializeSessionBundle } from "../src/oauth/aistudio-session-sync";

describe("aistudio legacy routes and session ingest endpoint", () => {
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

  test("OPTIONS /api/aistudio/session preflight allows chrome-extension origin", async () => {
    const server = startServer(0);
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

  test("POST /api/aistudio/session reflects chrome-extension origin in CORS header and saves session", async () => {
    const server = startServer(0);
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
        },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test-extension-id");
      const postJson = await res.json() as any;
      expect(postJson.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
