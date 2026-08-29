import { describe, expect, test } from "bun:test";
import { classifyPath, isSharedHotspot } from "../../scripts/fork/sync/ownership";
import { mergePackageJson } from "../../scripts/fork/sync/recipes/package-json";

describe("fork sync ownership", () => {
  test("classifies documented fork-owned prefixes", () => {
    for (const path of [
      "src/fork/policy.ts",
      "tests/fork/sync-prepare.test.ts",
      "docs/fork/OWNED.md",
      ".cursor/skills/opencodex-fork-sync/SKILL.md",
      "scripts/fork/sync/cli.ts",
      ".github/workflows/fork-upstream-sync.yml",
      ".github/workflows/fork-pr-mergeable.yml",
    ]) {
      expect(classifyPath(path)).toBe("fork-owned");
    }
  });

  test("classifies shared hotspots before fork defaults", () => {
    for (const path of [
      "src/adapters/google.ts",
      "src/adapters/google-http.ts",
      "src/server/responses/core.ts",
      "src/providers/antigravity-quota.ts",
      "src/providers/quota.ts",
    ]) {
      expect(classifyPath(path)).toBe("shared-hotspot");
      expect(isSharedHotspot(path)).toBe(true);
    }
  });

  test("classifies package metadata as a recipe", () => {
    expect(classifyPath("package.json")).toBe("recipe");
  });

  test("defaults unknown paths to upstream-owned", () => {
    expect(classifyPath("src/providers/new-provider.ts")).toBe("upstream-owned");
  });

  test("preserves fork identity while taking upstream package metadata", () => {
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.31.0",
      scripts: { forkOnly: "keep out", shared: "fork value" },
      forkOnlyTopLevel: { enabled: true },
      repository: { url: "https://github.com/yansigit/opencodex" },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.32.0",
      description: "upstream release",
      scripts: { start: "bun src/index.ts", shared: "upstream value" },
      dependencies: { zod: "4.4.3" },
    });

    expect(JSON.parse(mergePackageJson(ours, theirs))).toEqual({
      name: "@yansigit/opencodex",
      version: "2.32.0",
      description: "upstream release",
      scripts: { start: "bun src/index.ts", shared: "upstream value" },
      dependencies: { zod: "4.4.3" },
      forkOnlyTopLevel: { enabled: true },
      repository: { url: "https://github.com/yansigit/opencodex" },
    });
  });

  test.each([
    ["higher upstream", "2.31.0", "2.32.0", "2.32.0"],
    ["equal upstream", "2.32.0", "2.32.0", "2.32.0"],
    ["lower upstream", "2.32.0", "2.31.0", "2.32.0"],
    ["higher prerelease upstream", "2.35.1", "2.36.0-preview.1", "2.36.0-preview.1"],
    ["stable beats same-core prerelease", "2.36.0", "2.36.0-preview.1", "2.36.0"],
    ["SemVer identifier ordering", "2.0.0-a", "2.0.0-B", "2.0.0-a"],
    ["large major components", "9007199254740993.0.0", "9007199254740992.0.0", "9007199254740993.0.0"],
    ["invalid upstream", "2.32.0", "not-semver", "2.32.0"],
    ["missing upstream", "2.32.0", undefined, "2.32.0"],
    ["invalid current", "not-semver", "2.32.0", "2.32.0"],
    ["missing current", undefined, "2.32.0", "2.32.0"],
  ] as const)("chooses the non-decreasing valid version for %s", (_case, oursVersion, theirsVersion, expected) => {
    const ours = JSON.stringify({ name: "@yansigit/opencodex", version: oursVersion });
    const theirs = JSON.stringify({ name: "opencodex", ...(theirsVersion === undefined ? {} : { version: theirsVersion }) });
    expect(JSON.parse(mergePackageJson(ours, theirs)).version).toBe(expected);
  });

  test.each([
    ["both missing", {}, {}],
    ["both invalid", { version: "nope" }, { version: "still-nope" }],
  ] as const)("throws when %s", (_case, ours, theirs) => {
    expect(() => mergePackageJson(JSON.stringify(ours), JSON.stringify(theirs))).toThrow(
      "fork package.json must contain a valid version",
    );
  });
});
