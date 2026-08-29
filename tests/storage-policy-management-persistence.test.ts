import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, mutatePersistedConfig } from "../src/config";
import { handleLogsUsageRoutes } from "../src/server/management/logs-usage-routes";
import { MissingManagementPersistenceError, type ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

let previousHome: string | undefined;
let home = "";

const providerRows = {
  openai: { adapter: "openai-chat", baseUrl: "https://openai.example/v1", apiKey: "current-openai" },
  cursor: { adapter: "openai-chat", baseUrl: "https://cursor.example/v1", apiKey: "current-cursor" },
} as const;

function config(policy: OcxConfig["storageCleanupPolicy"]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: structuredClone(providerRows),
    storageCleanupPolicy: policy,
  } as OcxConfig;
}

function context(live: OcxConfig, deps: ManagementContext["deps"]): ManagementContext {
  const url = new URL("http://localhost/api/storage/cleanup-policy");
  return {
    req: new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "permanent" }),
    }),
    url,
    config: live,
    deps,
    convergeCodexCatalog: async () => ({ kind: "catalog-only", catalogRefresh: { status: "unchanged" } }),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-storage-policy-persistence-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("storage policy PUT without persistence authority fails closed", async () => {
  const live = config(undefined);
  const before = JSON.stringify(config(undefined), null, 2);
  writeFileSync(getConfigPath(), before);

  await expect(handleLogsUsageRoutes(context(live, {}))).rejects.toBeInstanceOf(MissingManagementPersistenceError);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  expect(live.storageCleanupPolicy).toBeUndefined();
});

test("storage policy PUT rebases on disk and adopts only the committed policy", async () => {
  const persistedPolicy = {
    enabled: true,
    trigger: { archivedBytesOver: 4096 },
    target: { removeOldestPercent: 10 },
    schedule: "manual" as const,
    mode: "quarantine" as const,
    lastRun: { at: 123, freedBytes: 456, removed: 7 },
  };
  const live = config(undefined);
  writeFileSync(getConfigPath(), JSON.stringify(config(persistedPolicy), null, 2));

  const response = await handleLogsUsageRoutes(context(live, { mutatePersistedConfig }));
  expect(response?.status).toBe(200);

  const disk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
  expect(disk.providers).toEqual(providerRows);
  expect(disk.defaultProvider).toBe("openai");
  expect(disk.storageCleanupPolicy).toEqual({ ...persistedPolicy, mode: "permanent" });
  expect(live.storageCleanupPolicy).toEqual(disk.storageCleanupPolicy);
});
