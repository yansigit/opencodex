import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../scripts/fork/sync/cli";
import { publishSyncBranch } from "../../scripts/fork/sync/publish";
import type { CommandRunner, PrepareResult, SyncEvent } from "../../scripts/fork/sync/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  return stdout.trim();
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-sync-publish-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, work);
  await git(work, "config", "user.name", "Test");
  await git(work, "config", "user.email", "sync-test@example.test");
  writeFileSync(join(work, "base"), "base\n");
  await git(work, "add", "base");
  await git(work, "commit", "-m", "base");
  const base = await git(work, "rev-parse", "HEAD");
  await git(work, "switch", "-c", "dev");
  writeFileSync(join(work, "dev"), "dev\n");
  await git(work, "add", "dev");
  await git(work, "commit", "-m", "dev");
  const devSha = await git(work, "rev-parse", "HEAD");
  await git(work, "switch", "-c", "vendor/main", base);
  writeFileSync(join(work, "vendor"), "vendor\n");
  await git(work, "add", "vendor");
  await git(work, "commit", "-m", "vendor");
  const vendorMainSha = await git(work, "rev-parse", "HEAD");
  const branch = "sync/upstream-v1.2.3-abcdef0";
  await git(work, "switch", "-c", branch, devSha);
  await git(work, "merge", "--no-ff", vendorMainSha, "-m", "sync");
  const localSha = await git(work, "rev-parse", "HEAD");
  const runner: CommandRunner = async args => {
    const process = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const event: SyncEvent = {
    kind: "main-behind",
    upstreamRepo: "upstream",
    latestTag: "v1.2.3",
    latestTagSha: vendorMainSha,
    vendorMainSha,
    vendorDevSha: "unused",
    detectedAt: "2026-08-29T00:00:00.000Z",
  };
  const result: PrepareResult = {
    status: "merged",
    branch,
    resolutions: [],
    unresolved: [],
  };
  return { work, runner, event, result, branch, devSha, vendorMainSha, localSha };
}

describe("fail-closed sync branch publisher", () => {
  test("creates a missing branch without force", async () => {
    const f = await fixture();
    const published = await publishSyncBranch({ ...f, result: { ...f.result, status: "hotspot-handoff" } });

    expect(published).toEqual({
      action: "created",
      branch: f.branch,
      remoteSha: f.localSha,
      containsDev: true,
      containsVendorMain: true,
      handoffRequired: true,
      escalationRequired: false,
    });
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(f.localSha);
  });

  test("recreates a branch that was deleted remotely", async () => {
    const f = await fixture();
    await git(f.work, "push", "origin", `${f.localSha}:refs/heads/${f.branch}`);
    await git(f.work, "push", "origin", `:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({ ...f });

    expect(published.action).toBe("created");
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(f.localSha);
  });

  test("fast-forwards an existing ancestor", async () => {
    const f = await fixture();
    await git(f.work, "push", "origin", `${f.devSha}:refs/heads/${f.branch}`);

    expect(await publishSyncBranch({ ...f })).toMatchObject({
      action: "fast-forwarded",
      remoteSha: f.localSha,
    });
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(f.localSha);
  });

  test("leaves an equal branch unchanged", async () => {
    const f = await fixture();
    await git(f.work, "push", "origin", `${f.localSha}:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({ ...f });

    expect(published.action).toBe("unchanged");
    expect(published.remoteSha).toBe(f.localSha);
    expect(published.handoffRequired).toBe(false);
  });

  test("preserves a resolved remote branch byte-for-byte", async () => {
    const f = await fixture();
    writeFileSync(join(f.work, "resolution"), "agent work\n");
    await git(f.work, "add", "resolution");
    await git(f.work, "commit", "-m", "resolve hotspots");
    const resolvedSha = await git(f.work, "rev-parse", "HEAD");
    await git(f.work, "push", "origin", `${resolvedSha}:refs/heads/${f.branch}`);
    await git(f.work, "reset", "--hard", f.localSha);

    const published = await publishSyncBranch({
      ...f,
      result: { ...f.result, status: "hotspot-handoff" },
    });

    expect(published).toEqual({
      action: "preserved-advanced",
      branch: f.branch,
      remoteSha: resolvedSha,
      containsDev: true,
      containsVendorMain: true,
      handoffRequired: false,
      escalationRequired: false,
    });
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(resolvedSha);
  });

  test("escalates an unchanged unresolved hotspot seed", async () => {
    const f = await fixture();
    await git(f.work, "switch", "dev");
    await git(f.work, "branch", "-f", f.branch, f.devSha);
    await git(f.work, "push", "origin", `${f.devSha}:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({
      ...f,
      result: { ...f.result, status: "hotspot-handoff" },
    });

    expect(published).toMatchObject({
      action: "unchanged",
      remoteSha: f.devSha,
      containsVendorMain: false,
      handoffRequired: false,
      escalationRequired: true,
    });
  });

  test("escalates preserved partial hotspot work", async () => {
    const f = await fixture();
    await git(f.work, "switch", "dev");
    writeFileSync(join(f.work, "partial"), "partial\n");
    await git(f.work, "add", "partial");
    await git(f.work, "commit", "-m", "partial hotspot work");
    const partialSha = await git(f.work, "rev-parse", "HEAD");
    await git(f.work, "push", "origin", `${partialSha}:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({
      ...f,
      result: { ...f.result, status: "hotspot-handoff" },
    });

    expect(published).toMatchObject({
      action: "preserved-diverged",
      remoteSha: partialSha,
      containsVendorMain: false,
      handoffRequired: false,
      escalationRequired: true,
    });
  });

  test("preserves a resolved branch when dev advances", async () => {
    const f = await fixture();
    writeFileSync(join(f.work, "resolution"), "resolved\n");
    await git(f.work, "add", "resolution");
    await git(f.work, "commit", "-m", "resolve hotspots");
    const resolvedSha = await git(f.work, "rev-parse", "HEAD");
    await git(f.work, "push", "origin", `${resolvedSha}:refs/heads/${f.branch}`);
    await git(f.work, "switch", "dev");
    await git(f.work, "branch", "-f", f.branch, f.localSha);
    writeFileSync(join(f.work, "new-dev"), "new dev\n");
    await git(f.work, "add", "new-dev");
    await git(f.work, "commit", "-m", "advance dev");
    const newDevSha = await git(f.work, "rev-parse", "HEAD");

    const published = await publishSyncBranch({
      ...f,
      devSha: newDevSha,
      result: { ...f.result, status: "hotspot-handoff" },
    });

    expect(published).toEqual({
      action: "preserved-advanced",
      branch: f.branch,
      remoteSha: resolvedSha,
      containsDev: false,
      containsVendorMain: true,
      handoffRequired: false,
      escalationRequired: false,
    });
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(resolvedSha);
  });

  test("preserves and escalates a divergent remote branch", async () => {
    const f = await fixture();
    await git(f.work, "switch", "-C", "remote-diverged", f.devSha);
    writeFileSync(join(f.work, "remote-only"), "remote\n");
    await git(f.work, "add", "remote-only");
    await git(f.work, "commit", "-m", "remote work");
    const remoteSha = await git(f.work, "rev-parse", "HEAD");
    await git(f.work, "push", "origin", `${remoteSha}:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({ ...f });

    expect(published.action).toBe("preserved-diverged");
    expect(published.remoteSha).toBe(remoteSha);
    expect(published.escalationRequired).toBe(true);
  });

  test("preserves every existing history-diverged branch", async () => {
    const f = await fixture();
    await git(f.work, "push", "origin", `${f.devSha}:refs/heads/${f.branch}`);

    const published = await publishSyncBranch({
      ...f,
      result: { ...f.result, status: "history-diverged" },
    });

    expect(published.action).toBe("preserved-diverged");
    expect(published.remoteSha).toBe(f.devSha);
    expect(published.handoffRequired).toBe(false);
    expect(published.escalationRequired).toBe(true);
  });

  test("fails closed when the remote advances during publication", async () => {
    const f = await fixture();
    await git(f.work, "push", "origin", `${f.devSha}:refs/heads/${f.branch}`);
    let racedSha = "";
    const racingRunner: CommandRunner = async args => {
      if (args[0] === "push" && !racedSha) {
        const tree = await git(f.work, "rev-parse", `${f.devSha}^{tree}`);
        racedSha = await git(
          f.work,
          "-c",
          "user.name=Race",
          "-c",
          "user.email=sync-race@example.test",
          "commit-tree",
          tree,
          "-p",
          f.devSha,
          "-m",
          "racing update",
        );
        await git(f.work, "push", "origin", `${racedSha}:refs/heads/${f.branch}`);
      }
      return f.runner(args);
    };

    await expect(publishSyncBranch({ ...f, runner: racingRunner })).rejects.toThrow("rejected");
    expect(await git(f.work, "ls-remote", "origin", `refs/heads/${f.branch}`)).toContain(racedSha);
  });

  test("exposes publish through the internal CLI", async () => {
    const f = await fixture();
    const output: string[] = [];

    await runCli(["publish"], {
      runner: f.runner,
      stdin: JSON.stringify({ event: f.event, result: f.result, devSha: f.devSha }),
      write: value => output.push(value),
    });

    expect(JSON.parse(output[0]!)).toMatchObject({ action: "created", branch: f.branch });
  });
});
