import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getConfigPath, mutatePersistedConfig } from "../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

let previousHome: string | undefined;
let home = "";

const richOnDisk = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    "command-code": { adapter: "openai-chat", baseUrl: "https://command.example/v1", apiKey: "command" },
    openai: { adapter: "openai-chat", baseUrl: "https://openai.example/v1", apiKey: "openai" },
    "google-antigravity": {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
    },
    "google-aistudio": { adapter: "openai-chat", baseUrl: "https://aistudio.example/v1", apiKey: "aistudio" },
    "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.example/v1", apiKey: "opencode" },
    cursor: { adapter: "openai-chat", baseUrl: "https://cursor.example/v1", apiKey: "cursor" },
  },
};

const historicalFixture = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: { adapter: "openai-chat", baseUrl: "https://fixture-openai.example/v1", apiKey: "fixture-openai", liveModels: false },
    xai: { adapter: "openai-chat", baseUrl: "https://fixture-xai.example/v1", apiKey: "fixture-xai", liveModels: false },
    "google-antigravity": { adapter: "openai-chat", baseUrl: "https://fixture-antigravity.example/v1", apiKey: "fixture-antigravity", liveModels: false },
    volcengine: { adapter: "openai-chat", baseUrl: "https://fixture-volcengine.example/v1", apiKey: "fixture-volcengine", liveModels: false },
  },
} as OcxConfig;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-management-persistence-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(getConfigPath(), JSON.stringify(richOnDisk, null, 2));
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

async function put(path: string, body: unknown): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), url, structuredClone(historicalFixture), { mutatePersistedConfig });
  if (!response) throw new Error("management route declined request");
  return response;
}

async function request(method: string, path: string, body?: unknown, liveConfig: OcxConfig = structuredClone(historicalFixture)): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const response = await handleManagementAPI(new Request(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }), url, liveConfig, {
    mutatePersistedConfig,
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
  });
  if (!response) throw new Error("management route declined request");
  return response;
}

function persisted(): typeof richOnDisk {
  return JSON.parse(readFileSync(getConfigPath(), "utf8"));
}

test.each([
  ["/api/sidecar-settings", { vision: { enabled: false } }],
  ["/api/claude-code", { enabled: false }],
])("%s cannot replace persisted providers with a fixture", async (path, body) => {
  const before = readFileSync(getConfigPath(), "utf8");
  const response = await put(path, body);
  expect(response.status).toBe(200);
  expect(persisted().defaultProvider).toBe("openai");
  expect(persisted().providers).toEqual(richOnDisk.providers);
  expect(readFileSync(getConfigPath(), "utf8")).not.toBe(before);
});

test("sidecar web-search mutation is field-scoped", async () => {
  const response = await put("/api/sidecar-settings", { webSearch: { streamRoutedModelOutput: true } });
  expect(response.status).toBe(200);
  expect(persisted().providers).toEqual(richOnDisk.providers);
  expect(persisted().defaultProvider).toBe("openai");
  expect(persisted() as OcxConfig).toMatchObject({ webSearchSidecar: { streamRoutedModelOutput: true } });
});

test("provider POST adds one row without replacing the persisted registry", async () => {
  const response = await request("POST", "/api/providers", {
    name: "new-provider",
    provider: {
      adapter: "openai-chat",
      baseUrl: "http://8.8.8.8/v1",
      apiKey: "new-key",
      liveModels: false,
    },
  });
  expect(response.status).toBe(200);
  expect(Object.keys(persisted().providers)).toEqual([...Object.keys(richOnDisk.providers), "new-provider"]);
  expect(persisted().providers["new-provider"]).toMatchObject({ apiKey: "new-key" });
});

test("provider POST reconciles a replacement API key into the inherited pool in one transaction", async () => {
  const config = structuredClone(richOnDisk) as OcxConfig;
  config.providers["command-code"]!.apiKeyPool = [{ id: "old", key: "command" }];
  let committed!: OcxConfig;
  let calls = 0;
  const url = new URL("http://localhost/api/providers");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "command-code",
      provider: {
        adapter: "openai-chat",
        baseUrl: "http://8.8.8.8/v1",
        apiKey: "replacement-key",
        liveModels: false,
      },
    }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      calls++;
      const candidate = structuredClone(config);
      const result = mutate(candidate);
      committed = candidate;
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
  });
  expect(response?.status).toBe(200);
  expect(calls).toBe(1);
  expect(committed.providers["command-code"]?.apiKey).toBe("replacement-key");
  expect(committed.providers["command-code"]?.apiKeyPool?.map(entry => entry.key)).toEqual([
    "command",
    "replacement-key",
  ]);
});

test("provider POST rechecks account namespace collisions inside its transaction", async () => {
  const config = structuredClone(historicalFixture);
  const url = new URL("http://localhost/api/providers");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "late-namespace",
      provider: { adapter: "openai-chat", baseUrl: "http://8.8.8.8/v1", liveModels: false },
    }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      const candidate = structuredClone(config);
      candidate.codexAccountNamespaces = { "late-namespace": "account-id" };
      const result = mutate(candidate);
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
  });
  expect(response?.status).toBe(409);
  expect(config.providers["late-namespace"]).toBeUndefined();
});

test.each([
  [
    "combo",
    { combos: { occupied: { targets: [{ provider: "openai", model: "gpt" }] } } },
    "occupied",
    "configured combo namespace",
  ],
  [
    "routing profile",
    { routingProfiles: { route: { alias: "occupied/model", candidates: [{ provider: "openai", model: "gpt" }] } } },
    "occupied",
    "configured routing profile namespace",
  ],
] as const)("provider POST rejects a %s namespace collision", async (_label, namespace, name, message) => {
  const config = Object.assign(structuredClone(historicalFixture), structuredClone(namespace)) as OcxConfig;
  const url = new URL("http://localhost/api/providers");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      provider: { adapter: "openai-chat", baseUrl: "http://8.8.8.8/v1", liveModels: false },
    }),
  }), url, config);
  expect(response?.status).toBe(409);
  expect(await response?.text()).toContain(message);
  expect(config.providers[name]).toBeUndefined();
});

test("provider API-key POST uses only the injected mutation boundary", async () => {
  const config = structuredClone(richOnDisk) as OcxConfig;
  config.providers["command-code"]!.apiKeyPool = [{ id: "old", key: "command" }];
  const beforeDisk = readFileSync(getConfigPath(), "utf8");
  let calls = 0;
  const url = new URL("http://localhost/api/providers/keys");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "command-code", key: "second-key" }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      calls++;
      const candidate = structuredClone(config);
      const result = mutate(candidate);
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
  });
  expect(response?.status).toBe(201);
  expect(calls).toBe(1);
  expect(config.providers["command-code"]?.apiKey).toBe("second-key");
  expect(config.providers["command-code"]?.apiKeyPool?.map(entry => entry.key)).toEqual(["command", "second-key"]);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
});

test("provider set-default updates only the persisted defaultProvider", async () => {
  const liveConfig = {
    ...structuredClone(historicalFixture),
    providers: {
      openai: historicalFixture.providers.openai,
      "command-code": historicalFixture.providers.openai,
    },
  };
  const response = await request("PATCH", "/api/providers?name=command-code", { setDefault: true }, liveConfig);
  expect(response.status).toBe(200);
  expect(persisted().defaultProvider).toBe("command-code");
  expect(persisted().providers).toEqual(richOnDisk.providers);
});

test("provider PATCH replays onto the persisted row without replacing sibling providers", async () => {
  const liveConfig = {
    ...structuredClone(historicalFixture),
    providers: {
      openai: historicalFixture.providers.openai,
      "command-code": { ...historicalFixture.providers.openai, note: "stale-live" },
    },
  };
  const response = await request("PATCH", "/api/providers?name=command-code", { note: "fresh-note" }, liveConfig);
  expect(response.status).toBe(200);
  expect(persisted().providers["command-code"]).toMatchObject({
    ...richOnDisk.providers["command-code"],
    note: "fresh-note",
  });
  expect(persisted().providers.cursor).toEqual(richOnDisk.providers.cursor);
});

test("provider DELETE removes one row and preserves the rest of the persisted registry", async () => {
  const liveConfig = {
    ...structuredClone(historicalFixture),
    providers: {
      openai: historicalFixture.providers.openai,
      "command-code": historicalFixture.providers.openai,
    },
  };
  const response = await request("DELETE", "/api/providers?name=command-code", undefined, liveConfig);
  expect(response.status).toBe(200);
  const saved = persisted();
  expect(saved.providers["command-code"]).toBeUndefined();
  expect(saved.defaultProvider).toBe("openai");
  expect(saved.providers.cursor).toEqual(richOnDisk.providers.cursor);
  expect(saved.providers["google-aistudio"]).toEqual(richOnDisk.providers["google-aistudio"]);
});

test.each([
  [
    "routing profile",
    { routingProfiles: { balanced: { candidates: [{ provider: "command-code", model: "model-a" }] } } },
    "provider_has_dependent_routing_profiles",
    "routingProfiles",
    ["balanced"],
  ],
  [
    "combo",
    { combos: { fallback: { targets: [{ provider: "command-code", model: "model-a" }] } } },
    "provider_has_dependent_combos",
    "combos",
    ["fallback"],
  ],
  [
    "custom model",
    { customModels: [{ id: "custom-row", provider: "command-code", modelId: "model-a" }] },
    "provider_has_dependent_custom_models",
    "customModels",
    ["custom-row"],
  ],
] as const)("provider DELETE reports its dependent %s without mutating", async (_label, dependency, code, field, ids) => {
  const config = Object.assign(structuredClone(richOnDisk) as OcxConfig, structuredClone(dependency));
  const before = structuredClone(config);
  const url = new URL("http://localhost/api/providers?name=command-code");
  const response = await handleManagementAPI(new Request(url, { method: "DELETE" }), url, config, {
    mutatePersistedConfig: mutate => {
      const candidate = structuredClone(config);
      const result = mutate(candidate);
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
  });
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ code, [field]: ids });
  expect(config).toEqual(before);
});

test("selected-models PUT scopes its provider row mutation to the persisted config", async () => {
  const liveConfig = {
    ...structuredClone(historicalFixture),
    providers: {
      openai: historicalFixture.providers.openai,
      "command-code": { ...historicalFixture.providers.openai, selectedModels: ["stale"] },
    },
  };
  const response = await request("PUT", "/api/selected-models", {
    provider: "command-code",
    models: ["fresh-model"],
  }, liveConfig);
  expect(response.status).toBe(200);
  expect(persisted().providers["command-code"]).toMatchObject({
    ...richOnDisk.providers["command-code"],
    selectedModels: ["fresh-model"],
  });
  expect(persisted().providers.cursor).toEqual(richOnDisk.providers.cursor);
});

test("model preset refuses to commit discovery results after the provider row changes", async () => {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "openrouter",
    providers: {
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "openrouter-key",
        liveModels: false,
        models: ["openai/gpt-5.6"],
      },
    },
  };
  const url = new URL("http://localhost/api/model-presets");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openrouter", mode: "preset" }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      const candidate = structuredClone(config);
      candidate.providers.openrouter!.baseUrl = "https://concurrent.example/v1";
      const result = mutate(candidate);
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
  });
  expect(response?.status).toBe(409);
  expect(config.providers.openrouter?.baseUrl).not.toBe("https://concurrent.example/v1");
});

test("provider alias PUT scopes its provider row mutation to the persisted config", async () => {
  const liveConfig = {
    ...structuredClone(historicalFixture),
    providers: {
      openai: historicalFixture.providers.openai,
      "command-code": { ...historicalFixture.providers.openai, alias: "stale-alias" },
    },
  };
  const response = await request("PUT", "/api/providers/command-code/alias", { alias: "fresh-alias" }, liveConfig);
  expect(response.status).toBe(200);
  expect(persisted().providers["command-code"]).toMatchObject({
    ...richOnDisk.providers["command-code"],
    alias: "fresh-alias",
  });
  expect(persisted().providers.cursor).toEqual(richOnDisk.providers.cursor);
});

test("sidecar retries preserve a concurrent edit to another leaf", async () => {
  const config = { ...structuredClone(historicalFixture), webSearchSidecar: { model: "old", reasoning: "low" as const } };
  let committed!: OcxConfig;
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webSearch: { streamRoutedModelOutput: true } }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      const latest = structuredClone(config);
      latest.webSearchSidecar = { ...latest.webSearchSidecar, reasoning: "high" };
      const result = mutate(latest);
      committed = latest;
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
  });
  expect(response?.status).toBe(200);
  expect(committed.webSearchSidecar).toMatchObject({ model: "old", reasoning: "high", streamRoutedModelOutput: true });
  expect(config.webSearchSidecar).toEqual(committed.webSearchSidecar);
});

test("Claude retries preserve concurrent leaves and adopt the committed subtree", async () => {
  const config = { ...structuredClone(historicalFixture), claudeCode: { enabled: true, blockedSkills: ["old"] } };
  let committed!: OcxConfig;
  const url = new URL("http://localhost/api/claude-code");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  }), url, config, {
    mutatePersistedConfig: mutate => {
      const latest = structuredClone(config);
      latest.claudeCode = { ...latest.claudeCode, blockedSkills: ["concurrent"] };
      const result = mutate(latest);
      committed = latest;
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
  });
  expect(response?.status).toBe(200);
  expect(committed.claudeCode).toMatchObject({ enabled: false, blockedSkills: ["concurrent"] });
  expect(config.claudeCode).toEqual(committed.claudeCode);
});

test("a combined V2 config update performs one persistence transaction", async () => {
  const config = structuredClone(historicalFixture);
  let calls = 0;
  const url = new URL("http://localhost/api/v2");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      multiAgentMode: "default",
      keepNativeChatGptOnV1: true,
      v2RoutedDelegationBridge: true,
    }),
  }), url, config, {
    toggleCodexMultiAgentV2: () => {},
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
    saveConfigPreservingClaudeCode: () => {
      calls++;
      if (calls === 2) throw new Error("second write refused");
    },
    mutatePersistedConfig: mutate => {
      calls++;
      if (calls === 2) throw new Error("second write refused");
      const candidate = structuredClone(config);
      const result = mutate(candidate);
      Object.assign(config, candidate);
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
  });
  expect(response?.status).toBe(200);
  expect(calls).toBe(1);
  expect(config).toMatchObject({ keepNativeChatGptOnV1: true, v2RoutedDelegationBridge: true });
  expect(config.multiAgentMode).toBeUndefined();
});

test("V2 persistence failure happens before toggle and scalar side effects", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-persist-first-"));
  const codexConfig = join(codexHome, "config.toml");
  const before = "[features.multi_agent_v2]\nenabled = false\n";
  writeFileSync(codexConfig, before);
  process.env.CODEX_HOME = codexHome;
  let toggles = 0;
  try {
    const config = structuredClone(historicalFixture);
    const url = new URL("http://localhost/api/v2");
    const response = await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, agentsEnabled: true, v2RoutedDelegationBridge: true }),
    }), url, config, {
      toggleCodexMultiAgentV2: enabled => {
        toggles++;
        writeFileSync(codexConfig, before.replace("false", String(enabled)));
      },
      mutatePersistedConfig: () => { throw new Error("disk unavailable"); },
    });
    expect(response?.status).toBe(500);
    expect(toggles).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(before);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("V2 transition failure rolls back its committed config fields", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-transition-rollback-"));
  writeFileSync(join(codexHome, "config.toml"), "[features.multi_agent_v2]\nenabled = false\n");
  process.env.CODEX_HOME = codexHome;
  const config = structuredClone(historicalFixture);
  let disk = structuredClone(config);
  let mutations = 0;
  try {
    const url = new URL("http://localhost/api/v2");
    const response = await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, v2RoutedDelegationBridge: true }),
    }), url, config, {
      toggleCodexMultiAgentV2: () => {},
      mutatePersistedConfig: mutate => {
        const candidate = structuredClone(disk);
        if (++mutations === 2) candidate.v2RoutedDelegationBridge = false;
        const result = mutate(candidate);
        disk = candidate;
        return { status: result.changed ? "committed" : "unchanged", value: result.value };
      },
    });
    expect(response?.status).toBe(502);
    expect(disk.v2RoutedDelegationBridge).toBe(false);
    expect(config.v2RoutedDelegationBridge).toBe(false);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("V2 reports a failed compensating rollback", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-rollback-failure-"));
  writeFileSync(join(codexHome, "config.toml"), "[features.multi_agent_v2]\nenabled = false\n");
  process.env.CODEX_HOME = codexHome;
  const config = structuredClone(historicalFixture);
  let disk = structuredClone(config);
  let mutations = 0;
  try {
    const url = new URL("http://localhost/api/v2");
    const response = await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, v2RoutedDelegationBridge: true }),
    }), url, config, {
      toggleCodexMultiAgentV2: () => {},
      mutatePersistedConfig: mutate => {
        if (++mutations === 2) throw new Error("rollback disk failure");
        const candidate = structuredClone(disk);
        const result = mutate(candidate);
        disk = candidate;
        return { status: result.changed ? "committed" : "unchanged", value: result.value };
      },
    });
    expect(response?.status).toBe(502);
    expect(await response?.text()).toContain("config rollback failed: Management config persistence failed.");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("V2 scalar failure rolls back its committed config fields", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-scalar-rollback-"));
  process.env.CODEX_HOME = codexHome;
  const config = structuredClone(historicalFixture);
  let disk = structuredClone(config);
  try {
    const url = new URL("http://localhost/api/v2");
    const response = await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentsEnabled: true, v2RoutedDelegationBridge: true }),
    }), url, config, {
      mutatePersistedConfig: mutate => {
        const candidate = structuredClone(disk);
        const result = mutate(candidate);
        disk = candidate;
        return { status: result.changed ? "committed" : "unchanged", value: result.value };
      },
    });
    expect(response?.status).toBe(502);
    expect(disk.v2RoutedDelegationBridge).toBeUndefined();
    expect(config.v2RoutedDelegationBridge).toBeUndefined();
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("V2 retains config when a later scalar fails after external changes landed", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-partial-success-"));
  const codexConfig = join(codexHome, "config.toml");
  writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = false\n");
  process.env.CODEX_HOME = codexHome;
  const config = structuredClone(historicalFixture);
  let disk = structuredClone(config);
  try {
    const url = new URL("http://localhost/api/v2");
    const response = await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, agentsEnabled: true, agentsMaxDepth: 3, v2RoutedDelegationBridge: true }),
    }), url, config, {
      toggleCodexMultiAgentV2: enabled => writeFileSync(codexConfig, `[features.multi_agent_v2]\nenabled = ${enabled}\n`),
      mutatePersistedConfig: mutate => {
        const candidate = structuredClone(disk);
        const result = mutate(candidate);
        disk = candidate;
        return { status: result.changed ? "committed" : "unchanged", value: result.value };
      },
      v2ScalarWriters: {
        setAgentsEnabled: () => ({ ok: true, changed: true }),
        setAgentsMaxDepth: () => ({ ok: false, error: "later scalar refused" }),
      },
    } as unknown as ManagementApiDeps);
    expect(response?.status).toBe(502);
    const text = await response?.text();
    expect(text).toContain("config retained because earlier external side effects were applied: multi_agent_v2, agentsEnabled");
    expect(disk.v2RoutedDelegationBridge).toBe(true);
    expect(config.v2RoutedDelegationBridge).toBe(true);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a direct management mutation without a persistence seam does not touch disk", async () => {
  const before = readFileSync(getConfigPath(), "utf8");
  const config = structuredClone(historicalFixture);
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vision: { enabled: false } }),
  }), url, config);
  if (!response) throw new Error("management route declined request");
  expect(response.status).toBe(500);
  expect(config).toEqual(historicalFixture);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
});

test("a direct V2 bridge mutation without a persistence seam does not touch disk", async () => {
  const before = readFileSync(getConfigPath(), "utf8");
  const config = structuredClone(historicalFixture);
  const url = new URL("http://localhost/api/v2");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v2RoutedDelegationBridge: true }),
  }), url, config);
  if (!response) throw new Error("management route declined request");
  expect(response.status).toBe(500);
  expect(config).toEqual(historicalFixture);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
});

test.each(["GET", "HEAD", "OPTIONS"])("a %s management request needs no persistence seam or cloneable config", async method => {
  const config = {
    ...structuredClone(historicalFixture),
    discoveryStub: () => undefined,
  } as OcxConfig;
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url, { method }), url, config);
  if (method === "GET") expect(response?.status).toBe(200);
  else expect(response).toBeNull();
});

test("a failed management writer restores the live config and leaves disk unchanged", async () => {
  const beforeDisk = readFileSync(getConfigPath(), "utf8");
  const config = structuredClone(historicalFixture);
  const url = new URL("http://localhost/api/shadow-call-settings");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, model: "gpt-5.6-luna" }),
  }), url, config, {
    saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); },
  });
  if (!response) throw new Error("management route declined request");
  expect(response.status).toBe(500);
  expect(config).toEqual(historicalFixture);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
});

test("Claude Desktop PUT lets a persistence failure reach dispatcher rollback", async () => {
  const beforeDisk = readFileSync(getConfigPath(), "utf8");
  const config = structuredClone(historicalFixture);
  const url = new URL("http://localhost/api/claude-desktop");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profile: {
        version: 1,
        assignments: {},
        defaults: { opus: null, fable: null, sonnet: null, haiku: null },
      },
    }),
  }), url, config, {
    saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); },
  });
  if (!response) throw new Error("management route declined request");
  expect(response.status).toBe(500);
  expect(config).toEqual(historicalFixture);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
});

const GLOBAL_MANAGEMENT_WRITERS = [
  "saveConfig",
  "saveConfigPreservingClaudeCode",
  "mutatePersistedConfig",
  "addProviderApiKey",
  "setActiveProviderApiKey",
  "setProviderApiKeyLabel",
  "removeProviderApiKey",
] as const;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importedGlobalWriters(source: string): string[] {
  const clean = withoutComments(source);
  const violations = new Set<string>();
  const authority = String.raw`(?:\.\.?\/)+(?:config|providers\/api-keys)`;
  for (const match of clean.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*["']${authority}["']`, "g"))) {
    for (const part of match[1]!.split(",")) {
      const imported = part.trim().split(/\s+as\s+/)[0];
      if (GLOBAL_MANAGEMENT_WRITERS.includes(imported as typeof GLOBAL_MANAGEMENT_WRITERS[number])) violations.add(imported!);
    }
  }
  for (const match of clean.matchAll(new RegExp(String.raw`(?:import\s*\*\s*as\s+(\w+)\s*from|(?:const|let)\s+(\w+)\s*=\s*await\s+import\()\s*["']${authority}["']`, "g"))) {
    const namespace = match[1] ?? match[2];
    if (!namespace) continue;
    for (const writer of GLOBAL_MANAGEMENT_WRITERS) {
      const access = new RegExp(String.raw`\b${namespace}\s*(?:\.\s*${writer}\b|\[\s*["'\x60]${writer}["'\x60]\s*\])`);
      if (access.test(clean)) violations.add(writer);
    }
  }
  for (const match of clean.matchAll(new RegExp(String.raw`(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']${authority}["']\s*\)`, "g"))) {
    for (const part of match[1]!.split(",")) {
      const imported = part.trim().split(/\s*:\s*/)[0];
      if (GLOBAL_MANAGEMENT_WRITERS.includes(imported as typeof GLOBAL_MANAGEMENT_WRITERS[number])) violations.add(imported!);
    }
  }
  for (const writer of GLOBAL_MANAGEMENT_WRITERS) {
    const directDynamic = new RegExp(String.raw`import\(\s*["']${authority}["']\s*\)[\s\S]{0,80}(?:\.\s*${writer}\b|\[\s*["'\x60]${writer}["'\x60]\s*\])`);
    if (directDynamic.test(clean)) violations.add(writer);
  }
  return [...violations];
}

function localTypeScriptImports(file: string, source: string, managementDir: string): string[] {
  const imports: string[] = [];
  for (const match of withoutComments(source).matchAll(/(?:from\s*|import\(\s*)["'](\.[^"']+)["']/g)) {
    const base = resolve(dirname(file), match[1]!);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (candidate.startsWith(`${managementDir}/`) && existsSync(candidate)) imports.push(candidate);
    }
  }
  return imports;
}

test("management route modules cannot reach global config writers directly or through local helpers", () => {
  const managementDir = join(import.meta.dir, "..", "src/server/management");
  const pending = readdirSync(managementDir)
    .filter(file => file.endsWith(".ts") && file !== "context.ts")
    .map(file => join(managementDir, file));
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file) || file === join(managementDir, "context.ts")) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const writer of importedGlobalWriters(source)) violations.push(`${file}: ${writer}`);
    pending.push(...localTypeScriptImports(file, source, managementDir));
  }
  expect(violations).toEqual([]);
});

test("management writer policy recognizes aliased, namespace, computed, and dynamic access", () => {
  expect(importedGlobalWriters(`import { mutatePersistedConfig as persist } from "../../config"; persist(fn);`))
    .toContain("mutatePersistedConfig");
  expect(importedGlobalWriters(`import * as cfg from "../../config"; cfg["saveConfig"](value);`))
    .toContain("saveConfig");
  expect(importedGlobalWriters(`const apiKeys = await import("../../providers/api-keys"); apiKeys.addProviderApiKey(c, n, k);`))
    .toContain("addProviderApiKey");
  expect(importedGlobalWriters(`const { removeProviderApiKey: remove } = await import("../../providers/api-keys"); remove(c, n, id);`))
    .toContain("removeProviderApiKey");
});
