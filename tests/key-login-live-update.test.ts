import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig, setPersistedConfigInitializationBeforePublishForTests, writePid, writeRuntimePort } from "../src/config";
import { commitKeyLoginProvider, providerConfigFromKeyLoginProvider } from "../src/oauth/login-cli";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { startServer } from "../src/server";
import { createLocalAttestationSecret } from "../src/lib/local-management-attestation";
import { LOCAL_PROVIDER_RELOAD_TIMEOUT_MS } from "../src/server/local-provider-reload-client";
import type { OcxConfig } from "../src/types";
import { refreshUserCostOverlays } from "../src/usage/user-cost-overlays";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch as fetch } from "./helpers/management-auth";
import { watchdogMs } from "./helpers/ci-watchdog";

const LIVE_UPDATE_TIMEOUT_MS = watchdogMs(LOCAL_PROVIDER_RELOAD_TIMEOUT_MS * 2 + 5_000);

/**
 * Regression: `ocx login <key-provider>` used to POST the unmerged preset row
 * into a running proxy. The proxy then saved the replacement without the
 * preserved modelCosts overlay, undoing the just-written disk state until a
 * restart (the live row had no existingCosts to carry forward).
 */
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function umansKeyConfig(port = 0): OcxConfig {
  return {
    port,
    hostname: "127.0.0.1",
    defaultProvider: "umans",
    providers: {
      umans: {
        adapter: "anthropic",
        baseUrl: "https://api.code.umans.ai",
        apiKey: "sk-old",
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-key-login-live-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-key-login-live-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(umansKeyConfig());
});

afterEach(() => {
  setPersistedConfigInitializationBeforePublishForTests(null);
  // The overlay registry is module-level; reset it so rows added through the
  // live provider update path cannot leak into later tests in a shared run.
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("CLI key-login live-update overlay preservation", () => {
  test("fresh key and AI Studio logins initialize a missing config without losing OpenAI", async () => {
    for (const [name, provider] of [
      ["umans", providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-fresh")],
      ["google-aistudio", {
        adapter: "google",
        authMode: "local",
        googleMode: "ai-studio-web",
        baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
      }],
    ] as const) {
      if (existsSync(getConfigPath())) unlinkSync(getConfigPath());
      const config = loadConfig();
      await commitKeyLoginProvider(config, name, provider as OcxConfig["providers"][string]);
      const disk = loadConfig();
      expect(disk.defaultProvider).toBe("openai");
      expect(disk.providers.openai).toBeDefined();
      expect(disk.providers[name]).toBeDefined();
    }
  });

  test("fresh key login retries a lost initialization race and rejects the winner's namespace collision", async () => {
    unlinkSync(getConfigPath());
    const config = loadConfig();
    const winner = structuredClone(config);
    winner.codexAccountNamespaces = { umans: "pool-a" };
    const winnerBytes = `${JSON.stringify(winner, null, 2)}\n`;
    setPersistedConfigInitializationBeforePublishForTests(() => {
      writeFileSync(getConfigPath(), winnerBytes, { flag: "wx", mode: 0o600 });
    });

    await expect(commitKeyLoginProvider(
      config,
      "umans",
      providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-fresh"),
    )).rejects.toThrow("must not collide with a configured Codex account namespace");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(winnerBytes);
  });

  test("key-login commit updates one provider without replacing sibling providers on disk", async () => {
    const richConfig = umansKeyConfig();
    richConfig.providers.extra = {
      adapter: "openai-chat",
      baseUrl: "https://extra.example/v1",
      apiKey: "extra-key",
    };
    writeFileSync(join(testDir, "config.json"), `${JSON.stringify(richConfig, null, 2)}\n`);

    const staleConfig = umansKeyConfig();
    const replacement = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-rotated");
    await commitKeyLoginProvider(staleConfig, "umans", replacement);

    const disk = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as OcxConfig;
    expect(disk.providers.umans!.apiKey).toBe("sk-rotated");
    expect(disk.providers.extra).toEqual(richConfig.providers.extra);
  });

  test("key rotation preserves the complete operator-owned provider state and alternate keys", async () => {
    const richConfig = umansKeyConfig();
    Object.assign(richConfig.providers.umans!, {
      disabled: true,
      apiKeyPool: [{ id: "legacy-key", key: "sk-old", label: "fallback" }],
      modelAliases: { "umans-coder": "daily" },
      selectedModels: ["umans-coder"],
      modelPreset: { mode: "custom" },
      requestPacing: { enabled: true, requestsPerMinute: 12 },
      contextWindow: 123_456,
      modelCosts: { "umans-coder": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
    });
    writeFileSync(getConfigPath(), `${JSON.stringify(richConfig, null, 2)}\n`);

    const live = structuredClone(richConfig);
    const merged = await commitKeyLoginProvider(
      live,
      "umans",
      providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-rotated"),
    );
    expect(merged).toMatchObject({
      disabled: true,
      apiKey: "sk-rotated",
      modelAliases: { "umans-coder": "daily" },
      selectedModels: ["umans-coder"],
      modelPreset: { mode: "custom" },
      requestPacing: { enabled: true, requestsPerMinute: 12 },
      contextWindow: 123_456,
    });
    expect(merged.apiKeyPool?.map(entry => entry.key)).toEqual(["sk-old", "sk-rotated"]);
    expect(loadConfig().providers.umans).toEqual(merged);
  });

  test("notify after key login pushes the merged row and keeps modelCosts on live and disk", async () => {
    const localAttestationSecret = createLocalAttestationSecret();
    const server = startServer(0, { localAttestationSecret });
    try {
      const port = server.port!;
      writeRuntimePort({
        pid: process.pid,
        port,
        hostname: "127.0.0.1",
        attestationSecret: localAttestationSecret,
      });
      writePid(process.pid);
      const boot = loadConfig();
      boot.port = port;
      saveConfig(boot);

      // The proxy booted before the overlay existed; a hand-edit then adds
      // modelCosts before the key-login commit.
      const edited = loadConfig();
      edited.providers.umans!.modelCosts = {
        "umans-coder": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      };
      saveConfig(edited);

      const config = edited;
      const replacement = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-rotated");
      const merged = await commitKeyLoginProvider(config, "umans", replacement);
      expect(merged.modelCosts).toEqual(edited.providers.umans!.modelCosts);

      // Reload treats disk as authoritative and never re-saves it.
      const disk = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as OcxConfig;
      expect(disk.providers.umans!.modelCosts).toEqual(edited.providers.umans!.modelCosts);
      expect(disk.providers.umans!.apiKey).toBe("sk-rotated");

      // The running proxy must also carry the overlay in its live config:
      // A silent early return or failed reload would leave the in-memory DTO stale
      // even though disk is correct.
      const live = (await fetch(new URL("/api/config", server.url)).then(r => r.json())) as {
        providers: Record<string, { modelCosts?: Record<string, unknown> }>;
      };
      expect(live.providers.umans?.modelCosts).toEqual(edited.providers.umans!.modelCosts);
    } finally {
      await server.stop(true);
    }
  }, LIVE_UPDATE_TIMEOUT_MS);
});
