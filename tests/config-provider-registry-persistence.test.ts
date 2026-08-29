import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicWriteResidualTempError, getConfigPath, getDefaultConfig, initializePersistedConfigIfMissing, mutatePersistedConfig, PersistedConfigInitializationCleanupError, PersistedConfigInitializationRollbackError, saveConfig, setPersistedConfigInitializationBeforePublishForTests, setPersistedConfigMutationBeforeCommitForTests, type PersistedConfigInitializationIO } from "../src/config";
import { handleConfigCommand } from "../src/cli/config-command";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let home = "";
let previousHome: string | undefined;

function provider(name: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: `http://127.0.0.1:1/${name}`,
    apiKey: `${name}-key`,
    allowPrivateNetwork: true,
    ...extra,
  };
}

function sixProviderConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "zeta",
    providers: {
      alpha: provider("alpha"),
      beta: provider("beta"),
      gamma: provider("gamma"),
      delta: provider("delta"),
      epsilon: provider("epsilon"),
      zeta: provider("zeta"),
    },
  };
}

function diskConfig(): OcxConfig {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
}

function writeDiskConfig(config: OcxConfig): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

function failingInitializationIO(failures: { harden?: number; tempUnlink?: number; targetUnlink?: number } = {}) {
  const calls: string[] = [];
  const fail = (key: keyof typeof failures): boolean => {
    const remaining = failures[key] ?? 0;
    if (remaining === 0) return false;
    failures[key] = remaining - 1;
    return true;
  };
  const io: PersistedConfigInitializationIO = {
    createExclusive(path) { calls.push(`create:${path}`); writeFileSync(path, "", { flag: "wx", mode: 0o600 }); },
    write(path, bytes) { calls.push(`write:${path}`); writeFileSync(path, bytes); },
    harden(path) {
      calls.push(`harden:${path}`);
      if (fail("harden")) throw new Error("harden failed");
      chmodSync(path, 0o600);
    },
    publishNoReplace(temp, target) { calls.push(`publish:${target}`); linkSync(temp, target); },
    truncate(path) { calls.push(`truncate:${path}`); truncateSync(path, 0); },
    unlink(path) {
      calls.push(`unlink:${path}`);
      const target = path === getConfigPath();
      if (fail(target ? "targetUnlink" : "tempUnlink")) throw new Error(`${target ? "target" : "temp"} unlink failed`);
      unlinkSync(path);
    },
  };
  return { calls, io };
}

function initializationTemps(): string[] {
  return readdirSync(home).filter(name => name.includes("config.json.ocx.") && name.endsWith(".tmp"));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-provider-registry-persistence-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  setPersistedConfigInitializationBeforePublishForTests(null);
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("a provider delta preserves concurrent unrelated provider and custom-model edits", () => {
  writeDiskConfig(sixProviderConfig());
  setPersistedConfigMutationBeforeCommitForTests(() => {
    const concurrent = diskConfig();
    concurrent.providers.theta = provider("theta");
    concurrent.customModels = [{
      id: "concurrent-theta-model",
      provider: "theta",
      modelId: "theta-model",
      addedAt: "2026-08-29T00:00:00.000Z",
    }];
    writeDiskConfig(concurrent);
  });

  expect(mutatePersistedConfig(config => {
    config.providers.alpha!.disabled = true;
    return { changed: true, value: undefined };
  })).toEqual({ status: "committed", value: undefined });
  expect(diskConfig().providers.alpha?.disabled).toBe(true);
  expect(diskConfig().providers.theta).toEqual(provider("theta"));
  expect(diskConfig().customModels).toEqual([{
    id: "concurrent-theta-model",
    provider: "theta",
    modelId: "theta-model",
    addedAt: "2026-08-29T00:00:00.000Z",
  }]);
});

test("whole saves preserve a valid persisted provider registry and default provider", () => {
  const persisted = sixProviderConfig();
  const candidates: Array<[string, OcxConfig]> = [
    ["two providers", { port: 10200, defaultProvider: "alpha", providers: { alpha: provider("replacement-alpha"), beta: provider("replacement-beta") } }],
    ["one provider", { port: 10201, defaultProvider: "alpha", providers: { alpha: provider("replacement-alpha") } }],
    ["no providers", { port: 10202, defaultProvider: "openai", providers: {} }],
    ["a stale overlap", { port: 10203, defaultProvider: "alpha", providers: { alpha: provider("stale-alpha"), omega: provider("omega") } }],
    ["reordered providers", { port: 10204, defaultProvider: "beta", providers: { zeta: provider("reordered-zeta"), alpha: provider("reordered-alpha") } }],
    ["a disabled provider", { port: 10205, defaultProvider: "alpha", providers: { alpha: provider("disabled-alpha", { disabled: true }) } }],
  ];

  for (const [, candidate] of candidates) {
    writeDiskConfig(persisted);
    saveConfig(candidate);
    expect(diskConfig().providers).toEqual(persisted.providers);
    expect(diskConfig().defaultProvider).toBe("zeta");
  }
});

test("whole saves refuse to replace an invalid existing config", () => {
  mkdirSync(home, { recursive: true });
  const invalid = "{ definitely not json";
  writeFileSync(getConfigPath(), invalid);

  expect(() => saveConfig({ port: 10210, defaultProvider: "openai", providers: {} })).toThrow();
  expect(readFileSync(getConfigPath(), "utf8")).toBe(invalid);
});

test("whole saves refuse to replace a schema-invalid JSON config", () => {
  mkdirSync(home, { recursive: true });
  const invalid = JSON.stringify({ port: "not-a-port", providers: {} });
  writeFileSync(getConfigPath(), invalid);

  expect(() => saveConfig({ port: 10210, defaultProvider: "openai", providers: {} })).toThrow();
  expect(readFileSync(getConfigPath(), "utf8")).toBe(invalid);
});

test("initialization creates only a missing config", () => {
  const initial = sixProviderConfig();
  expect(initializePersistedConfigIfMissing(initial)).toBe("created");
  expect(diskConfig()).toEqual(initial);

  const bytes = readFileSync(getConfigPath(), "utf8");
  expect(initializePersistedConfigIfMissing(getDefaultConfig())).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
});

test("initialization preserves invalid existing bytes", () => {
  mkdirSync(home, { recursive: true });
  const invalid = "{ definitely not json";
  writeFileSync(getConfigPath(), invalid);

  expect(initializePersistedConfigIfMissing(getDefaultConfig())).toBe("invalid");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(invalid);
});

test("initialization never replaces a config created immediately before publication", () => {
  const competing = sixProviderConfig();
  competing.port = 10999;
  const competingBytes = JSON.stringify(competing, null, 2) + "\n";
  setPersistedConfigInitializationBeforePublishForTests(() => {
    writeFileSync(getConfigPath(), competingBytes, { flag: "wx", mode: 0o600 });
  });

  expect(initializePersistedConfigIfMissing(getDefaultConfig())).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(competingBytes);
});

test("initialization reports a scrubbed residual when pre-publication cleanup cannot unlink", () => {
  const state = failingInitializationIO({ harden: 1, tempUnlink: 2 });
  expect(() => initializePersistedConfigIfMissing(getDefaultConfig(), state.io)).toThrow(AtomicWriteResidualTempError);
  expect(existsSync(getConfigPath())).toBe(false);
  const [temp] = initializationTemps();
  expect(temp).toBeDefined();
  expect(readFileSync(join(home, temp!), "utf8")).toBe("");
});

test("initialization preserves an EEXIST winner when loser cleanup cannot unlink", () => {
  const competingBytes = JSON.stringify(sixProviderConfig(), null, 2) + "\n";
  const state = failingInitializationIO({ tempUnlink: 2 });
  setPersistedConfigInitializationBeforePublishForTests(() => {
    writeFileSync(getConfigPath(), competingBytes, { flag: "wx", mode: 0o600 });
  });

  expect(() => initializePersistedConfigIfMissing(getDefaultConfig(), state.io)).toThrow(AtomicWriteResidualTempError);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(competingBytes);
  const [temp] = initializationTemps();
  expect(readFileSync(join(home, temp!), "utf8")).toBe("");
});

test("initialization rolls back publication before scrubbing after unlink failure", () => {
  const state = failingInitializationIO({ tempUnlink: 2 });
  expect(() => initializePersistedConfigIfMissing(getDefaultConfig(), state.io))
    .toThrow(PersistedConfigInitializationCleanupError);
  expect(existsSync(getConfigPath())).toBe(false);
  expect(initializationTemps()).toEqual([]);
  const rollback = state.calls.indexOf(`unlink:${getConfigPath()}`);
  const scrub = state.calls.findIndex(call => call.startsWith("truncate:"));
  expect(rollback).toBeGreaterThan(-1);
  expect(scrub).toBeGreaterThan(rollback);
});

test("initialization rollback failure preserves both complete hardened links", () => {
  const state = failingInitializationIO({ tempUnlink: 2, targetUnlink: 1 });
  expect(() => initializePersistedConfigIfMissing(getDefaultConfig(), state.io))
    .toThrow(PersistedConfigInitializationRollbackError);
  const expected = JSON.stringify(getDefaultConfig(), null, 2) + "\n";
  expect(readFileSync(getConfigPath(), "utf8")).toBe(expected);
  const [temp] = initializationTemps();
  expect(readFileSync(join(home, temp!), "utf8")).toBe(expected);
  expect(state.calls.some(call => call.startsWith("truncate:"))).toBe(false);
});

test("config import with --yes replaces the provider registry", async () => {
  writeDiskConfig(sixProviderConfig());
  const imported = {
    port: 10212,
    defaultProvider: "imported",
    providers: { imported: provider("imported") },
  };
  const source = join(home, "import.json");
  writeFileSync(source, JSON.stringify(imported));

  expect(await handleConfigCommand(["import", source, "--yes", "--json"])).toBe(0);
  expect(diskConfig().providers).toEqual(imported.providers);
  expect(diskConfig().defaultProvider).toBe("imported");
});

test("config import with --yes replaces an invalid existing config", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(getConfigPath(), "{ invalid existing config");
  const imported = {
    port: 10213,
    defaultProvider: "imported",
    providers: { imported: provider("imported") },
  };
  const source = join(home, "invalid-recovery-import.json");
  writeFileSync(source, JSON.stringify(imported));

  expect(await handleConfigCommand(["import", source, "--yes", "--json"])).toBe(0);
  expect(diskConfig()).toMatchObject(imported);
});

test("whole saves create the default OpenAI config when no config exists", () => {
  saveConfig(getDefaultConfig());

  expect(existsSync(getConfigPath())).toBe(true);
  expect(diskConfig().providers).toEqual(getDefaultConfig().providers);
  expect(diskConfig().defaultProvider).toBe("openai");
});
