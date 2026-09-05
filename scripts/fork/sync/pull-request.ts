import type {
  DraftPullRequestClient,
  FetchImplementation,
  GitHubPullRequest,
  PrepareResult,
  PublishResult,
  SyncEvent,
} from "./types";
import { branchFor, candidateIdentityFor } from "./prepare";

export interface DraftPullRequestOptions {
  repository: string;
  token: string;
  fetchImpl: FetchImplementation;
}

function publicValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function bodyFor(event: SyncEvent, result: PrepareResult, publishResult?: PublishResult): string {
  const candidate = result.candidate ?? event.candidate;
  const rows = result.resolutions.length === 0
    ? ["| (none) | (none) | merge completed without conflicts |"]
    : result.resolutions.map(resolution =>
      `| ${publicValue(resolution.path)} | ${resolution.classification} | ${publicValue(resolution.action)} |`);
  return [
    "<!-- opencodex-fork-sync -->",
    "## Summary",
    `Merge upstream ${publicValue(candidate?.upstreamTag ?? event.upstreamTag ?? event.latestTag)} into the fork integration branch.`,
    `Tag SHA: ${publicValue(candidate?.upstreamSha ?? event.upstreamSha ?? event.latestTagSha) || "unavailable"}`,
    `Vendor main SHA: ${publicValue(event.vendorMainSha) || "unavailable"}`,
    "",
    "## Verification",
    `Prepare status: ${result.status}`,
    `Branch: ${publicValue(result.branch ?? "unavailable")}`,
    ...(result.preservationReport ? [
      `Preservation status: ${result.preservationReport.status}`,
      `Preservation candidates: ${result.preservationReport.candidates.length}`,
    ] : []),
    "",
    "## Resolution table",
    "| Path | Classification | Action |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Checklist",
    "- [ ] Review the resolution table.",
    "- [ ] Confirm the PR is mergeable.",
    "- [ ] Human performs the merge commit.",
  ].join("\n");
}

function provenanceBody(body: string, event: SyncEvent, publishResult: PublishResult): string {
  const provenance = publishResult.provenance;
  if (!provenance) return body;
  const marker = `<!-- opencodex-fork-sync-provenance:${JSON.stringify({
    producer: "fork-upstream-sync",
    headSha: provenance.headSha,
    tagSha: provenance.tagSha || event.latestTagSha,
    baseSha: provenance.baseSha,
    registryHash: provenance.registryHash,
    decisionHash: provenance.decisionHash,
    reportHash: provenance.reportHash,
  })} -->`;
  const withoutMarker = body
    .replace(/\n*<!-- opencodex-fork-sync-provenance:[\s\S]*? -->/g, "")
    .trimEnd();
  return `${withoutMarker}\n${marker}`;
}

export function createDraftPullRequestClient(
  options: DraftPullRequestOptions,
): DraftPullRequestClient {
  const base = `https://api.github.com/repos/${options.repository}`;
  const owner = options.repository.split("/", 1)[0];
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await options.fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`GitHub pull request request returned HTTP ${response.status}`);
    }
    return response;
  }

  return {
    async upsert({ event, result, publishResult }) {
      if (result.status !== "merged" && !(result.status === "decision-handoff" && result.handoffReason === "preservation")) {
        throw new Error("merged or preservation-handoff prepare result is required for a draft PR");
      }
      const branch = result.branch;
      if (!branch) throw new Error("merged prepare result is missing a branch");
      const candidate = candidateIdentityFor({ ...event, candidate: result.candidate ?? event.candidate });
      if (!candidate) throw new Error("draft PR requires immutable candidate identity");
      if (!candidate.baseRef.startsWith("refs/heads/")) {
        throw new Error("draft PR candidate base ref is invalid");
      }
      const baseRef = candidate.baseRef.slice("refs/heads/".length);
      if (!/^(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]+$/.test(baseRef)) {
        throw new Error("draft PR candidate base ref is invalid");
      }
      if (branch !== branchFor({ ...event, candidate })) {
        throw new Error("draft PR branch does not match immutable candidate identity");
      }
      const candidateEvent = { ...event, candidate };
      const title = `sync: upstream ${publicValue(candidate.upstreamTag) || "unknown-release"}`;
      const body = bodyFor(candidateEvent, result, publishResult);
      const response = await request(
        `/pulls?head=${owner}:${branch}&state=open&base=${encodeURIComponent(baseRef)}`,
      );
      const openPullRequests = await response.json() as GitHubPullRequest[];
      const matching = openPullRequests.find(pullRequest =>
        pullRequest.state === "open"
        && pullRequest.base.ref === baseRef
        && pullRequest.head.ref === branch);
      // PRs are create-once: an existing open PR for this exact branch/base is
      // authoritative, even when its body or metadata was edited by a human.
      // Never mutate an existing PR while syncing.
      if (matching) {
        if (publishResult?.remoteSha && matching.head.sha && matching.head.sha !== publishResult.remoteSha) {
          throw new Error(`existing sync PR #${matching.number} head does not match the published candidate`);
        }
        return matching.number;
      }
      const payload = {
        title,
        head: branch,
        base: baseRef,
        body: publishResult ? provenanceBody(body, candidateEvent, publishResult) : body,
        draft: true,
      };
      const created = await request("/pulls", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const createdPullRequest = await created.json() as { number: number };
      return createdPullRequest.number;
    },
  };
}
