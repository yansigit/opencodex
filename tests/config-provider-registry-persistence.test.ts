import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, mutatePersistedConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../src/config";
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

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-provider-registry-persistence-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
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
