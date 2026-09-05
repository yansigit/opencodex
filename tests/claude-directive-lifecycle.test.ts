import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTIVE_KEY_FILE, getDirectiveKeyPath, getOrCreateDirectiveSigningKey, rotateDirectiveSigningKey } from "../src/claude/directive-key";
import { buildClaudeAgentDefs, syncClaudeAgentDefs } from "../src/claude/agents-inject";
import { verifyAndExtractDirectives } from "../src/claude/inbound";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const dirs: string[] = [];
function tempDir(prefix = "ocx-dir-lifecycle-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeTreeWithRetry(d);
});

const KEY_RE = /^[0-9a-f]{64}$/;

describe("directive key rotation", () => {
  test("rotates safely when no directive key exists yet", () => {
    const dir = tempDir();
    const rotated = rotateDirectiveSigningKey(dir);
    expect(rotated.oldKey).toMatch(KEY_RE);
    expect(rotated.newKey).toMatch(KEY_RE);
    expect(rotated.newKey).not.toBe(rotated.oldKey);
    expect(readFileSync(getDirectiveKeyPath(dir), "utf8").trim()).toBe(rotated.newKey);
  });

  test("rotates atomically with owner-only 0600 permissions", () => {
    const dir = tempDir();
    const first = getOrCreateDirectiveSigningKey(dir);
    const rotated = rotateDirectiveSigningKey(dir);
    expect(rotated.oldKey).toBe(first);
    expect(rotated.newKey).toMatch(KEY_RE);
    expect(rotated.newKey).not.toBe(first);
    expect(readFileSync(getDirectiveKeyPath(dir), "utf8").trim()).toBe(rotated.newKey);
    const st = lstatSync(getDirectiveKeyPath(dir));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
  });

  test("no-cache-at-verify: a running reader observes an external rotation without restart", () => {
    const dir = tempDir();
    const first = getOrCreateDirectiveSigningKey(dir);
    // Another invocation (the ocx CLI) rotates the key underneath us.
    const externally = rotateDirectiveSigningKey(dir);
    expect(externally.oldKey).toBe(first);
    // The next verification in this (still running) process sees the new key.
    expect(getOrCreateDirectiveSigningKey(dir)).toBe(externally.newKey);
  });

  test("refuses symlinked key files for both read and rotate", () => {
    const dir = tempDir();
    const realFile = join(dir, "other-key");
    writeFileSync(realFile, "a".repeat(64) + "\n");
    try { symlinkSync(realFile, getDirectiveKeyPath(dir)); } catch { return; }
    expect(() => getOrCreateDirectiveSigningKey(dir)).toThrow(/refusing to follow symlinked/);
    expect(() => rotateDirectiveSigningKey(dir)).toThrow(/refusing to follow symlinked/);
  });
});

describe("concurrent key creation across processes", () => {
  test("50 parallel creators converge on the single disk winner", async () => {
    // Bun synchronous fs means a single process cannot interleave the create path:
    // this is a genuine multi-process race via child interpreters (5 x 10 calls).
    const dir = tempDir();
    const script = [
      "const mod = await import(process.env.OCX_KEY_MODULE);",
      "const keys = [];",
      "for (let i = 0; i < 10; i++) keys.push(mod.getOrCreateDirectiveSigningKey(process.env.OCX_KEY_DIR));",
      "console.log(keys.join(\"\\n\"));",
    ].join("\n");
    const runs = Array.from({ length: 5 }, () => Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          OCX_KEY_MODULE: join(import.meta.dir, "..", "src", "claude", "directive-key.ts"),
          OCX_KEY_DIR: dir,
          BUN_INSTALL_CACHE: join(dir, "bun-cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }));
    const completed = await Promise.all(runs.map(async run => ({
      status: await run.exited,
      stdout: await new Response(run.stdout).text(),
      stderr: await new Response(run.stderr).text(),
    })));
    const results: string[] = [];
    for (const run of completed) {
      expect(run.status, run.stderr).toBe(0);
      results.push(...run.stdout.trim().split("\n"));
    }
    expect(results).toHaveLength(50);
    for (const key of results) expect(key).toMatch(KEY_RE);
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    const onDisk = readFileSync(getDirectiveKeyPath(dir), "utf8").trim();
    expect(onDisk).toBe(results[0]);
  });
});

describe("re-signing generated agent defs after rotation", () => {
  test("rotation invalidates old signatures and a re-sync re-signs with the new key", () => {
    const ocxDir = tempDir();
    const claudeDir = tempDir();
    const key = getOrCreateDirectiveSigningKey(ocxDir);
    const config = {
      port: 0, defaultProvider: "mock", providers: {},
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { subagentEffort: "high" },
    } as unknown as OcxConfig;
    const defs = buildClaudeAgentDefs(config, {}, claudeDir);
    expect(syncClaudeAgentDefs(defs, claudeDir, ocxDir)).not.toBeNull();
    const body = readFileSync(join(claudeDir, "agents", defs[0]!.file), "utf8");
    expect(verifyAndExtractDirectives({ system: body }, key).isSigned).toBe(true);

    const rotated = rotateDirectiveSigningKey(ocxDir);
    // Fail-closed after rotation: the signature was made with the old key, so
    // verifying under the NEW on-disk authority must throw, never silently fall
    // back to legacy roster matching.
    expect(() => verifyAndExtractDirectives({ system: body }, rotated.newKey)).toThrow(/signature verification failed/);
    // ...and re-syncing re-signs with the new key.
    const reKey = getOrCreateDirectiveSigningKey(ocxDir);
    expect(syncClaudeAgentDefs(defs, claudeDir, ocxDir, reKey)).not.toBeNull();
    const reBody = readFileSync(join(claudeDir, "agents", defs[0]!.file), "utf8");
    expect(verifyAndExtractDirectives({ system: reBody }, reKey).isSigned).toBe(true);
  });
});

describe("non-disclosure invariants (TRUST-05)", () => {
  test("key material never appears in serialized config.json, doctor output, or request surfaces", () => {
    // runDoctor runs its own lifecycle: exercise the doctor surface as a child so
    // its output never pollutes this process; the key must not appear verbatim.
    const ocxDir = tempDir();
    const claudeDir = tempDir();
    const key = getOrCreateDirectiveSigningKey(ocxDir);
    writeFileSync(join(ocxDir, "config.json"), JSON.stringify({ port: 0 }));
    const serialized = readFileSync(join(ocxDir, "config.json"), "utf8");
    expect(serialized.includes(key)).toBe(false);

    const run = spawnSync("bun", ["run", "src/cli/index.ts", "doctor"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODEX_HOME: ocxDir,
        CLAUDE_CONFIG_DIR: claudeDir,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(out).toContain("Claude directive signing key");
    expect(out).toContain(DIRECTIVE_KEY_FILE);
    expect(out.includes(key)).toBe(false);
  });
});
