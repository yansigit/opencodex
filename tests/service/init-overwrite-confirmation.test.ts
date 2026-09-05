import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfig, initializePersistedConfigIfMissing, setPersistedConfigInitializationBeforePublishForTests } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runCli(home: string, args: string[], input = "1\n10100\nn\nn\n") {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home, HOME: home },
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("ocx init overwrite confirmation", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) removeTreeWithRetry(dirs.pop()!); });

  test("unknown options fail before prompting or writing", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-unknown-")); dirs.push(home);
    const result = runCli(home, ["init", "--no"]) ;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option: --no");
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("--yes creates a fresh config", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-fresh-")); dirs.push(home);
    const result = runCli(home, ["init", "--yes"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultProvider).toBe("openai");
    expect(result.stdout).toContain("Setup complete!");
  });

  test("--yes replaces existing bytes and runs post-publication flow", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-replace-")); dirs.push(home);
    const path = join(home, "config.json");
    writeFileSync(path, "sentinel\n");
    const result = runCli(home, ["init", "--yes"]);
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).not.toBe("sentinel\n");
    expect(result.stdout).toContain("Config saved");
    expect(result.stdout).toContain("Setup complete!");
  });

  test("existing config refuses in noninteractive mode without changing bytes", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-refuse-")); dirs.push(home);
    const path = join(home, "config.json");
    const bytes = "operator-owned\n";
    writeFileSync(path, bytes);
    const result = runCli(home, ["init"] , "");
    expect(result.status).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(result.stderr).toContain("ocx init --yes");
  });

  test("setup alias has the same refusal contract", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-setup-refuse-")); dirs.push(home);
    const path = join(home, "config.json");
    writeFileSync(path, "sentinel\n");
    const result = runCli(home, ["setup"], "");
    expect(result.status).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("sentinel\n");
  });

  test("TTY confirmation reader is closed before setup prompts are created", () => {
    const source = readFileSync(join(repoRoot, "src", "cli", "init.ts"), "utf8");
    const confirmation = source.indexOf("interactiveConfirm({");
    const promptCreation = source.indexOf("prompt = createPrompt();");
    expect(confirmation).toBeGreaterThan(-1);
    expect(promptCreation).toBeGreaterThan(confirmation);
  });

  test("competing creator wins the no-replace publication race", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-race-")); dirs.push(home);
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const winner = JSON.stringify({ ...getDefaultConfig(), providers: { cursor: { adapter: "openai-chat", baseUrl: "https://winner.test" } }, defaultProvider: "cursor" });
    try {
      setPersistedConfigInitializationBeforePublishForTests(() => writeFileSync(join(home, "config.json"), winner));
      expect(initializePersistedConfigIfMissing(getDefaultConfig())).toBe("exists");
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(winner);
    } finally {
      setPersistedConfigInitializationBeforePublishForTests(null);
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
  });
});
