import { isAncestor } from "./contained";
import { preservationReportHash } from "./overlap";
import { decisionHash, loadRegistry, registryHash } from "./preservation";
import type { CommandRunner, PrepareResult, PublishAction, PublishResult, SyncEvent } from "./types";

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

function buildResult(
  action: PublishAction,
  branch: string,
  containsDev: boolean,
  containsVendorMain: boolean,
  prepare: PrepareResult,
  provenance: PublishResult["provenance"],
  remoteSha?: string,
): PublishResult {
  const preservedRemote = action === "unchanged"
    || action === "preserved-advanced"
    || action === "preserved-diverged";
  return {
    action,
    branch,
    ...(remoteSha ? { remoteSha } : {}),
    containsDev,
    containsVendorMain,
    handoffRequired: prepare.status === "decision-handoff" || prepare.status === "history-diverged",
    escalationRequired: preservedRemote && (
      prepare.status !== "merged" || !containsDev || !containsVendorMain
    ),
    ...(prepare.preservationReport ? { preservationReport: prepare.preservationReport } : {}),
    registryHash: provenance.registryHash,
    provenance,
  };
}

export async function publishSyncBranch(options: PublishOptions): Promise<PublishResult> {
  const { event, result, devSha, runner } = options;
  const branch = result.branch;
  if (!branch) throw new Error("publish requires a prepare result branch");

  await required(runner, ["check-ref-format", "--branch", branch]);
  const localSha = await required(runner, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const containsDev = await isAncestor(runner, devSha, localSha);
  const containsVendorMain = await isAncestor(runner, event.vendorMainSha, localSha);
  const report = result.preservationReport;
  const provenanceFor = (headSha: string): NonNullable<PublishResult["provenance"]> => ({
    headSha,
    tagSha: event.latestTagSha,
    baseSha: report?.shas.base ?? devSha,
    registryHash: registryHash(),
    decisionHash: report?.decisionHash ?? decisionHash(loadRegistry(), event.latestTag),
    reportHash: report ? preservationReportHash(report) : "",
  });
  const remote = await runner(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);

  if (remote.exitCode === 2) {
    await required(runner, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return buildResult("created", branch, containsDev, containsVendorMain, result, provenanceFor(localSha), localSha);
  }
  if (remote.exitCode !== 0) {
    throw new Error(remote.stderr.trim() || `git ls-remote failed with exit code ${remote.exitCode}`);
  }

  const remoteSha = remote.stdout.trim().split(/\s+/, 1)[0];
  if (!remoteSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(remoteSha)) {
    throw new Error("origin returned an invalid sync branch SHA");
  }
  await required(runner, ["fetch", "--no-tags", "origin", remoteSha]);
  const remoteContainsDev = await isAncestor(runner, devSha, remoteSha);
  const remoteContainsVendorMain = await isAncestor(runner, event.vendorMainSha, remoteSha);

  if (remoteSha === localSha) {
    return buildResult("unchanged", branch, remoteContainsDev, remoteContainsVendorMain, result, provenanceFor(remoteSha), remoteSha);
  }
  if (result.status === "history-diverged") {
    return buildResult("preserved-diverged", branch, remoteContainsDev, remoteContainsVendorMain, result, provenanceFor(remoteSha), remoteSha);
  }
  if (await isAncestor(runner, remoteSha, localSha)) {
    await required(runner, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return buildResult("fast-forwarded", branch, containsDev, containsVendorMain, result, provenanceFor(localSha), localSha);
  }
  if (await isAncestor(runner, localSha, remoteSha)) {
    return buildResult("preserved-advanced", branch, remoteContainsDev, remoteContainsVendorMain, result, provenanceFor(remoteSha), remoteSha);
  }
  return buildResult("preserved-diverged", branch, remoteContainsDev, remoteContainsVendorMain, result, provenanceFor(remoteSha), remoteSha);
}
