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
      "gui/src/i18n/de.ts",
      "src/adapters/google.ts",
      "src/adapters/google-http.ts",
      "src/cli/capabilities.ts",
      "src/codex/inject.ts",
      "src/config.ts",
      "src/router.ts",
      "src/server/auth-cors.ts",
      "src/server/index.ts",
      "src/server/management/config-routes.ts",
      "src/server/responses/core.ts",
      "src/server/responses/ws-upstream.ts",
      "src/service.ts",
      "src/providers/antigravity-quota.ts",
      "src/providers/key-failover.ts",
      "src/providers/key-store.ts",
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

  test("preserves fork-owned scripts when upstream drops them", () => {
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.40.0",
      scripts: {
        "test:container": "bun scripts/test-container.ts",
        "check:hygiene": "node scripts/check-hygiene.mjs",
        prepush: "bun run check:hygiene && bun run typecheck",
        start: "fork start",
      },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.40.0",
      scripts: {
        start: "bun src/index.ts",
        typecheck: "bun x tsc --noEmit",
        prepush: "bun run typecheck && bun run test",
      },
    });
    const merged = JSON.parse(mergePackageJson(ours, theirs));
    expect(merged.scripts["test:container"]).toBe("bun scripts/test-container.ts");
    expect(merged.scripts["check:hygiene"]).toBe("node scripts/check-hygiene.mjs");
    // upstream scripts win for shared keys, fork-only keys preserved
    expect(merged.scripts.start).toBe("bun src/index.ts");
    expect(merged.scripts.typecheck).toBe("bun x tsc --noEmit");
  });

  test("preserves prepush hygiene prefix without duplication", () => {
    const forkPrepush = "bun run check:hygiene && bun run typecheck && bun run lint:gui:if-changed && bun run test";
    const upstreamPrepush = "bun run typecheck && bun run lint:gui:if-changed && bun run test";
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.40.0",
      scripts: { prepush: forkPrepush, "check:hygiene": "node scripts/check-hygiene.mjs" },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.40.0",
      scripts: { prepush: upstreamPrepush },
    });
    const merged = JSON.parse(mergePackageJson(ours, theirs));
    expect(merged.scripts.prepush).toBe(forkPrepush);
    expect(merged.scripts.prepush.startsWith("bun run check:hygiene && ")).toBe(true);
    // idempotent: running again does not double-prefix
    const ours2 = JSON.stringify({ name: "@yansigit/opencodex", version: "2.40.0", scripts: merged.scripts });
    const merged2 = JSON.parse(mergePackageJson(ours2, theirs));
    expect(merged2.scripts.prepush).toBe(forkPrepush);
  });

  test("does not duplicate hygiene prefix when upstream already has it", () => {
    const prepush = "bun run check:hygiene && bun run typecheck";
    const ours = JSON.stringify({ name: "@yansigit/opencodex", version: "2.40.0", scripts: { prepush, "check:hygiene": "node scripts/check-hygiene.mjs" } });
    const theirs = JSON.stringify({ name: "opencodex", version: "2.40.0", scripts: { prepush } });
    expect(JSON.parse(mergePackageJson(ours, theirs)).scripts.prepush).toBe(prepush);
  });

  test("preserves pinned @anthropic-ai/sdk when upstream drops it", () => {
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.40.0",
      devDependencies: { "@anthropic-ai/sdk": "0.122.0", typescript: "7.0.2" },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.40.0",
      devDependencies: { "@types/bun": "1.4.0", typescript: "7.0.2" },
    });
    const merged = JSON.parse(mergePackageJson(ours, theirs));
    expect(merged.devDependencies["@anthropic-ai/sdk"]).toBe("0.122.0");
    expect(merged.devDependencies["@types/bun"]).toBe("1.4.0");
  });

  test("prefers upstream devDependency when both have @anthropic-ai/sdk", () => {
    const ours = JSON.stringify({ name: "@yansigit/opencodex", version: "2.40.0", devDependencies: { "@anthropic-ai/sdk": "0.122.0" } });
    const theirs = JSON.stringify({ name: "opencodex", version: "2.40.0", devDependencies: { "@anthropic-ai/sdk": "0.130.0" } });
    expect(JSON.parse(mergePackageJson(ours, theirs)).devDependencies["@anthropic-ai/sdk"]).toBe("0.130.0");
  });

  test("does not drop upstream scripts when replacing prepush prefix", () => {
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.40.0",
      scripts: { prepush: "bun run check:hygiene && bun run typecheck", "test:container": "bun scripts/test-container.ts" },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.40.0",
      scripts: { prepush: "bun run typecheck", "lint:gui": "cd gui && bun run lint" },
    });
    const merged = JSON.parse(mergePackageJson(ours, theirs));
    expect(merged.scripts["lint:gui"]).toBe("cd gui && bun run lint");
    expect(merged.scripts["test:container"]).toBe("bun scripts/test-container.ts");
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
