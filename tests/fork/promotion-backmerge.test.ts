import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helperPath = resolve(import.meta.dir, "../../.github/scripts/fork-promotion-backmerge.cjs");
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string, contents: string): string {
  writeFileSync(join(cwd, "value.txt"), contents);
  git(cwd, "add", "value.txt");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ocx-promotion-backmerge-"));
  roots.push(cwd);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "test");
  git(cwd, "config", "user.email", "test@example.invalid");
  const oldMain = commit(cwd, "old main", "base\n");
  const promotedDev = commit(cwd, "promoted dev", "promoted\n");
  const promotedTree = git(cwd, "rev-parse", `${promotedDev}^{tree}`);
  const main = git(cwd, "commit-tree", promotedTree, "-p", oldMain, "-p", promotedDev, "-m", "promote dev");
  git(cwd, "reset", "--hard", "-q", promotedDev);
  const advancedDev = commit(cwd, "advanced dev", "advanced\n");
  return { cwd, oldMain, promotedDev, main, advancedDev };
}

function reconcile(cwd: string, main: string, dev: string): { action: string; targetSha: string } {
  return JSON.parse(execFileSync("node", [helperPath, main, dev, "--json"], { cwd, encoding: "utf8" }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("promotion backmerge reconciliation", () => {
  test("fast-forwards an unchanged dev and preserves an already-contained main", () => {
    const { cwd, promotedDev, main, advancedDev } = fixture();

    expect(reconcile(cwd, main, promotedDev)).toEqual({ action: "fast-forward", targetSha: main });

    const contained = git(cwd, "commit-tree", git(cwd, "rev-parse", `${advancedDev}^{tree}`), "-p", advancedDev, "-p", main, "-m", "contained");
    expect(reconcile(cwd, main, contained)).toEqual({ action: "unchanged", targetSha: contained });
  });

  test("creates an ancestry-only merge when dev advanced after promotion", () => {
    const { cwd, main, advancedDev } = fixture();
    const result = reconcile(cwd, main, advancedDev);

    expect(result.action).toBe("merged");
    expect(git(cwd, "show", "-s", "--format=%P", result.targetSha)).toBe(`${advancedDev} ${main}`);
    expect(git(cwd, "rev-parse", `${result.targetSha}^{tree}`)).toBe(git(cwd, "rev-parse", `${advancedDev}^{tree}`));
    expect(git(cwd, "merge-base", "--is-ancestor", main, result.targetSha)).toBe("");
  });

  test("fails closed when main is not an identical-tree promotion", () => {
    const { cwd, oldMain, promotedDev, advancedDev } = fixture();
    const changedTree = git(cwd, "rev-parse", `${oldMain}^{tree}`);
    const unsafeMain = git(cwd, "commit-tree", changedTree, "-p", oldMain, "-p", promotedDev, "-m", "unsafe promotion");

    expect(() => reconcile(cwd, unsafeMain, advancedDev)).toThrow();
  });
});
