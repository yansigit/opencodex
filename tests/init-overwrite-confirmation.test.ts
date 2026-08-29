import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInitArgs } from "../src/cli/init";

describe("ocx init overwrite boundary", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  test("accepts only --yes and rejects unknown arguments", () => {
    expect(parseInitArgs([])).toEqual({ yes: false });
    expect(parseInitArgs(["--yes"])).toEqual({ yes: true });
    expect(parseInitArgs(["--no"])).toEqual({ yes: false, error: "Unknown option: --no. Usage: ocx init [--yes]" });
    expect(parseInitArgs(["provider"])).toEqual({ yes: false, error: "Unknown option: provider. Usage: ocx init [--yes]" });
  });

  test("noninteractive existing config refuses without mutating bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-existing-")); dirs.push(home);
    const path = join(home, "config.json");
    const bytes = "{\"providers\":{\"openai\":{\"baseUrl\":\"https://example.test\"}}}\n";
    writeFileSync(path, bytes);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src/cli/index.ts"), "init"], {
      env: { ...process.env, OPENCODEX_HOME: home, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdin.end();
    expect(await proc.exited).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(await new Response(proc.stderr).text()).toContain("ocx init --yes");
  });

  test("fresh init creates config without --yes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-fresh-")); dirs.push(home);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src/cli/index.ts"), "init"], {
      env: { ...process.env, OPENCODEX_HOME: home, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    proc.stdin.write("1\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    proc.stdin.write("10100\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    proc.stdin.write("n\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    proc.stdin.write("n\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    proc.stdin.write("n\n"); proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultProvider).toBe("openai");
  });
});
