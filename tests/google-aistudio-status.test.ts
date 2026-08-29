import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeConfigDTO } from "../src/server/auth-cors";
import { handleManagementAPI } from "../src/server/management-api";
import { setAiStudioProbeFetchForTests } from "../src/server/management/provider-routes";
import { saveAiStudioSession } from "../src/oauth/aistudio-session-sync";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { startServer } from "../src/server";

const TEST_DIR = join(tmpdir(), "ocx-aistudio-status-" + Date.now());
const prevHome = process.env.OPENCODEX_HOME;
const REAUTH_ERROR = "Session expired or missing — re-authentication required";

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  setAiStudioProbeFetchForTests(undefined);
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

function mockProbe(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  setAiStudioProbeFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch);
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function probe(config: OcxConfig): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request("http://127.0.0.1/api/providers/test?name=google-aistudio", { method: "POST", headers: { Host: "127.0.0.1" } });
  const res = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe.skipIf(process.platform !== "darwin")("AI Studio status & re-auth", () => {
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

  test("POST /api/providers/test reports missing session when no relay or cookies", async () => {
    const { body } = await probe(cfg());
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("re-authentication required");
  });

  test("POST /api/providers/test live 200 JSON promotes connected and never reports a relay", async () => {
    const calls: string[] = [];
    mockProbe((url) => {
      calls.push(url);
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    });
    const c = cfg();
    c.providers["google-aistudio"]!.apiKey = "SAPISID=valid";
    const { body } = await probe(c);
    expect(body.ok).toBe(true);
    expect(body.authState).toBe("connected");
    expect(String(body.message ?? "")).not.toContain("relay");
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("v1internal:generateContent");
    expect(calls[0]).not.toContain("/v1beta/models");
  });

  test("POST /api/providers/test live probe with saved session cookies reports connected", async () => {
    mockProbe(() => jsonResponse(200, { candidates: [] }));
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    const { body } = await probe(cfg());
    expect(body.ok).toBe(true);
    expect(body.authState).toBe("connected");
  });

  test("POST /api/providers/test HTML or 401/403/redirect requires reauthentication", async () => {
    for (const handler of [
      () => new Response("<!doctype html><html>accounts.google.com/v3/signin</html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => jsonResponse(401, { error: "unauthorized" }),
      () => jsonResponse(403, { error: "forbidden" }),
    ] as Array<() => Response>) {
      mockProbe(handler);
      saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
      const { body } = await probe(cfg());
      expect(body.ok).toBe(false);
      expect(String(body.error)).toContain("re-authentication required");
      expect(body.authState).not.toBe("connected");
    }

    mockProbe(() => new Response(null, { status: 302, headers: { location: "https://accounts.google.com/v3/signin" } }));
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    const redirected = await probe(cfg());
    expect(redirected.body.ok).toBe(false);
    expect(redirected.body.error).toBe("AI Studio connection probe failed");
    expect(redirected.body.authState).not.toBe("connected");
  });

  test("POST /api/providers/test 5xx or network failure is not reauthentication", async () => {
    mockProbe(() => new Response("upstream exploded", { status: 503 }));
    saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    const failed = await probe(cfg());
    expect(failed.body.ok).toBe(false);
    expect(String(failed.body.error)).not.toContain("re-authentication required");

    mockProbe(() => { throw new Error("socket hang up"); });
    const networked = await probe(cfg());
    expect(networked.body.ok).toBe(false);
    expect(String(networked.body.error)).not.toContain("re-authentication required");
  });

  test("POST /api/aistudio/login/native exists and is not 404", async () => {
    const server = startServer(0, { runAiStudioNativeLogin: async () => ({ kind: "unsupported" }) });
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), { method: "POST" });
      expect([200, 400, 500].includes(res.status)).toBe(true);
      expect(res.status).not.toBe(404);
    } finally { server.stop(true); }
  });

  test("native login waits for completion and returns the validated session", async () => {
    cfg();
    const sessionPath = saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    mockProbe(() => jsonResponse(200, { candidates: [] }));
    let resolveLogin!: (result: { kind: "authenticated"; sessionPath: string }) => void;
    const login = new Promise<{ kind: "authenticated"; sessionPath: string }>(resolve => { resolveLogin = resolve; });
    const server = startServer(0, { runAiStudioNativeLogin: async () => login });
    try {
      const responsePromise = fetch(new URL("/api/aistudio/login/native", server.url), { method: "POST" });
      await new Promise(resolve => setTimeout(resolve, 5));
      resolveLogin({ kind: "authenticated", sessionPath });
      const res = await responsePromise;
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally { server.stop(true); }
  });

  test("native login returns 502 when login succeeds but the live probe fails", async () => {
    cfg();
    const sessionPath = saveAiStudioSession({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "valid" }] });
    mockProbe(() => new Response("upstream exploded", { status: 503 }));
    const server = startServer(0, {
      runAiStudioNativeLogin: async () => ({ kind: "authenticated", sessionPath }),
    });
    try {
      const res = await fetch(new URL("/api/aistudio/login/native", server.url), { method: "POST" });
      expect(res.status).toBe(502);
      const body = await res.json() as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(String(body.error)).not.toContain("re-authentication required");
    } finally { server.stop(true); }
  });

  test("native login aborts the injected login when the request is cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    const server = startServer(0, {
      runAiStudioNativeLogin: async ({ signal }) => {
        receivedSignal = signal;
        await new Promise<void>(resolve => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "cancelled" };
      },
    });
    try {
      const controller = new AbortController();
      const responsePromise = fetch(new URL("/api/aistudio/login/native", server.url), {
        method: "POST",
        signal: controller.signal,
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      controller.abort();
      let res: Response | undefined;
      try {
        res = await responsePromise;
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      }
      for (let i = 0; i < 20 && !receivedSignal?.aborted; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(receivedSignal?.aborted).toBe(true);
      if (res) {
        expect(res.status).toBe(499);
        expect((await res.json()).ok).toBe(false);
      }
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
