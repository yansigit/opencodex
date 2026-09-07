import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];
const checker = repoPath("scripts/check-hygiene.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

describe("local hygiene checker", () => {
  test("scans the contents of untracked files", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-hygiene-untracked-"));
    roots.push(root);
    git(root, "init", "-b", "dev");
    writeFileSync(join(root, "README.md"), "baseline\n");
    git(root, "add", "README.md");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "baseline");

    writeFileSync(
      join(root, "new-tool.ts"),
      "try { throw new Error('boom'); } cat" + "ch {}\n",
    );

    const result = Bun.spawnSync([process.execPath, checker], { cwd: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("empty_catch");
    expect(result.stderr.toString()).toContain("new-tool.ts");
  });

  test("evaluates the working tree instead of a stale committed branch snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-hygiene-worktree-"));
    roots.push(root);
    git(root, "init", "-b", "dev");
    writeFileSync(join(root, "README.md"), "baseline\n");
    git(root, "add", "README.md");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "baseline");
    git(root, "switch", "-c", "feature");
    writeFileSync(join(root, "tool.ts"), "try { work(); } cat" + "ch {}\n");
    git(root, "add", "tool.ts");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "add tool");

    writeFileSync(join(root, "tool.ts"), "try { work(); } catch (error) { throw error; }\n");

    const result = Bun.spawnSync([process.execPath, checker], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("check:hygiene — ok");
  });
});
