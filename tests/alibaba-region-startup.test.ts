import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, setPersistedConfigMutationBeforeCommitForTests } from "../src/config";
import { AlibabaBackupIntegrityError } from "../src/providers/alibaba-region-backup";
import { projectAlibabaRegionMigration } from "../src/providers/alibaba-region-migration";
import { runAlibabaRegionStartupMigration } from "../src/providers/alibaba-region-startup";
import type { OcxConfig } from "../src/types";

const INTL_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
});

function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-intl-key", baseUrl: INTL_URL },
    },
  } as unknown as OcxConfig;
}

function collidingConfig(): OcxConfig {
  const config = migratableConfig();
  config.providers["alibaba-token-plan-intl"] = { adapter: "openai-chat", apiKey: "sk-other" } as never;
  return config;
}

function namespaceCollidingConfig(): OcxConfig {
  return {
    ...migratableConfig(),
    codexAccountNamespaces: { "alibaba-token-plan-intl": "pool-a" },
  };
}

test("backs up strictly before saving, exactly once, when the projection changed", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const result = runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { order.push("backup"); },
    save: config => { order.push("save"); saved.push(config); },
  });
  expect(order).toEqual(["backup", "save"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toBe(result);
  expect(result.providers["alibaba-token-plan-intl"]).toBeDefined();
});

test("a no-op never backs up or saves, but a collision still warns", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    runAlibabaRegionStartupMigration(collidingConfig(), {
      project: projectAlibabaRegionMigration,
      backup: () => { order.push("backup"); },
      save: config => { saved.push(config); },
    });
  } finally {
    console.warn = originalWarn;
  }
  expect(order).toEqual([]);
  expect(saved).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("[alibaba-region-migration]");
});

test("an account namespace collision warns without backing up or saving", () => {
  const order: string[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const config = namespaceCollidingConfig();
    const result = runAlibabaRegionStartupMigration(config, {
      project: projectAlibabaRegionMigration,
      backup: () => { order.push("backup"); },
      save: () => { order.push("save"); },
    });
    expect(result).toBe(config);
  } finally {
    console.warn = originalWarn;
  }
  expect(order).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("reserved by a configured Codex account namespace");
});

test("a backup failure prevents the migration from saving", () => {
  // The fail-closed posture: no rollback point, no credential rewrite. The throw
  // propagates out of startServer, the same stance the OpenAI tier migration takes.
  const saved: OcxConfig[] = [];
  expect(() => runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { throw new AlibabaBackupIntegrityError("disk full"); },
    save: config => { saved.push(config); },
  })).toThrow(AlibabaBackupIntegrityError);
  expect(saved).toEqual([]);
});

test("backs up and warns from the rebased Alibaba projection committed to disk", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-alibaba-startup-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  const configPath = getConfigPath();
  const stale = { ...migratableConfig(), port: 10100 };
  const concurrent = { ...migratableConfig(), port: 20200 };
  const concurrentBytes = `${JSON.stringify(concurrent, null, 2)}\n`;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  writeFileSync(configPath, `${JSON.stringify(stale, null, 2)}\n`);
  setPersistedConfigMutationBeforeCommitForTests(() => writeFileSync(configPath, concurrentBytes));
  console.warn = message => { warnings.push(String(message)); };
  try {
    const result = runAlibabaRegionStartupMigration(stale, {
      project: projectAlibabaRegionMigration,
      backup: () => {
        expect(warnings).toEqual([]);
        expect(readFileSync(configPath, "utf8")).toBe(concurrentBytes);
      },
    });

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as OcxConfig;
    expect(result.port).toBe(20200);
    expect(persisted.port).toBe(20200);
    expect(persisted.providers["alibaba-token-plan"]).toBeUndefined();
    expect(persisted.providers["alibaba-token-plan-intl"]).toBeDefined();
    expect(warnings).toHaveLength(1);
  } finally {
    console.warn = originalWarn;
    setPersistedConfigMutationBeforeCommitForTests(null);
    if (existsSync(configPath)) unlinkSync(configPath);
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  }
});
