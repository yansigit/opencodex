import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectLatestVTag } from "../../scripts/fork/sync/detect";
import { pinVendorRefs } from "../../scripts/fork/sync/pin";
import type { CommandRunner } from "../../scripts/fork/sync/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
}

describe("fork sync vendor publication", () => {
  test("initializes missing refs from the stable tag instead of unreleased upstream main", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-vendor-init-"));
    temporaryDirectories.push(root);
    const upstream = join(root, "upstream.git");
    const work = join(root, "work");
    git(root, "init", "--bare", upstream);
    git(root, "init", work);
    git(work, "config", "user.name", "Sync Test");
    git(work, "config", "user.email", "sync-test@example.test");
    git(work, "remote", "add", "upstream", upstream);

    writeFileSync(join(work, "state.txt"), "stable\n");
    git(work, "add", "state.txt");
    git(work, "commit", "-m", "stable");
    const stable = git(work, "rev-parse", "HEAD");
    git(work, "tag", "v1.0.0");
    writeFileSync(join(work, "state.txt"), "unreleased\n");
    git(work, "commit", "-am", "unreleased main");
    const unreleased = git(work, "rev-parse", "HEAD");
    git(work, "branch", "-M", "main");
    git(work, "switch", "-c", "dev");
    writeFileSync(join(work, "dev.txt"), "dev\n");
    git(work, "add", "dev.txt");
    git(work, "commit", "-m", "dev snapshot");
    const dev = git(work, "rev-parse", "HEAD");
    git(work, "push", "upstream", "main", "dev", "--tags");
    git(work, "fetch", "upstream", "main", "dev", "--tags");

    const runner: CommandRunner = async args => {
      const result = Bun.spawnSync(["git", ...args], { cwd: work });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const detected = await detectLatestVTag({ upstreamRepo: upstream, runner });
    const pinned = await pinVendorRefs(detected, { runner });

    expect(detected).toMatchObject({ kind: "pin-updated" });
    expect(pinned.kind).toBe("pin-updated");
    expect(pinned.vendorMainSha).toBe(stable);
    expect(pinned.vendorMainSha).not.toBe(unreleased);
    expect(pinned.vendorDevSha).toBe(dev);
    expect(git(work, "rev-parse", "vendor/main")).toBe(stable);
  });

  test("an incompatible vendor ref prevents either remote ref from moving", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-vendor-atomic-"));
    temporaryDirectories.push(root);
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    git(root, "init", "--bare", origin);
    git(root, "init", work);
    git(work, "config", "user.name", "Sync Test");
    git(work, "config", "user.email", "sync-test@example.test");
    git(work, "remote", "add", "origin", origin);

    writeFileSync(join(work, "state.txt"), "base\n");
    git(work, "add", "state.txt");
    git(work, "commit", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "branch", "vendor/main", base);
    git(work, "branch", "vendor/dev", base);
    git(
      work,
      "push",
      "origin",
      "refs/heads/vendor/main:refs/heads/vendor/main",
      "refs/heads/vendor/dev:refs/heads/vendor/dev",
    );

    writeFileSync(join(work, "state.txt"), "next\n");
    git(work, "add", "state.txt");
    git(work, "commit", "-m", "next");
    git(work, "branch", "-f", "vendor/main", "HEAD");
    const tree = git(work, "rev-parse", "HEAD^{tree}");
    const rewrittenDev = git(work, "commit-tree", tree, "-m", "rewritten dev");
    git(work, "branch", "-f", "vendor/dev", rewrittenDev);

    const workflow = readFileSync(resolve(
      import.meta.dir,
      "../../.github/workflows/fork-upstream-sync.yml",
    ), "utf8");
    const command = workflow.match(
      /^\s*if ! (git push --atomic origin refs\/heads\/vendor\/main:refs\/heads\/vendor\/main refs\/heads\/vendor\/dev:refs\/heads\/vendor\/dev); then$/m,
    )?.[1];
    expect(command).toBeDefined();

    const push = Bun.spawnSync(["sh", "-c", command!], { cwd: work });
    expect(push.exitCode).not.toBe(0);
    expect(git(origin, "rev-parse", "refs/heads/vendor/main")).toBe(base);
    expect(git(origin, "rev-parse", "refs/heads/vendor/dev")).toBe(base);
  });
});
