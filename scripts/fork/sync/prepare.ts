import { classifyPath } from "./ownership";
import { mergePackageJson } from "./recipes/package-json";
import type { CommandRunner, PrepareResult, SyncEvent } from "./types";

export interface PrepareOptions {
  runner: CommandRunner;
}

async function run(
  runner: CommandRunner,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git command failed with exit code ${result.exitCode}`);
  }
  return result;
}

function branchFor(event: SyncEvent): string {
  const tag = (event.latestTag || "unknown-release")
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "unknown-release";
  const sha = (event.latestTagSha || "unknown-sha")
    .replace(/[^0-9A-Za-z]+/g, "")
    .slice(0, 7) || "unknown";
  return `sync/upstream-${tag}-${sha}`;
}

function conflictedPaths(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
}

function resultForSkipped(event: SyncEvent): PrepareResult {
  return {
    status: event.kind === "history-diverged" ? "history-diverged" : "skipped",
    ...(event.kind === "history-diverged" ? { branch: branchFor(event) } : {}),
    resolutions: [],
    unresolved: [],
  };
}

export async function prepareSync(
  event: SyncEvent,
  options: PrepareOptions,
): Promise<PrepareResult> {
  if (
    (event.kind !== "pin-updated" && event.kind !== "main-behind")
    || event.recommendedLane !== "daily-merge"
  ) {
    return resultForSkipped(event);
  }

  const branch = branchFor(event);
  await run(options.runner, ["switch", "-C", branch]);
  const merge = await options.runner(["merge", "--no-ff", "vendor/main"]);
  if (merge.exitCode === 0) {
    return { status: "merged", branch, resolutions: [], unresolved: [] };
  }

  const conflicts = conflictedPaths(
    (await run(options.runner, ["diff", "--name-only", "--diff-filter=U"])).stdout,
  );
  // Fail-closed: only named recipe (package.json) may auto-resolve.
  // All other conflicts require decision-handoff with preservation evidence.
  const recipeConflicts = conflicts.filter(path => classifyPath(path) === "recipe");
  const nonRecipeConflicts = conflicts.filter(path => classifyPath(path) !== "recipe");
  if (nonRecipeConflicts.length > 0) {
    await run(options.runner, ["merge", "--abort"]);
    const resolutions = nonRecipeConflicts.map(path => ({
      path,
      classification: classifyPath(path),
      action: "decision-handoff: merge --abort" as const,
    }));
    return {
      status: "decision-handoff",
      handoffReason: "conflict",
      branch,
      resolutions,
      unresolved: conflicts,
    };
  }
  const resolutions: PrepareResult["resolutions"] = [];
  for (const path of recipeConflicts) {
    const ours = await run(options.runner, ["show", ":2:" + path]);
    const theirs = await run(options.runner, ["show", ":3:" + path]);
    const merged = mergePackageJson(ours.stdout, theirs.stdout);
    await run(options.runner, ["write-file", path, merged]);
    resolutions.push({ path, classification: "recipe" as const, action: "merge package recipe" });
    await run(options.runner, ["add", "--", path]);
  }
  if (recipeConflicts.length > 0) {
    await run(options.runner, ["commit", "--no-edit"]);
    return { status: "merged", branch, resolutions, unresolved: [] };
  }
  await run(options.runner, ["merge", "--abort"]);
  return {
    status: "decision-handoff",
    handoffReason: "conflict",
    branch,
    resolutions: [],
    unresolved: conflicts,
  };
}
