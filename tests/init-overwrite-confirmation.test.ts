import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideInitOverwrite, parseInitArgs } from "../src/cli/init";
import { getDefaultConfig, initializePersistedConfigIfMissing, setPersistedConfigInitializationBeforePublishForTests } from "../src/config";

describe("ocx init overwrite boundary", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  test("accepts only --yes and rejects unknown arguments", () => {
    expect(parseInitArgs([])).toEqual({ yes: false });
    expect(parseInitArgs(["--yes"])).toEqual({ yes: true });
    expect(parseInitArgs(["--no"])).toEqual({ yes: false, error: "Unknown option: --no. Usage: ocx init [--yes]" });
    expect(parseInitArgs(["provider"])).toEqual({ yes: false, error: "Unknown option: provider. Usage: ocx init [--yes]" });
  });

  test("denies an existing config by default and only replaces after explicit confirmation", () => {
    expect(decideInitOverwrite(true, false, true, "n")).toBe("cancel");
    expect(decideInitOverwrite(true, false, true, "yes")).toBe("replace");
    expect(decideInitOverwrite(true, false, false)).toBe("refuse");
    expect(decideInitOverwrite(true, true, false)).toBe("replace");
  });

  async function runInit(home: string, command: "init" | "setup", args: string[] = []): Promise<{ exit: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src/cli/index.ts"), command, ...args], {
      env: { ...process.env, OPENCODEX_HOME: home, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    const prompts = [["Select default provider", "1\n"], ["Proxy port", "10100\n"], ["Inject into Codex config.toml?", "n\n"], ["Install Codex autostart shim?", "n\n"]] as const;
    let next = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      while (next < prompts.length && stdout.includes(prompts[next]![0])) {
        proc.stdin.write(prompts[next]![1]);
        next++;
      }
    }
    proc.stdin.end();
    return { exit: await proc.exited, stdout, stderr: await new Response(proc.stderr).text() };
  }

  test("noninteractive existing config refuses without mutating bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-existing-")); dirs.push(home);
    const path = join(home, "config.json");
    const bytes = "{\"providers\":{\"openai\":{\"baseUrl\":\"https://example.test\"}}}\n";
    writeFileSync(path, bytes);
    const result = await runInit(home, "init");
    expect(result.exit).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(result.stderr).toContain("ocx init --yes");
  });

  test.each(["valid", "malformed"])("--yes replaces an existing %s config", async kind => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-replace-")); dirs.push(home);
    const path = join(home, "config.json");
    const bytes = kind === "valid" ? JSON.stringify({ providers: { cursor: { baseUrl: "https://old.test" } } }) : "not-json\n";
    writeFileSync(path, bytes);
    const result = await runInit(home, "init", ["--yes"]);
    expect(result.exit).toBe(0);
    expect(readFileSync(path, "utf8")).not.toBe(bytes);
    expect(JSON.parse(readFileSync(path, "utf8")).defaultProvider).toBe("openai");
  });

  test("setup alias inherits --yes and refuses existing config without it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-setup-alias-")); dirs.push(home);
    const path = join(home, "config.json"); const bytes = "sentinel\n"; writeFileSync(path, bytes);
    const result = await runInit(home, "setup");
    expect(result.exit).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("fresh initialization keeps a competing winner", () => {
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

  test("fresh init creates config without --yes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-fresh-")); dirs.push(home);
    const result = await runInit(home, "init");
    expect(result.exit).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultProvider).toBe("openai");
  });
});
