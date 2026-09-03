import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner, SyncEvent } from "../../scripts/fork/sync/types";
import { prepareSync } from "../../scripts/fork/sync/prepare";
import { mergePackageJson } from "../../scripts/fork/sync/recipes/package-json";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const conflict = (paths: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "automatic merge failed; fix conflicts and then commit the result",
});

function event(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    kind: "pin-updated",
    upstreamRepo: "upstream",
    latestTag: "v2.32.0",
    latestTagSha: "tag-sha",
    vendorMainSha: "vendor-sha",
    vendorDevSha: "dev-sha",
    detectedAt: "2026-08-24T12:34:56.000Z",
    recommendedLane: "daily-merge",
    ...overrides,
  };
}

function queuedRunner(results: CommandResult[]) {
  const calls: string[][] = [];
  const runner: CommandRunner = async args => {
    calls.push([...args]);
    return results.shift() ?? {
      exitCode: 1,
      stdout: "",
      stderr: `unexpected command: ${args.join(" ")}`,
    };
  };
  return { calls, runner };
}

describe("fork sync daily preparation", () => {
  test("package recipe retains fork CI commands and dependencies while taking upstream security overrides", () => {
    const merged = JSON.parse(mergePackageJson(
      JSON.stringify({
        name: "@yansigit/opencodex",
        version: "2.40.4",
        scripts: {
          prepush: "bun run check:hygiene && bun run lint:workflows && bun run test",
          "test:container": "bun scripts/test-container.ts",
          "check:hygiene": "node scripts/check-hygiene.mjs",
          "lint:workflows": "bun scripts/ci/actionlint.ts",
        },
        devDependencies: { "@anthropic-ai/sdk": "0.122.0" },
        optionalDependencies: { "wreq-js": "3.2.0" },
        overrides: { "fast-uri": "^3.1.5", "ip-address": "^10.4.0" },
      }),
      JSON.stringify({
        name: "@bitkyc08/opencodex",
        version: "2.41.0",
        scripts: { prepush: "bun run typecheck && bun run test" },
        devDependencies: { typescript: "7.0.2" },
        overrides: { "fast-uri": "^3.1.7", qs: "^6.16.0" },
      }),
    ));

    expect(merged).toMatchObject({
      name: "@yansigit/opencodex",
      version: "2.41.0",
      scripts: {
        prepush: "bun run check:hygiene && bun run lint:workflows && bun run test",
        "test:container": "bun scripts/test-container.ts",
        "check:hygiene": "node scripts/check-hygiene.mjs",
        "lint:workflows": "bun scripts/ci/actionlint.ts",
      },
      devDependencies: { "@anthropic-ai/sdk": "0.122.0", typescript: "7.0.2" },
      optionalDependencies: { "wreq-js": "3.2.0" },
      overrides: { "fast-uri": "^3.1.7", "ip-address": "^10.4.0", qs: "^6.16.0" },
    });
  });

  test("creates and merges an upstream-identified branch when there are no conflicts", async () => {
    const queued = queuedRunner([ok(), ok()]);

    const result = await prepareSync(event(), { runner: queued.runner });

    expect(result).toEqual({
      status: "merged",
      branch: "sync/upstream-v2.32.0-tagsha",
      resolutions: [],
      unresolved: [],
    });
    expect(queued.calls).toEqual([
      ["switch", "-C", "sync/upstream-v2.32.0-tagsha"],
      ["merge", "--no-ff", "vendor/main"],
    ]);
  });

  test("hands off fork-owned conflicts without choosing a side", async () => {
    const queued = queuedRunner([
      ok(),
      conflict(""),
      ok("scripts/fork/sync/cli.ts\n"),
      ok(),
    ]);

    const result = await prepareSync(event(), { runner: queued.runner });

    expect(result.status).toBe("decision-handoff");
    expect(result.handoffReason).toBe("conflict");
    expect(result.resolutions).toEqual([{
      path: "scripts/fork/sync/cli.ts",
      classification: "fork-owned",
      action: "decision-handoff: merge --abort",
    }]);
    expect(queued.calls).toEqual([
      ["switch", "-C", "sync/upstream-v2.32.0-tagsha"],
      ["merge", "--no-ff", "vendor/main"],
      ["diff", "--name-only", "--diff-filter=U"],
      ["merge", "--abort"],
    ]);
  });

  test("hands off upstream-owned conflicts without choosing a side", async () => {
    const queued = queuedRunner([
      ok(),
      conflict(""),
      ok("src/providers/new-provider.ts\n"),
      ok(),
    ]);

    const result = await prepareSync(event(), { runner: queued.runner });

    expect(result.resolutions).toEqual([{
      path: "src/providers/new-provider.ts",
      classification: "upstream-owned",
      action: "decision-handoff: merge --abort",
    }]);
    expect(queued.calls).not.toContainEqual(expect.arrayContaining(["checkout"]));
  });

  test("automatically resolves only the named package.json recipe", async () => {
    const queued = queuedRunner([
      ok(),
      conflict(""),
      ok("package.json\n"),
      ok('{"name":"ocx","version":"2.39.0","dependencies":{"left":"1.0.0"}}'),
      ok('{"name":"ocx","version":"2.40.0","dependencies":{"right":"2.0.0"}}'),
      ok(),
      ok(),
      ok(),
    ]);

    const prepared = await prepareSync(event(), { runner: queued.runner });

    expect(prepared).toEqual({
      status: "merged",
      branch: "sync/upstream-v2.32.0-tagsha",
      resolutions: [{
        path: "package.json",
        classification: "recipe",
        action: "merge package recipe",
      }],
      unresolved: [],
    });
    expect(queued.calls.some(args => args[0] === "checkout")).toBe(false);
    expect(queued.calls.some(args => args[0] === "write-file" && args[1] === "package.json")).toBe(true);
  });

  test("aborts instead of pushing a shared-hotspot conflict", async () => {
    const queued = queuedRunner([
      ok(),
      conflict(""),
      ok("src/server/responses/core.ts\n"),
      ok(),
    ]);

    const result = await prepareSync(event(), { runner: queued.runner });

    expect(result).toEqual({
      status: "decision-handoff",
      handoffReason: "conflict",
      branch: "sync/upstream-v2.32.0-tagsha",
      resolutions: [{
        path: "src/server/responses/core.ts",
        classification: "shared-hotspot",
        action: "decision-handoff: merge --abort",
      }],
      unresolved: ["src/server/responses/core.ts"],
    });
    expect(queued.calls).toEqual([
      ["switch", "-C", "sync/upstream-v2.32.0-tagsha"],
      ["merge", "--no-ff", "vendor/main"],
      ["diff", "--name-only", "--diff-filter=U"],
      ["merge", "--abort"],
    ]);
  });

  test("skips events outside the daily merge lane", async () => {
    const queued = queuedRunner([]);

    await expect(prepareSync(event({
      kind: "history-diverged",
      recommendedLane: "emergency-rebuild",
    }), { runner: queued.runner })).resolves.toEqual({
      status: "history-diverged",
      branch: "sync/upstream-v2.32.0-tagsha",
      resolutions: [],
      unresolved: [],
    });
    expect(queued.calls).toEqual([]);
  });
});
