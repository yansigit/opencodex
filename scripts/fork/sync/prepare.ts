import { classifyPath } from "./ownership";
import { mergePackageJson } from "./recipes/package-json";
import type { CandidateIdentity, CommandRunner, PrepareResult, SyncEvent } from "./types";

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

export function candidateIdentityFor(event: SyncEvent): CandidateIdentity | undefined {
  if (event.candidate) {
    validateCandidateIdentity(event.candidate);
    if (event.candidate.upstreamRepo !== event.upstreamRepo
      || (event.upstreamTag && event.candidate.upstreamTag !== event.upstreamTag)
      || (event.upstreamSha && event.candidate.upstreamSha !== event.upstreamSha)
      || (event.baseRef !== undefined && event.candidate.baseRef !== event.baseRef)
      || (event.baseSha !== undefined && event.candidate.baseSha !== event.baseSha)) {
      throw new Error("sync candidate identity does not match event");
    }
    return Object.freeze({ ...event.candidate });
  }
  // Older webhook payloads do not carry a base snapshot. Keep accepting them
  // for compatibility; newly produced events should always populate baseSha.
  if (!event.baseSha) return undefined;
  const upstreamTag = event.upstreamTag ?? event.latestTag;
  const upstreamSha = event.upstreamSha ?? event.latestTagSha;
  if (!/^[0-9a-f]{40}$/i.test(upstreamSha) || !/^[0-9a-f]{40}$/i.test(event.baseSha)) {
    throw new Error("sync candidate requires exact 40-hex upstream and base SHAs");
  }
  const identity = Object.freeze({
    upstreamRepo: event.upstreamRepo,
    upstreamTag,
    upstreamSha,
    baseRef: event.baseRef ?? "refs/heads/dev",
    baseSha: event.baseSha,
  });
  validateCandidateIdentity(identity);
  return identity;
}

function validateCandidateIdentity(identity: CandidateIdentity): void {
  if (!identity.upstreamRepo || !identity.upstreamTag || !identity.baseRef
    || !/^[0-9a-f]{40}$/i.test(identity.upstreamSha)
    || !/^[0-9a-f]{40}$/i.test(identity.baseSha)) {
    throw new Error("sync candidate requires upstream repo/tag, base ref, and exact 40-hex SHAs");
  }
}

export function branchFor(event: SyncEvent): string {
  const identity = candidateIdentityFor(event);
  const tag = (identity?.upstreamTag || event.upstreamTag || event.latestTag || "unknown-release")
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "unknown-release";
  const sha = (identity?.upstreamSha || event.upstreamSha || event.latestTagSha || "unknown-sha")
    .replace(/[^0-9A-Za-z]+/g, "")
    .slice(0, identity ? 12 : 7) || "unknown";
  if (!identity) return `sync/upstream-${tag}-${sha}`;
  const baseSha = identity.baseSha.replace(/[^0-9A-Za-z]+/g, "").slice(0, 12) || "unknown";
  return `sync/upstream-${tag}-${sha}-${baseSha}`;
}

function conflictedPaths(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
}

function resultForSkipped(event: SyncEvent): PrepareResult {
  const candidate = candidateIdentityFor(event);
  return {
    status: event.kind === "history-diverged" ? "history-diverged" : "skipped",
    ...(event.kind === "history-diverged" ? { branch: branchFor(event) } : {}),
    resolutions: [],
    unresolved: [],
    ...(candidate ? { candidate } : {}),
  };
}

export async function prepareSync(
  event: SyncEvent,
  options: PrepareOptions,
): Promise<PrepareResult> {
  const actionable = (event.kind === "pin-updated" || event.kind === "main-behind")
    && event.recommendedLane === "daily-merge";
  const rebuild = event.kind === "history-diverged" && event.recommendedLane === "emergency-rebuild";
  if (!actionable && !rebuild) {
    return resultForSkipped(event);
  }

  const branch = branchFor(event);
  // `switch -c` creates the candidate and fails if it already exists. Never
  // use `-C`: that would reset/repoint an existing candidate branch.
  const candidate = candidateIdentityFor(event);
  if (!candidate) throw new Error("actionable sync preparation requires immutable candidate identity");
  // Anchor a new candidate at the exact immutable base snapshot.  Supplying
  // the SHA prevents preparation from accidentally inheriting a moving
  // checkout or another candidate's tip.
  await run(options.runner, ["switch", "-c", branch, candidate.baseSha]);
  if (rebuild) {
    return { status: "history-diverged", branch, resolutions: [], unresolved: [], candidate };
  }
  const merge = await options.runner(["merge", "--no-ff", "vendor/main"]);
  if (merge.exitCode === 0) {
    return { status: "merged", branch, resolutions: [], unresolved: [], ...(candidate ? { candidate } : {}) };
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
      ...(candidate ? { candidate } : {}),
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
    return { status: "merged", branch, resolutions, unresolved: [], ...(candidate ? { candidate } : {}) };
  }
  await run(options.runner, ["merge", "--abort"]);
  return {
    status: "decision-handoff",
    handoffReason: "conflict",
    branch,
    resolutions: [],
    unresolved: conflicts,
    ...(candidate ? { candidate } : {}),
  };
}
