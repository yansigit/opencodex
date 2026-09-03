import { detectLatestVTag } from "./detect";
import { annotateMainLane } from "./lane";
import { pinVendorRefs } from "./pin";
import { prepareSync } from "./prepare";
import { publishSyncBranch } from "./publish";
import { createDraftPullRequestClient } from "./pull-request";
import { analyzeOverlap, preservationReportHash } from "./overlap";
import { loadRegistry, registryHash, registryPath } from "./preservation";
import { enabledCoordinators, enabledNotifiers, registerCoordinator, registerNotifier } from "./registry";
import { createCliCoordinator } from "./coordinators/cli";
import { createCursorWebhookCoordinator } from "./coordinators/cursor-webhook";
import { createHttpCoordinator } from "./coordinators/http";
import { createGitHubIssueNotifier } from "./notifiers/github-issue";
import type {
  CommandResult,
  CommandRunner,
  DraftPullRequestClient,
  FetchImplementation,
  GitHubIssuesClient,
  PrepareResult,
  ProcessRunner,
  PublishResult,
  SyncEvent,
} from "./types";

const DEFAULT_UPSTREAM_REPO = "https://github.com/lidge-jun/opencodex.git";
const usage = "usage: bun scripts/fork/sync/cli.ts detect|pin|prepare|publish|draft-pr|emit|overlap|verify|preservation-check";

export interface CliOptions {
  env?: Record<string, string | undefined>;
  runner?: CommandRunner;
  stdin?: string;
  write?: (value: string) => void;
  githubClient?: GitHubIssuesClient;
  draftClient?: DraftPullRequestClient;
  fetchImpl?: FetchImplementation;
  processRunner?: ProcessRunner;
}

async function commandRunner(args: readonly string[]): Promise<CommandResult> {
  if (args[0] === "write-file") {
    const [, path, content] = args;
    if (
      !path
      || content === undefined
      || path.startsWith("/")
      || path.split("/").includes("..")
    ) {
      return { exitCode: 1, stdout: "", stderr: "unsafe write-file path" };
    }
    await Bun.write(path, content);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    exitCode: await process.exited,
    stdout,
    stderr,
  };
}

async function runOk(runner: CommandRunner, args: readonly string[]): Promise<string> {
  const r = await runner(args);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout.trim();
}

function githubClient(
  env: Record<string, string | undefined>,
  fetchImpl: FetchImplementation,
): GitHubIssuesClient {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for github-issue");
  }
  const base = `https://api.github.com/repos/${repository}/issues`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`GitHub issues request returned HTTP ${response.status}`);
    return response;
  }
  return {
    async listOpen({ label }) {
      const issues: Awaited<ReturnType<GitHubIssuesClient["listOpen"]>> = [];
      for (let page = 1; ; page++) {
        const response = await request(
          `?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
        );
        const pageIssues = await response.json() as Awaited<ReturnType<GitHubIssuesClient["listOpen"]>>;
        issues.push(...pageIssues);
        if (pageIssues.length < 100) return issues;
      }
    },
    async create(options) {
      await request("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      });
    },
    async update(options) {
      const { issueNumber, ...body } = options;
      await request(`/${issueNumber}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

function registerBuiltins(
  env: Record<string, string | undefined>,
  options: CliOptions,
): void {
  const notifierIds = (env.FORK_SYNC_NOTIFIERS ?? "")
    .split(",")
    .map(id => id.trim());
  if (notifierIds.includes("github-issue")) {
    registerNotifier(createGitHubIssueNotifier({
      upstreamRepo: env.FORK_SYNC_UPSTREAM_REPO ?? DEFAULT_UPSTREAM_REPO,
      client: options.githubClient ?? githubClient(env, options.fetchImpl ?? fetch),
    }));
  }
  const coordinatorIds = (env.FORK_SYNC_COORDINATORS ?? "")
    .split(",")
    .map(id => id.trim());
  if (coordinatorIds.includes("cursor-webhook")) {
    registerCoordinator(createCursorWebhookCoordinator({
      url: env.FORK_SYNC_CURSOR_WEBHOOK_URL,
      secret: env.FORK_SYNC_CURSOR_WEBHOOK_SECRET,
      fetchImpl: options.fetchImpl,
    }));
  }
  if (coordinatorIds.includes("http")) {
    registerCoordinator(createHttpCoordinator({
      url: env.FORK_SYNC_HTTP_URL,
      secret: env.FORK_SYNC_HTTP_SECRET,
      signatureHeader: env.FORK_SYNC_HTTP_SIGNATURE_HEADER,
      signaturePrefix: env.FORK_SYNC_HTTP_SIGNATURE_PREFIX,
      authHeader: env.FORK_SYNC_HTTP_AUTH_HEADER,
      fetchImpl: options.fetchImpl,
    }));
  }
  if (coordinatorIds.includes("cli")) {
    const input = env.FORK_SYNC_CLI_INPUT;
    if (input && input !== "json" && input !== "summary") {
      throw new Error("FORK_SYNC_CLI_INPUT must be json or summary");
    }
    registerCoordinator(createCliCoordinator({
      command: env.FORK_SYNC_CLI_COMMAND,
      input,
      runner: options.processRunner,
    }));
  }
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin).text();
}

async function currentHead(runner: CommandRunner): Promise<string> {
  const result = await runner(["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git rev-parse HEAD failed with exit code ${result.exitCode}`);
  }
  const head = result.stdout.trim();
  if (!head) throw new Error("git rev-parse HEAD returned no commit");
  return head;
}

export async function runCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<void> {
  const command = args[0];
  if (
    command !== "detect"
    && command !== "pin"
    && command !== "prepare"
    && command !== "publish"
    && command !== "draft-pr"
    && command !== "emit"
    && command !== "overlap"
    && command !== "verify"
    && command !== "preservation-check"
  ) {
    throw new Error(usage);
  }
  const env = options.env ?? process.env;
  const write = options.write ?? (value => process.stdout.write(`${value}\n`));
  if (env.FORK_SYNC_WORKTREE) process.chdir(env.FORK_SYNC_WORKTREE);
  const runner = options.runner ?? commandRunner;
  if (command === "preservation-check") {
    const registry = loadRegistry();
    write(JSON.stringify({
      registryPath: registryPath(),
      registryHash: registryHash(),
      releases: Object.keys(registry.releases),
      baselineFeatures: Object.keys(registry.baseline?.features ?? {}),
    }));
    return;
  }
  if (command === "overlap" || command === "verify") {
    const input = options.stdin ? JSON.parse(options.stdin) : JSON.parse(await readStdin());
    const { base, fork, upstream, merge, dev, tag, provenance } = input as {
      base: string;
      fork: string;
      upstream: string;
      merge: string;
      dev: string;
      tag: string;
      provenance?: PublishResult["provenance"];
    };
    if (!base || !fork || !upstream || !merge || !dev || !tag) throw new Error("overlap requires base/fork/upstream/merge/dev/tag");
    const report = await analyzeOverlap({ runner, base, fork, upstream, merge, dev, tag });
    if (command === "verify") {
      if (!provenance) throw new Error("verify requires exact-head provenance");
      const release = loadRegistry(env).releases[tag];
      if (!release || release.tagSha !== upstream || release.baseSha !== base) {
        throw new Error("preservation release ancestry does not match verification input");
      }
      const headSha = await runOk(runner, ["rev-parse", "HEAD"]);
      const reportHash = preservationReportHash(report);
      if (headSha !== merge || provenance.headSha !== headSha) throw new Error("stale preservation head SHA");
      if (provenance.tagSha !== upstream || provenance.baseSha !== base) throw new Error("stale preservation ancestry");
      if (provenance.registryHash !== report.registryHash
        || provenance.decisionHash !== report.decisionHash
        || provenance.reportHash !== reportHash) {
        throw new Error("stale preservation evidence hash");
      }
    }
    write(JSON.stringify(report));
    if (report.status !== "passed") {
      throw new Error(`overlap candidates detected: ${report.candidates.map(c => c.path).join(", ")}`);
    }
    return;
  }
  if (command === "emit") {
    registerBuiltins(env, options);
    const input = options.stdin ?? await readStdin();
    const event = JSON.parse(input) as SyncEvent;
    const failures: string[] = [];
    for (const notifier of enabledNotifiers(env)) {
      try {
        await notifier.notify(event);
      } catch (error) {
        failures.push(`${notifier.id}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    for (const coordinator of enabledCoordinators(env)) {
      try {
        await coordinator.start(event);
      } catch (error) {
        failures.push(`${coordinator.id}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
    return;
  }
  if (command === "prepare") {
    const input = options.stdin ?? await readStdin();
    const event = JSON.parse(input) as SyncEvent;
    const forkSha = await runOk(runner, ["rev-parse", "HEAD"]);
    if (!forkSha) throw new Error("prepare could not resolve the fork head");
    const result = await prepareSync(event, { runner });
    // Attempt overlap analysis for provenance; fail-closed on error or candidates.
    try {
      const bases = (await runOk(runner, ["merge-base", "--all", forkSha, event.vendorMainSha]))
        .split(/\r?\n/).filter(Boolean);
      if (bases.length !== 1) throw new Error("sync preservation requires one merge base");
      const base = bases[0]!;
      const mergeSha = await runOk(runner, ["rev-parse", result.branch ? `refs/heads/${result.branch}` : "HEAD"]);
      const report = await analyzeOverlap({
        runner,
        base,
        fork: forkSha,
        upstream: event.vendorMainSha,
        merge: mergeSha,
        dev: forkSha,
        tag: event.latestTag,
      });
      result.preservationReport = report;
      if (report.status !== "passed") {
        result.status = "decision-handoff";
        result.handoffReason = "preservation";
        result.unresolved = [...new Set([...result.unresolved, ...report.candidates.map(c => c.path)])];
      }
    } catch {
      // If overlap analysis fails (non-unique base etc), preserve fail-closed by handoff.
      if (result.status === "merged") {
        result.status = "decision-handoff";
        result.handoffReason = "preservation";
      }
    }
    write(JSON.stringify(result));
    return;
  }
  if (command === "publish") {
    const input = options.stdin ?? await readStdin();
    const envelope = JSON.parse(input) as {
      event: SyncEvent;
      result: PrepareResult;
      devSha: string;
    };
    write(JSON.stringify(await publishSyncBranch({ ...envelope, runner })));
    return;
  }
  if (command === "draft-pr") {
    const input = options.stdin ?? await readStdin();
    const envelope = JSON.parse(input) as {
      event: SyncEvent;
      result: Parameters<DraftPullRequestClient["upsert"]>[0]["result"];
      publishResult?: Parameters<DraftPullRequestClient["upsert"]>[0]["publishResult"];
    };
    let client = options.draftClient;
    if (!client) {
      const repository = env.GITHUB_REPOSITORY;
      const token = env.GITHUB_TOKEN;
      if (!repository || !token) {
        throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for draft-pr");
      }
      client = createDraftPullRequestClient({
        repository,
        token,
        fetchImpl: options.fetchImpl ?? fetch,
      });
    }
    const pullRequestNumber = await client.upsert(envelope);
    write(JSON.stringify({ pullRequestNumber }));
    return;
  }

  const upstreamRepo = env.FORK_SYNC_UPSTREAM_REPO ?? DEFAULT_UPSTREAM_REPO;
  const detected = await detectLatestVTag({ upstreamRepo, runner });
  const mainRef = command === "pin" && detected.vendorMainSha
    ? await currentHead(runner)
    : undefined;
  const pinnedEvent = command === "pin"
    ? await pinVendorRefs(detected, {
      runner,
      upstreamDevRef: env.FORK_SYNC_UPSTREAM_DEV_REF,
    })
    : detected;
  const finalEvent = await annotateMainLane(pinnedEvent, {
    runner,
    ...(mainRef ? { mainRef } : {}),
  });
  write(JSON.stringify(finalEvent));
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : "fork sync failed");
  });
}
