import { isAncestor } from "./contained";
import { preservationReportHash } from "./overlap";
import { decisionHash, loadRegistry, registryHash } from "./preservation";
import { branchFor } from "./prepare";
import type { CandidateIdentity, CommandRunner, PrepareResult, PublishAction, PublishResult, SyncEvent } from "./types";

interface PublishOptions {
  event: SyncEvent;
  result: PrepareResult;
  devSha: string;
  runner: CommandRunner;
}

async function required(runner: CommandRunner, args: readonly string[]): Promise<string> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.exitCode}`);
  }
  return result.stdout.trim();
}

function candidateIdentity(event: SyncEvent, result: PrepareResult): CandidateIdentity {
  const candidate = result.candidate ?? event.candidate;
  if (!candidate) throw new Error("publish requires immutable candidate identity");
  if (!candidate.upstreamRepo || !candidate.upstreamTag || !candidate.baseRef) {
    throw new Error("publish candidate identity is incomplete");
  }
  if (!candidate.baseRef.startsWith("refs/heads/") || candidate.baseRef.includes("..")) {
    throw new Error("publish candidate identity contains an invalid base ref");
  }
  if (!/^[0-9a-f]{40}$/i.test(candidate.upstreamSha) || !/^[0-9a-f]{40}$/i.test(candidate.baseSha)) {
    throw new Error("publish candidate identity contains a malformed SHA");
  }
  if (
    candidate.upstreamRepo !== event.upstreamRepo
    || (event.upstreamTag && candidate.upstreamTag !== event.upstreamTag)
    || (event.upstreamSha && candidate.upstreamSha !== event.upstreamSha)
    || (event.baseRef !== undefined && candidate.baseRef !== event.baseRef)
    || (event.baseSha !== undefined && candidate.baseSha !== event.baseSha)
  ) {
    throw new Error("publish candidate identity does not match the sync event");
  }
  return candidate;
}

function buildResult(
  action: PublishAction,
  branch: string,
  containsDev: boolean,
  containsVendorMain: boolean,
  prepare: PrepareResult,
  provenance: PublishResult["provenance"],
  remoteSha?: string,
): PublishResult {
  return {
    action,
    branch,
    ...(remoteSha ? { remoteSha } : {}),
    containsDev,
    containsVendorMain,
    handoffRequired: prepare.status === "decision-handoff" || prepare.status === "history-diverged",
    escalationRequired: prepare.status !== "merged" || !containsDev || !containsVendorMain,
    ...(prepare.preservationReport ? { preservationReport: prepare.preservationReport } : {}),
    registryHash: provenance.registryHash,
    provenance,
  };
}

export async function publishSyncBranch(options: PublishOptions): Promise<PublishResult> {
  const { event, result, devSha, runner } = options;
  const branch = result.branch;
  if (!branch) throw new Error("publish requires a prepare result branch");
  const candidate = candidateIdentity(event, result);
  if (branch !== branchFor({ ...event, candidate })) {
    throw new Error("publish branch does not match immutable candidate identity");
  }

  await required(runner, ["check-ref-format", "--branch", branch]);
  const localSha = await required(runner, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const containsDev = await isAncestor(runner, devSha, localSha);
  const containsVendorMain = await isAncestor(runner, event.vendorMainSha, localSha);
  const report = result.preservationReport;
  const provenanceFor = (headSha: string): NonNullable<PublishResult["provenance"]> => ({
    headSha,
    tagSha: candidate.upstreamSha,
    baseSha: report?.shas.base ?? candidate.baseSha,
    registryHash: registryHash(),
    decisionHash: report?.decisionHash ?? decisionHash(loadRegistry(), event.latestTag),
    reportHash: report ? preservationReportHash(report) : "",
  });
  const remote = await runner(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);

  if (remote.exitCode === 2) {
    // Empty expected value makes creation a write-once operation.  If another
    // writer creates the ref after ls-remote, git rejects this push instead of
    // replacing that writer's history.
    await required(runner, ["push", `--force-with-lease=refs/heads/${branch}:`, "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return buildResult("created", branch, containsDev, containsVendorMain, result, provenanceFor(localSha), localSha);
  }
  if (remote.exitCode !== 0) {
    throw new Error(remote.stderr.trim() || `git ls-remote failed with exit code ${remote.exitCode}`);
  }

  const remoteSha = remote.stdout.trim().split(/\s+/, 1)[0];
  if (!remoteSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(remoteSha)) {
    throw new Error("origin returned an invalid sync branch SHA");
  }
  if (remoteSha === localSha) {
    return buildResult("unchanged", branch, containsDev, containsVendorMain, result, provenanceFor(remoteSha), remoteSha);
  }
  throw new Error(
    `immutable sync branch collision: origin/${branch} is ${remoteSha}, local candidate is ${localSha}; refusing to mutate remote ref`,
  );
}
