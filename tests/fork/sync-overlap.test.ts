import { describe, expect, test } from "bun:test";
import { analyzeOverlap, preservationReportHash } from "../../scripts/fork/sync/overlap";
import { runCli } from "../../scripts/fork/sync/cli";
import { loadRegistry } from "../../scripts/fork/sync/preservation";
import type { CommandResult, CommandRunner } from "../../scripts/fork/sync/types";

function mockRunner(map: Record<string, CommandResult>): CommandRunner {
  return async args => {
    const key = args.join(" ");
    if (key in map) return map[key];
    // handle ls-tree with --
    if (args[0] === "ls-tree") {
      const commit = args[1] as string;
      const path = args[args.length - 1] as string;
      const k2 = `ls-tree ${commit} ${path}`;
      if (k2 in map) return map[k2];
      const k3 = `ls-tree ${commit} -- ${path}`;
      if (k3 in map) return map[k3];
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("overlap analyzer", () => {
  test("requires unique merge base", async () => {
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base1\nbase2\n", stderr: "" },
    });
    await expect(analyzeOverlap({ runner, base: "base1", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" })).rejects.toThrow(/unique merge-base/);
  });
  test("detects silent overwrite candidate via blob IDs", async () => {
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base fork --": { exitCode: 0, stdout: "M\tsrc/config.ts\n", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base upstream --": { exitCode: 0, stdout: "", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base merge --": { exitCode: 0, stdout: "", stderr: "" },
      "ls-tree base src/config.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree fork src/config.ts": { exitCode: 0, stdout: "100644 blob forkBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree upstream src/config.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree merge src/config.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree dev src/config.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/config.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.candidates.length).toBe(1);
    expect(report.candidates[0]?.path).toBe("src/config.ts");
    expect(report.candidates.some(candidate => candidate.classification === "exact-upstream-blob")).toBe(true);
    expect(report.status).toBe("passed");
  });
  test("is clean when no candidates", async () => {
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base fork --": { exitCode: 0, stdout: "", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base upstream --": { exitCode: 0, stdout: "", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base merge --": { exitCode: 0, stdout: "", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.status).toBe("passed");
    expect(report.candidates).toEqual([]);
  });
  test("rename-aware: tracks renameFrom", async () => {
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base fork --": { exitCode: 0, stdout: "R100\tsrc/old.ts\tsrc/new.ts\n", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base upstream --": { exitCode: 0, stdout: "", stderr: "" },
      "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT base merge --": { exitCode: 0, stdout: "", stderr: "" },
      "ls-tree base src/old.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/old.ts\n", stderr: "" },
      "ls-tree fork src/new.ts": { exitCode: 0, stdout: "100644 blob forkBlob\tsrc/new.ts\n", stderr: "" },
      "ls-tree upstream src/new.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/new.ts\n", stderr: "" },
      "ls-tree merge src/new.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/new.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.candidates[0]?.renameFrom).toBe("src/old.ts");
  });

  test("partial-hunk overlap without a decision fails closed", async () => {
    const diffs = "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT";
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      [`${diffs} base fork --`]: { exitCode: 0, stdout: "M\tsrc/unregistered-overlap.ts\n", stderr: "" },
      [`${diffs} base upstream --`]: { exitCode: 0, stdout: "M\tsrc/unregistered-overlap.ts\n", stderr: "" },
      [`${diffs} base merge --`]: { exitCode: 0, stdout: "M\tsrc/unregistered-overlap.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.status).toBe("decision-required");
    expect(report.candidates).toContainEqual(expect.objectContaining({
      path: "src/unregistered-overlap.ts",
      classification: "overlapping-logical-path",
    }));
  });

  test("detects a fork path deleted from the result", async () => {
    const diffs = "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT";
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      [`${diffs} base fork --`]: { exitCode: 0, stdout: "M\tsrc/fork-only.ts\n", stderr: "" },
      [`${diffs} base upstream --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} base merge --`]: { exitCode: 0, stdout: "D\tsrc/fork-only.ts\n", stderr: "" },
      "ls-tree fork src/fork-only.ts": { exitCode: 0, stdout: "100644 blob forkBlob\tsrc/fork-only.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.status).toBe("decision-required");
    expect(report.candidates).toContainEqual(expect.objectContaining({ classification: "fork-path-deleted-in-result" }));
  });

  test("detects a preservation-registry path changed from dev", async () => {
    const diffs = "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT";
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      [`${diffs} base fork --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} base upstream --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} base merge --`]: { exitCode: 0, stdout: "", stderr: "" },
      "ls-tree dev src/config.ts": { exitCode: 0, stdout: "100644 blob devBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree merge src/config.ts": { exitCode: 0, stdout: "100644 blob mergeBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree base src/config.ts": { exitCode: 0, stdout: "100644 blob baseBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree fork src/config.ts": { exitCode: 0, stdout: "100644 blob devBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree upstream src/config.ts": { exitCode: 0, stdout: "100644 blob mergeBlob\tsrc/config.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.candidates).toContainEqual(expect.objectContaining({
      path: "src/config.ts",
      classification: "preservation-registry-path-changed",
      decision: "preserve",
    }));
    expect(report.status).toBe("passed");
  });

  test("detects a mode-only change on a preservation-registry path", async () => {
    const diffs = "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT";
    const runner = mockRunner({
      "merge-base --all fork upstream": { exitCode: 0, stdout: "base\n", stderr: "" },
      [`${diffs} base fork --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} base upstream --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} base merge --`]: { exitCode: 0, stdout: "", stderr: "" },
      "ls-tree dev src/config.ts": { exitCode: 0, stdout: "100644 blob sameBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree merge src/config.ts": { exitCode: 0, stdout: "100755 blob sameBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree base src/config.ts": { exitCode: 0, stdout: "100644 blob sameBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree fork src/config.ts": { exitCode: 0, stdout: "100644 blob sameBlob\tsrc/config.ts\n", stderr: "" },
      "ls-tree upstream src/config.ts": { exitCode: 0, stdout: "100644 blob sameBlob\tsrc/config.ts\n", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: "base", fork: "fork", upstream: "upstream", merge: "merge", dev: "dev", tag: "v2.40.0" });
    expect(report.candidates).toContainEqual(expect.objectContaining({
      path: "src/config.ts",
      classification: "preservation-registry-path-changed",
    }));
  });

  test("trusted verification rejects stale head and report hashes", async () => {
    const release = loadRegistry().releases["v2.40.0"]!;
    const diffs = "diff --find-renames --find-copies --name-status --diff-filter=ACDMRT";
    const runner = mockRunner({
      "rev-parse HEAD": { exitCode: 0, stdout: "merge\n", stderr: "" },
      [`merge-base --all fork ${release.tagSha}`]: { exitCode: 0, stdout: `${release.baseSha}\n`, stderr: "" },
      [`merge-base --all fork ${"0".repeat(40)}`]: { exitCode: 0, stdout: `${release.baseSha}\n`, stderr: "" },
      [`${diffs} ${release.baseSha} fork --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} ${release.baseSha} ${release.tagSha} --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} ${release.baseSha} ${"0".repeat(40)} --`]: { exitCode: 0, stdout: "", stderr: "" },
      [`${diffs} ${release.baseSha} merge --`]: { exitCode: 0, stdout: "", stderr: "" },
    });
    const report = await analyzeOverlap({ runner, base: release.baseSha, fork: "fork", upstream: release.tagSha, merge: "merge", dev: "dev", tag: "v2.40.0" });
    const provenance = {
      headSha: "merge",
      tagSha: release.tagSha,
      baseSha: release.baseSha,
      registryHash: report.registryHash,
      decisionHash: report.decisionHash,
      reportHash: preservationReportHash(report),
    };
    const input = JSON.stringify({ base: release.baseSha, fork: "fork", upstream: release.tagSha, merge: "merge", dev: "dev", tag: "v2.40.0", provenance });
    await expect(runCli(["verify"], { env: {}, stdin: input, runner, write: () => {} })).resolves.toBeUndefined();
    await expect(runCli(["verify"], {
      env: {}, stdin: JSON.stringify({ ...JSON.parse(input), provenance: { ...provenance, headSha: "stale" } }), runner, write: () => {},
    })).rejects.toThrow(/stale preservation head SHA/);
    await expect(runCli(["verify"], {
      env: {}, stdin: JSON.stringify({ ...JSON.parse(input), provenance: { ...provenance, reportHash: "stale" } }), runner, write: () => {},
    })).rejects.toThrow(/stale preservation evidence hash/);
    await expect(runCli(["verify"], {
      env: {}, stdin: JSON.stringify({ ...JSON.parse(input), upstream: "0".repeat(40) }), runner, write: () => {},
    })).rejects.toThrow(/preservation release ancestry/);
  });
});
