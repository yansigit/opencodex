import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_SUBAGENT_DEFAULT_MARKER, resolveNativeDefaultState } from "../src/codex/subagent-defaults";
import { multiAgentGuidanceText } from "../src/server/responses/collaboration";
import { handleResponses } from "../src/server/responses/core";
import { collectCodexAppServerCatalogState, resetCodexAppServerCatalogStateCache } from "../src/codex/app-server-processes";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const config = (overrides: Partial<OcxConfig> = {}): OcxConfig => ({
  port: 10100,
  providers: {},
  defaultProvider: "openai",
  ...overrides,
}) as OcxConfig;

const originalFetch = globalThis.fetch;
const originalCatalogStateOverride = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
afterEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => {
  if (originalCatalogStateOverride === undefined) delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = originalCatalogStateOverride;
  resetCodexAppServerCatalogStateCache();
});

const managed = (model = "gpt-5.6-sol", effort = "high"): string =>
  `[agents]\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\ndefault_subagent_model = "${model}"\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\ndefault_subagent_reasoning_effort = "${effort}"\n`;

describe("native default authority", () => {
  test("reports all four states from marker ownership and app-server freshness", async () => {
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol" }), {
      readConfig: () => managed(),
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("disabled");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => managed("other/model"),
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("pending");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => managed(),
      collectCatalogState: async () => ({ state: "stale" }),
    })).toBe("pending");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => managed(),
      collectCatalogState: async () => ({ state: "unknown" }),
    })).toBe("pending");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => `[agents]\ndefault_subagent_model = "user/model"\n`,
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("blocked");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EACCES"; throw error; },
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("blocked");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => `model_provider = "other"\n${managed()}`,
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("blocked");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true }), {
      readConfig: () => `profile = "work"\n[profiles.work]\nmodel_provider = "other"\n${managed()}`,
      collectCatalogState: async () => ({ state: "not_running" }),
    })).toBe("blocked");
    expect(await resolveNativeDefaultState(config({ injectionModel: "gpt-5.6-sol", injectionEffort: "high", syncCodexSubagentDefaults: true }), {
      readConfig: () => managed(),
      collectCatalogState: async () => ({ state: "fresh" }),
    })).toBe("active");
  });

  test("GET exposes nativeDefaultState while PUT response stays unchanged", async () => {
    const current = config({ injectionModel: "gpt-5.6-sol", syncCodexSubagentDefaults: true });
    const response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model", { method: "PUT", body: JSON.stringify({ model: "gpt-5.6-sol" }) }),
      new URL("http://localhost/api/injection-model"), current,
    );
    expect(await response!.json()).toEqual({
      ok: true, multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: true,
      model: "gpt-5.6-sol", effort: null, prompt: null,
    });
    const get = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), current,
    );
    expect((await get!.json()) as Record<string, unknown>).toHaveProperty("nativeDefaultState");
  });

  test("fresh V2 guidance states native default authority beside its preferred model", async () => {
    const parsed = {
      context: { tools: [
        { name: "spawn_agent" }, { name: "send_message" },
      ] },
      options: { reasoning: "max" },
    } as any;
    const text = await multiAgentGuidanceText(parsed, {
      injectionModel: "gpt-5.6-sol",
      syncCodexSubagentDefaults: true,
    }, {
      collectCatalogState: () => ({ state: "fresh" }),
      resolveNativeDefaultState: received => {
        expect(received.syncCodexSubagentDefaults).toBe(true);
        return "active";
      },
      resolveEffectiveSubagentRoster: () => ({ candidates: [{ model: "gpt-5.6-sol", efforts: ["high"] }], advertised: [{ model: "gpt-5.6-sol", efforts: ["high"] }], excluded: [] }),
    });
    expect(text).toContain('Preferred sub-agent: model "gpt-5.6-sol"');
    expect(text).toContain("nativeDefaultState: active");
  });

  test("Responses core passes native sync state into production V2 guidance", async () => {
    process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const current = config({
      defaultProvider: "gw",
      multiAgentMode: "v2",
      multiAgentGuidanceEnabled: true,
      injectionModel: "gw/model",
      syncCodexSubagentDefaults: true,
      injectionPrompt: "authority={{nativeDefaultState}}",
      providers: {
        gw: { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKey: "test-key" },
      },
    });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gw/model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] }],
        tools: [
          { type: "function", name: "spawn_agent", parameters: { type: "object" } },
          { type: "function", name: "send_message", parameters: { type: "object" } },
        ],
      }),
    }), current, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(upstreamBody)).toContain("authority=pending");
    expect(JSON.stringify(upstreamBody)).not.toContain("authority=disabled");
  });

  test("native authority uses config.toml freshness even when catalog freshness would pass", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "ocx-native-authority-"));
    const configPath = join(configDir, "config.toml");
    try {
      writeFileSync(configPath, managed(), "utf8");
      // The app-server started before this config-only native-default write.
      utimesSync(configPath, 2, 2);
      const state = await resolveNativeDefaultState(config({
        injectionModel: "gpt-5.6-sol",
        injectionEffort: "high",
        syncCodexSubagentDefaults: true,
      }), {
        configPath,
        processIo: {
          listSnapshots: () => [{ pid: 42, commandLine: "/usr/local/bin/codex app-server" }],
          readStartMs: () => 1,
          // The direct collector target regression below covers target selection;
          // this seam keeps the resolver test isolated from the user's config.
          catalogMtimeMs: () => statSync(configPath).mtimeMs,
          now: () => 3_000,
        },
      });
      expect(state).toBe("pending");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("alternating catalog/config freshness reuses process evidence but returns target-correct states", () => {
    let enumerations = 0;
    let starts = 0;
    let targetMtime = 2_000;
    const listSnapshots = () => {
      enumerations += 1;
      return [{ pid: 42, commandLine: "/usr/local/bin/codex app-server" }];
    };
    const readStartMs = () => {
      starts += 1;
      return 1_000;
    };
    const catalogMtimeMs = () => targetMtime;
    const base = { listSnapshots, readStartMs, catalogMtimeMs, now: () => 3_000 };
    expect(collectCodexAppServerCatalogState({ ...base, freshnessTarget: "catalog" }).state).toBe("stale");
    targetMtime = 500;
    expect(collectCodexAppServerCatalogState({ ...base, freshnessTarget: "config" }).state).toBe("fresh");
    expect(enumerations).toBe(1);
    expect(starts).toBe(1);
  });
});
