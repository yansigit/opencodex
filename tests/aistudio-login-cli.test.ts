import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  parseSessionBundle,
  saveAiStudioSessionFromToken,
  serializeSessionBundle,
} from "../src/oauth/aistudio-session-sync";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

describe("google-aistudio provider registration & instructions", () => {
  test("registry entry has clear label, description, and dashboard instructions", () => {
    const entry = getProviderRegistryEntry("google-aistudio");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Google AI Studio (Web)");
    expect(entry?.googleMode).toBe("ai-studio-web");
    expect(entry?.note).toContain("/aistudio/bridge");
    expect(entry?.baseUrl).toBe("https://alkalimakersuite-pa.clients6.google.com");
    expect(entry?.authKind).toBe("local");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.defaultModel).toBe("gemini-3.7-flash");
    expect(entry?.models).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.5-flash",
    ]);
    expect(entry?.requestPacing).toEqual({
      enabled: true,
      requestsPerMinute: 8,
      minIntervalMs: 7500,
      jitterMs: 1500,
    });
    expect(entry?.extraMetadataAliases).toContain("aistudio");
    expect(entry?.extraMetadataAliases).toContain("gemini-aistudio");
  });

  test("validates base64 session bundle exchange", () => {
    const sample = {
      selectedProject: "gen-lang-test-001",
      windowId: "win-test",
      cookies: [{ name: "SAPISID", value: "sapisid_token" }],
    };
    const encoded = serializeSessionBundle(sample);
    const decoded = parseSessionBundle(encoded);
    expect(decoded.selectedProject).toBe("gen-lang-test-001");
    expect(decoded.cookies[0]?.name).toBe("SAPISID");
  });

  test("round-trips full session bundle with domain, path, and windowId", () => {
    const fullSession = {
      selectedProject: "project-xyz-999",
      windowId: "window-abc-123",
      cookies: [
        { name: "SAPISID", value: "sapisid_val_1", domain: ".google.com", path: "/" },
        { name: "__Secure-1PSID", value: "psid_val_2", domain: ".google.com", path: "/" },
        { name: "SSID", value: "ssid_val_3", domain: ".google.com", path: "/aistudio" },
      ],
    };
    const token = serializeSessionBundle(fullSession);
    expect(token.length).toBeGreaterThan(20);

    const tempDest = join(mkdtempSync(join(tmpdir(), "cli-token-")), "session.json");
    const saved = saveAiStudioSessionFromToken(token, tempDest);
    expect(existsSync(saved)).toBe(true);

    const parsed = JSON.parse(readFileSync(saved, "utf-8"));
    expect(parsed.selectedProject).toBe("project-xyz-999");
    expect(parsed.windowId).toBe("window-abc-123");
    expect(parsed.cookies.length).toBe(3);
    expect(parsed.cookies[2].path).toBe("/aistudio");
  });
});

describe("handleAiStudioBridgeLogin does not pop bridge page after native or token login", () => {
  let previousHome: string | undefined;
  let tempHome: string;
  let openUrlMod: typeof import("../src/lib/open-url");
  let proxyLivenessMod: typeof import("../src/server/proxy-liveness");
  let configMod: typeof import("../src/config");

  beforeEach(async () => {
    previousHome = process.env.OPENCODEX_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "ocx-aistudio-cli-"));
    process.env.OPENCODEX_HOME = tempHome;
    openUrlMod = await import("../src/lib/open-url");
    proxyLivenessMod = await import("../src/server/proxy-liveness");
    configMod = await import("../src/config");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  async function runWithChoice(choice: string, opts: { platform?: string } = {}): Promise<string[]> {
    const opened: string[] = [];
    const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation((url: string) => { opened.push(url); });
    const findSpy = spyOn(proxyLivenessMod, "findLiveProxy").mockResolvedValue(null as any);
    const loadSpy = spyOn(configMod, "loadConfig").mockReturnValue({ providers: {} } as any);
    const saveSpy = spyOn(configMod, "saveConfig").mockImplementation(() => {});
    const rlClose = () => {};
    const rlMock = { close: rlClose } as any;
    const createSpy = spyOn(readline, "createInterface").mockReturnValue({
      question: (_prompt: string, cb: (ans: string) => void) => cb(choice),
      close: rlClose,
    } as any);
    const bunSpy = spyOn(Bun as any, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as any);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let platformSpy: ReturnType<typeof spyOn> | null = null;
    if (opts.platform !== undefined) {
      // process.platform is read-only on some runtimes; redefine via getter
      const original = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
        platformSpy = { mockRestore: () => { if (original) Object.defineProperty(process, "platform", original); } } as any;
      } catch { platformSpy = null; }
    }
    try {
      const { handleLogin } = await import("../src/oauth/login-cli");
      await handleLogin("google-aistudio");
    } finally {
      openSpy.mockRestore();
      findSpy.mockRestore();
      loadSpy.mockRestore();
      saveSpy.mockRestore();
      createSpy.mockRestore();
      bunSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      platformSpy?.mockRestore();
    }
    return opened;
  }

  test("token paste does NOT open bridge URL", async () => {
    const token = serializeSessionBundle({
      selectedProject: "proj-token-1",
      windowId: "win-token-1",
      cookies: [{ name: "SAPISID", value: "tok" }],
    });
    expect(token.length).toBeGreaterThan(20);
    const opened = await runWithChoice(token);
    const bridgeOpens = opened.filter(u => u.includes("/aistudio/bridge"));
    expect(bridgeOpens).toEqual([]);
  });

  test("native WebKit login (empty choice on darwin) does NOT open bridge URL", async () => {
    const opened = await runWithChoice("", { platform: "darwin" });
    const bridgeOpens = opened.filter(u => u.includes("/aistudio/bridge"));
    expect(bridgeOpens).toEqual([]);
  });

  test("bridge fallback (non-darwin empty choice) DOES open bridge URL", async () => {
    const opened = await runWithChoice("", { platform: "linux" });
    const bridgeOpens = opened.filter(u => u.includes("/aistudio/bridge"));
    expect(bridgeOpens.length).toBe(1);
  });
});
