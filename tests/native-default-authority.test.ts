import { describe, expect, test } from "bun:test";
import { MANAGED_SUBAGENT_DEFAULT_MARKER, resolveNativeDefaultState } from "../src/codex/subagent-defaults";
import { multiAgentGuidanceText } from "../src/server/responses/collaboration";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const config = (overrides: Partial<OcxConfig> = {}): OcxConfig => ({
  port: 10100,
  providers: {},
  defaultProvider: "openai",
  ...overrides,
}) as OcxConfig;

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
      nativeDefaultState: "pending",
    }, {
      collectCatalogState: () => ({ state: "fresh" }),
      resolveEffectiveSubagentRoster: () => ({ candidates: [{ model: "gpt-5.6-sol", efforts: ["high"] }], advertised: [{ model: "gpt-5.6-sol", efforts: ["high"] }], excluded: [] }),
    });
    expect(text).toContain('Preferred sub-agent: model "gpt-5.6-sol"');
    expect(text).toContain("nativeDefaultState: pending");
  });
});
