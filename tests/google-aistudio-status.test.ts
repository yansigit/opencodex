import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeConfigDTO } from "../src/server/auth-cors";
import { handleManagementAPI } from "../src/server/management-api";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";
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
  globalAiStudioRelayHub.reset();
});

afterEach(() => {
  globalAiStudioRelayHub.reset();
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function cfg(overrides: Record<string, unknown> = {}): OcxConfig {
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
    ...overrides,
  } as OcxConfig;
  saveConfig(c);
  return c;
}

describe("Task 5: live AI Studio status & re-auth", () => {
  test("safeConfigDTO exposes auth state and retains hasAiStudioSession without relay state", () => {
    const dto = safeConfigDTO(cfg()) as any;
    const prov = dto.providers["google-aistudio"];
    expect(typeof prov.hasAiStudioSession).toBe("boolean");
    expect(prov.hasAiStudioSession).toBe(false);
    expect(prov.aiStudioAuthState).toBe(process.platform === "darwin" ? "needs_reauth" : "unsupported");
    expect(prov.aiStudioRelayActive).toBeUndefined();
  });

  test("safeConfigDTO reflects a valid saved session as checking", () => {
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "abc" }] });
    globalAiStudioRelayHub.registerSession("s1", { send() {}, close() {} } as any);
    const dto = safeConfigDTO(cfg()) as any;
    expect(dto.providers["google-aistudio"].hasAiStudioSession).toBe(true);
    expect(dto.providers["google-aistudio"].aiStudioAuthState).toBe(process.platform === "darwin" ? "checking" : "unsupported");
    expect(dto.providers["google-aistudio"].aiStudioRelayActive).toBeUndefined();
  });

  test("POST /api/providers/test never reports a relay", async () => {
    globalAiStudioRelayHub.registerSession("s1", { send() {}, close() {} } as any);
    const c = cfg();
    c.providers["google-aistudio"]!.apiKey = "SAPISID=probe-sapisid";
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const res = await handleManagementAPI(req, new URL(req.url), c, {});
    const body = await res!.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authState).toBe(process.platform === "darwin" ? "checking" : "unsupported");
    expect(body.message).not.toContain("relay");
  });

  test("POST /api/providers/test rejects arbitrary apiKey values", async () => {
    const c = cfg({ providers: {
      "google-aistudio": { ...(cfg().providers["google-aistudio"]!), apiKey: "arbitrary-api-key" },
    } });
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const body = await (await handleManagementAPI(req, new URL(req.url), c, {}))!.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("re-authentication required");
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
    c.providers["google-aistudio"]!.apiKey = "SAPISID=valid";
    const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
    const res = await handleManagementAPI(req, new URL(req.url), c, {});
    const body = await res!.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authState).toBe(process.platform === "darwin" ? "checking" : "unsupported");
  });

  test("POST /api/aistudio/login/native exists and is not 404", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), { method: "POST" });
      expect([200, 400, 500].includes(res.status)).toBe(true);
      expect(res.status).not.toBe(404);
    } finally { server.stop(true); }
  });
});
