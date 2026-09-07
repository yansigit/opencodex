import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];
const scanner = repoPath("scripts/privacy-scan.ts");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-privacy-scan-"));
  roots.push(root);
  const result = Bun.spawnSync(["git", "init", "-b", "dev"], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("repository privacy scanner", () => {
  test("scans untracked files before they are committed", () => {
    const root = makeRepository();
    const address = ["private.person", "company.invalid"].join("@");
    writeFileSync(join(root, "new-note.md"), `contact: ${address}\n`);

    const result = Bun.spawnSync([process.execPath, scanner], { cwd: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("new-note.md:1 email");
  });

  test("does not scan ignored scratch files", () => {
    const root = makeRepository();
    const address = ["private.person", "company.invalid"].join("@");
    writeFileSync(join(root, ".gitignore"), ".tmp/\n");
    writeFileSync(join(root, "README.md"), "public\n");
    mkdirSync(join(root, ".tmp"));
    writeFileSync(join(root, ".tmp", "private.md"), address);

    const result = Bun.spawnSync([process.execPath, scanner], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Privacy scan passed");
  });

  test("scans staged files before they are committed", () => {
    const root = makeRepository();
    const address = ["private.person", "company.invalid"].join("@");
    writeFileSync(join(root, "staged-note.md"), `contact: ${address}\n`);
    git(root, "add", "staged-note.md");

    const result = Bun.spawnSync([process.execPath, scanner], { cwd: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("staged-note.md:1 email");
  });
});
