import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareReleaseTags } from "../scripts/release-notes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * The in-tree version must never sit BEHIND a version this repository has already
 * released.
 *
 * This is not hypothetical. dev accumulated 254 commits without ever touching
 * package.json, so its version string (2.32.1-preview.20260825) fell behind the
 * published latest dist-tag (2.33.0) once v2.33.0 was cut from main. One stale line,
 * two distinct failure modes:
 *
 *  - assertChannelVersionMovesForward in scripts/release.ts refuses the string as a
 *    channel regression, so a release cut from that tree cannot publish at all.
 *  - merging dev into main resolves package.json to main's side, producing a tree that
 *    claims to be the ALREADY-PUBLISHED 2.33.0 - a silent duplicate instead of a loud
 *    failure.
 *
 * Commit 32529c2b2 repaired precisely this by hand once, and nothing had enforced it
 * since. The assertion reads tags reachable from this repository's protected remote
 * branches rather than the npm registry, so it needs no network and does not mistake a
 * second remote's newer upstream tag for a release of this fork.
 *
 * compareReleaseTags comes from scripts/release-notes and not from scripts/release: the
 * latter parses process.argv and calls process.exit at module scope, so importing it from
 * a test kills the runner. release-notes guards its CLI behind import.meta.main.
 */

/** Version shape accepted at scripts/release.ts's CLI entry point. */
const RELEASE_CLI_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
/** Release tags shaped from that CLI version. Non-release tags are ignored. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[\w.]+)?$/;

type GitResult = { ok: boolean; out: string };
type GitRunner = (args: string[]) => GitResult;

function git(args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  return {
    ok: result.exitCode === 0,
    out: new TextDecoder().decode(result.stdout).trim(),
  };
}

const RELEASE_BRANCH_REFS = [
  "refs/remotes/origin/main",
  "refs/remotes/origin/dev",
  "refs/remotes/origin/preview",
] as const;

function parseReleaseTags(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RELEASE_TAG.test(line));
}

function localReleaseTags(runGit: GitRunner = git): string[] {
  const availableRefs = RELEASE_BRANCH_REFS.filter(ref =>
    runGit(["rev-parse", "--verify", "--quiet", ref]).ok,
  );
  // Stable releases live on main. If that authority is absent from a shallow or partial
  // checkout, scan every local tag conservatively: omitting a released stable tag would turn
  // this guard into a false green. Full CI checkouts have origin/main and take the scoped path.
  const results = availableRefs.includes("refs/remotes/origin/main")
    ? availableRefs.map(ref => runGit(["tag", "--merged", ref, "--list", "v*"]))
    : [runGit(["tag", "--list", "v*"])];
  // A tarball install or a missing git binary lands here. Absent tags cannot prove a
  // regression, so the check reports nothing rather than inventing a failure.
  const tags = new Set<string>();
  for (const result of results) {
    if (!result.ok) continue;
    for (const tag of parseReleaseTags(result.out)) tags.add(tag);
  }
  return [...tags];
}

function inTreeVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("package.json has no string version");
  return version;
}

/** Newest tag by SemVer precedence, or null when the set is empty. */
function highestReleaseTag(tags: string[]): string | null {
  if (tags.length === 0) return null;
  const sorted = [...tags].sort(compareReleaseTags);
  return sorted[sorted.length - 1] ?? null;
}

/**
 * True when the given tag names the commit under test.
 *
 * This is the difference between "equal is legal" and "equal is a duplicate". On a
 * release commit — main at v2.33.0, preview at v2.33.0-preview.20260825 — package.json
 * SHOULD equal the highest tag, and a test that demanded strictly-ahead everywhere would
 * turn every released commit red. On any other commit, equal means the tree claims a
 * version that is already published.
 */
function tagPointsAtHead(tag: string): boolean {
  const head = git(["rev-parse", "HEAD^{commit}"]);
  const tagged = git([`rev-parse`, `${tag}^{commit}`]);
  return head.ok && tagged.ok && head.out.length > 0 && head.out === tagged.out;
}

describe("release version line", () => {
  test("package.json carries a version accepted by the release CLI", () => {
    // This deliberately mirrors the command-line validation near `const version = args[0]`
    // in scripts/release.ts. Its deeper comparison helper accepts build metadata, but that
    // helper is unreachable for a `+build` CLI argument because entry validation rejects it.
    expect(inTreeVersion()).toMatch(RELEASE_CLI_VERSION);
  });

  test("the in-tree version is never behind a released one", () => {
    const tags = localReleaseTags();
    // A checkout with no tags cannot answer the question. CI fetches tags explicitly for
     // the jobs that run this suite (see .github/workflows/ci.yml), so an empty set here
    // means a tarball or a hand-made shallow clone, not a silently unprotected pipeline.
    if (tags.length === 0) return;

    const version = inTreeVersion();
    const highest = highestReleaseTag(tags);
    expect(highest).not.toBeNull();

    const ordering = compareReleaseTags("v" + version, highest!);
    if (ordering === 0) {
      // Legal only on the release commit that tag names.
      expect(
        tagPointsAtHead(highest!),
        "package.json version " + version + " equals release tag " + highest +
          ", but this commit is not the one that tag names. The tree claims an " +
          "already-published version: publishing is refused as a duplicate. Bump " +
          "package.json.",
      ).toBe(true);
      return;
    }

    expect(
      ordering,
      "package.json version " + version + " is BEHIND the highest release tag " +
        highest +
        ". A release cut from this tree is rejected as a channel regression, and " +
        "merging into main resolves package.json to main's side and silently " +
        "republishes. Bump package.json.",
    ).toBeGreaterThan(0);
  });

  test("multi-remote upstream tags do not become releases of this repository", () => {
    const calls: string[][] = [];
    const runGit: GitRunner = args => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        return { ok: args[3] !== "refs/remotes/origin/preview", out: "commit" };
      }
      if (args[0] === "tag" && args[1] === "--merged") {
        return {
          ok: true,
          out: args[2] === "refs/remotes/origin/main"
            ? "v2.41.0\nv2.41.1-dev.1\nnot-a-release"
            : "v2.41.1-dev.1",
        };
      }
      return { ok: true, out: "v99.0.0" };
    };

    expect(localReleaseTags(runGit).sort(compareReleaseTags)).toEqual([
      "v2.41.0",
      "v2.41.1-dev.1",
    ]);
    expect(calls).not.toContainEqual(["tag", "--list", "v*"]);
  });

  test("a partial checkout without origin/main falls back fail-closed to all tags", () => {
    const runGit: GitRunner = args => {
      if (args[0] === "rev-parse") {
        return { ok: args[3] === "refs/remotes/origin/dev", out: "commit" };
      }
      if (args[0] === "tag" && args[1] === "--list") {
        return { ok: true, out: "v2.41.1-dev.1\nv2.41.0\nv2.42.0" };
      }
      return { ok: true, out: "v2.41.1-dev.1" };
    };

    expect(highestReleaseTag(localReleaseTags(runGit))).toBe("v2.42.0");
  });

  test("a version behind the tag set is detected rather than tolerated", () => {
    // Proves the comparison above is not vacuous: the same helper, given the exact string
    // dev actually carried, must order it BEHIND the release that stranded it.
    expect(compareReleaseTags("v2.32.1-preview.20260825", "v2.33.0")).toBeLessThan(0);
    expect(compareReleaseTags("v2.33.0", "v2.33.0")).toBe(0);
    expect(compareReleaseTags("v2.34.0", "v2.33.0")).toBeGreaterThan(0);
    // A prerelease of a FUTURE version is ahead, not behind: dev may legitimately carry
    // 2.35.0-preview.1 while v2.34.0 is the newest tag.
    expect(compareReleaseTags("v2.35.0-preview.1", "v2.34.0")).toBeGreaterThan(0);
    // ...but a prerelease of the SAME core is behind its own stable release.
    expect(compareReleaseTags("v2.34.0-preview.1", "v2.34.0")).toBeLessThan(0);
  });
});
