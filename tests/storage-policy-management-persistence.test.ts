import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, mutatePersistedConfig } from "../src/config";
import { handleLogsUsageRoutes } from "../src/server/management/logs-usage-routes";
import { MissingManagementPersistenceError, type ManagementContext } from "../src/server/management/context";
import { computeNextRun, normalizeStorageCleanupPolicy, runStorageCleanupPolicy, setStorageCleanupPolicyLiveSink } from "../src/storage/policy";
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
  setStorageCleanupPolicyLiveSink(null);
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

test("policy completion mutates only run metadata on the locked latest policy", () => {
  const codexHome = join(home, "codex");
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
  writeFileSync(join(codexHome, "archived_sessions", "old.jsonl"), "old");
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)");
  db.exec("INSERT INTO threads VALUES ('old', 'archived_sessions/old.jsonl', 1)");
  db.close();

  const initial = config(normalizeStorageCleanupPolicy({
    enabled: true,
    trigger: { archivedBytesOver: 0 },
    target: { removeOldestPercent: 100 },
    schedule: "manual",
    mode: "quarantine",
  }));
  writeFileSync(getConfigPath(), JSON.stringify(initial, null, 2));

  const now = 77_000;
  let reads = 0;
  let adopted: OcxConfig["storageCleanupPolicy"];
  setStorageCleanupPolicyLiveSink(policy => { adopted = policy; });
  const result = runStorageCleanupPolicy({
    reason: "manual",
    force: true,
    now,
    codexHome,
    loadPolicy: () => {
      const snapshot = (JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig).storageCleanupPolicy!;
      reads += 1;
      return snapshot;
    },
    execute: options => {
      mutatePersistedConfig(fresh => {
        fresh.hostname = "concurrent-host";
        fresh.providers.cursor!.disabled = true;
        fresh.storageCleanupPolicy = normalizeStorageCleanupPolicy({
          enabled: false,
          trigger: { archivedBytesOver: 999 },
          target: { reduceToBytes: 42 },
          schedule: "daily",
          mode: "permanent",
        });
        return { changed: true, value: undefined };
      });
      return {
        ok: true,
        mode: options.mode,
        percent: options.percent,
        count: 1,
        bytes: 3,
        removedPaths: ["archived_sessions/old.jsonl"],
      };
    },
  });

  const disk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
  expect(disk.hostname).toBe("concurrent-host");
  expect(disk.providers.cursor?.disabled).toBe(true);
  expect(disk.storageCleanupPolicy).toEqual({
    enabled: false,
    trigger: { archivedBytesOver: 999 },
    target: { reduceToBytes: 42 },
    schedule: "daily",
    mode: "permanent",
    lastRun: { at: now, freedBytes: 3, removed: 1 },
    nextRun: computeNextRun("daily", now),
  });
  expect(result.policy).toEqual(disk.storageCleanupPolicy);
  expect(adopted).toEqual(disk.storageCleanupPolicy);
  expect(reads).toBe(1);
});
