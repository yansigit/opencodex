import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeConfigDTO } from "../src/server/auth-cors";
import { handleManagementAPI } from "../src/server/management-api";
import { saveAiStudioSession } from "../src/oauth/aistudio-session-sync";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { startServer } from "../src/server";

const TEST_DIR = join(tmpdir(), "ocx-aistudio-status-" + Date.now());
const prevHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function cfg(): OcxConfig {
  const c = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-aistudio",
    providers: {
      "google-aistudio": {
        adapter: "google" as const,
        baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
        googleMode: "ai-studio-web" as const,
      },
    },
  } as OcxConfig;
  saveConfig(c);
  return c;
}

describe("AI Studio status & re-auth", () => {
  test("safeConfigDTO exposes compatibility session state and needs-reauth auth state", () => {
    const dto = safeConfigDTO(cfg()) as any;
    const prov = dto.providers["google-aistudio"];
    expect(typeof prov.hasAiStudioSession).toBe("boolean");
    expect(prov.aiStudioAuthState).toBe("needs_reauth");
    expect(prov.hasAiStudioSession).toBe(false);
    expect(prov).not.toHaveProperty("aiStudioRelayActive");
  });

  test("safeConfigDTO reports syntactically valid saved credentials as checking", () => {
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "abc" }] });
    const dto = safeConfigDTO(cfg()) as any;
    expect(dto.providers["google-aistudio"].hasAiStudioSession).toBe(true);
    expect(dto.providers["google-aistudio"].aiStudioAuthState).toBe("checking");
  });

  test("safeConfigDTO does not treat an invalid apiKey as an AI Studio session", () => {
    const c = cfg();
    c.providers["google-aistudio"]!.apiKey = "not-a-cookie";
    const dto = safeConfigDTO(c) as any;
    expect(dto.providers["google-aistudio"].hasAiStudioSession).toBe(false);
    expect(dto.providers["google-aistudio"].aiStudioAuthState).toBe("needs_reauth");
    expect(JSON.stringify(dto)).not.toContain("not-a-cookie");
  });

  test("POST /api/providers/test for google-aistudio never reports a relay", async () => {
    const c = cfg();
    c.providers["google-aistudio"]!.apiKey = "SAPISID=valid";
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const res = await handleManagementAPI(req, new URL(req.url), c, {});
    const body = await res!.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authState).toBe("checking");
    expect(body.message).not.toContain("relay");
  });

  test("POST /api/providers/test reports missing session when no relay or cookies", async () => {
    const c = cfg();
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const res = await handleManagementAPI(req, new URL(req.url), c, {});
    const body = await res!.json() as any;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("re-authentication required");
  });

  test("POST /api/providers/test reports saved session when cookies valid", async () => {
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    const c = cfg();
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const res = await handleManagementAPI(req, new URL(req.url), c, {});
    const body = await res!.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authState).toBe("checking");
  });

  test("POST /api/aistudio/login/native exists and is not 404", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), { method: "POST" });
      expect([200, 400, 500].includes(res.status)).toBe(true);
      expect(res.status).not.toBe(404);
    } finally { server.stop(true); }
  });

  test("native login does not trust a forged loopback Host on a remote bind", async () => {
    const c = cfg();
    c.hostname = "0.0.0.0";
    c.apiKeys = [{ id: "test-key", name: "test", key: "remote-secret", createdAt: new Date().toISOString() }];
    saveConfig(c);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), {
        method: "POST",
        headers: { Host: "127.0.0.1" },
      });
      expect(res.status).toBe(401);
    } finally { server.stop(true); }
  });

  test("native login rejects a cross-origin request even with valid admission", async () => {
    const c = cfg();
    c.hostname = "0.0.0.0";
    c.apiKeys = [{ id: "test-key", name: "test", key: "remote-secret", createdAt: new Date().toISOString() }];
    saveConfig(c);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), {
        method: "POST",
        headers: {
          Host: "0.0.0.0",
          Origin: "https://attacker.example",
          "X-OpenCodex-API-Key": "remote-secret",
        },
      });
      expect(res.status).toBe(403);
    } finally { server.stop(true); }
  });
});
