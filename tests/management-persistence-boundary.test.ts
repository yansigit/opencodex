import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "google-antigravity": { adapter: "openai-chat", baseUrl: "https://antigravity.example/v1", apiKey: "antigravity" },
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

test("management route modules do not import global config writers", async () => {
  const dir = join(import.meta.dir, "..", "src/server/management");
  const files = readdirSync(dir).filter(file => file.endsWith(".ts") && file !== "context.ts");
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    expect(source).not.toMatch(/(?:saveConfigPreservingClaudeCode|mutatePersistedConfig)[\s\S]{0,120}from "\.\.\/\.\.\/config"/);
    expect(source).not.toMatch(/await import\("\.\.\/\.\.\/config"\)[\s\S]{0,120}(?:saveConfigPreservingClaudeCode|mutatePersistedConfig)/);
  }
});
