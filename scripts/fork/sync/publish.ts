import { isAncestor } from "./contained";
import type {
  CommandRunner,
  PrepareResult,
  PublishAction,
  PublishResult,
  SyncEvent,
} from "./types";

interface PublishOptions {
  event: SyncEvent;
  result: PrepareResult;
  devSha: string;
  runner: CommandRunner;
}

async function required(
  runner: CommandRunner,
  args: readonly string[],
): Promise<string> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.exitCode}`);
  }
  return result.stdout.trim();
}

function output(
  action: PublishAction,
  branch: string,
  containsDev: boolean,
  containsVendorMain: boolean,
  status: PrepareResult["status"],
  remoteSha?: string,
): PublishResult {
  const preserved = action === "unchanged"
    || action === "preserved-advanced"
    || action === "preserved-diverged";
  return {
    action,
    branch,
    ...(remoteSha ? { remoteSha } : {}),
    containsDev,
    containsVendorMain,
    handoffRequired: (action === "created" || action === "fast-forwarded")
      && (status === "hotspot-handoff" || status === "history-diverged"),
    escalationRequired: preserved && (
      status === "history-diverged"
      || (status === "hotspot-handoff" ? !containsVendorMain : action === "preserved-diverged")
    ),
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
  const remote = await runner(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);

  if (remote.exitCode === 2) {
    await required(runner, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return output("created", branch, containsDev, containsVendorMain, result.status, localSha);
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
    return output("unchanged", branch, remoteContainsDev, remoteContainsVendorMain, result.status, remoteSha);
  }
  if (result.status === "history-diverged") {
    return output(
      "preserved-diverged",
      branch,
      remoteContainsDev,
      remoteContainsVendorMain,
      result.status,
      remoteSha,
    );
  }
  if (await isAncestor(runner, remoteSha, localSha)) {
    await required(runner, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return output("fast-forwarded", branch, containsDev, containsVendorMain, result.status, localSha);
  }
  if (await isAncestor(runner, localSha, remoteSha)) {
    return output(
      "preserved-advanced",
      branch,
      remoteContainsDev,
      remoteContainsVendorMain,
      result.status,
      remoteSha,
    );
  }
  return output(
    "preserved-diverged",
    branch,
    remoteContainsDev,
    remoteContainsVendorMain,
    result.status,
    remoteSha,
  );
}
