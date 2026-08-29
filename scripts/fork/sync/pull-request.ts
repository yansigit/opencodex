import type {
  DraftPullRequestClient,
  FetchImplementation,
  GitHubPullRequest,
  PrepareResult,
  PublishResult,
  SyncEvent,
} from "./types";
import { isAgentProtectedPath } from "../../../.github/scripts/pr-sponsored-surface.cjs";

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

function autonomousSyncEligible(result: PrepareResult, publishResult?: PublishResult): publishResult is PublishResult {
  if (!publishResult || result.status !== "merged" || result.unresolved.length > 0) return false;
  if (!/^[0-9a-f]{40}$/i.test(publishResult.remoteSha ?? "")) return false;
  if (!publishResult.containsDev || !publishResult.containsVendorMain
    || publishResult.handoffRequired || publishResult.escalationRequired) return false;
  return result.resolutions.every(({ classification }) => classification !== "shared-hotspot");
}

function bodyFor(event: SyncEvent, result: PrepareResult, publishResult?: PublishResult): string {
  const rows = result.resolutions.length === 0
    ? ["| (none) | (none) | merge completed without conflicts |"]
    : result.resolutions.map(resolution =>
      `| ${publicValue(resolution.path)} | ${resolution.classification} | ${publicValue(resolution.action)} |`);
  return [
    "<!-- opencodex-fork-sync -->",
    "## Summary",
    `Merge upstream ${publicValue(event.latestTag)} into the fork integration branch (dev).`,
    `Tag SHA: ${publicValue(event.latestTagSha) || "unavailable"}`,
    `Vendor main SHA: ${publicValue(event.vendorMainSha) || "unavailable"}`,
    "",
    "## Verification",
    `Prepare status: ${result.status}`,
    `Branch: ${publicValue(result.branch ?? "unavailable")}`,
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
  const marker = `<!-- opencodex-fork-sync-provenance:{"producer":"fork-upstream-sync","headSha":"${publishResult.remoteSha}","tagSha":"${event.latestTagSha}"} -->`;
  return body.includes("opencodex-fork-sync-provenance:") ? body : `${body}\n${marker}`;
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

  async function liveSyncSafety(number: number, expectedSha: string): Promise<{ safe: boolean; body: string }> {
    const prResponse = await request(`/pulls/${number}`);
    const live = await prResponse.json() as GitHubPullRequest & { changed_files?: number };
    const files: Array<{ filename?: string; previous_filename?: string }> = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await request(`/pulls/${number}/files?per_page=100&page=${page}`);
      const batch = await response.json() as Array<{ filename?: string; previous_filename?: string }>;
      if (!Array.isArray(batch)) return { safe: false, body: live.body || "" };
      files.push(...batch);
      if (batch.length < 100) break;
    }
    const complete = Number.isInteger(live.changed_files) && live.changed_files === files.length && files.length <= 10000;
    const safe = complete && live.state === "open" && live.base.ref === "dev" && live.head.sha === expectedSha &&
      files.every(file => !isAgentProtectedPath(file));
    return { safe, body: live.body || "" };
  }

  return {
    async upsert({ event, result, publishResult }) {
      if (result.status !== "merged") {
        throw new Error("merged prepare result is required for a draft PR");
      }
      const branch = result.branch;
      if (!branch) throw new Error("merged prepare result is missing a branch");
      const title = `sync: upstream ${publicValue(event.latestTag) || "unknown-release"}`;
      const body = bodyFor(event, result, publishResult);
      const response = await request(
        `/pulls?head=${owner}:${branch}&state=open&base=dev`,
      );
      const openPullRequests = await response.json() as GitHubPullRequest[];
      const matching = openPullRequests.find(pullRequest =>
        pullRequest.state === "open"
        && pullRequest.base.ref === "dev"
        && pullRequest.head.ref === branch);
      const eligible = autonomousSyncEligible(result, publishResult);
      if (matching && !publishResult) return matching.number;
      if (matching) {
        const exactPublishedHead = eligible && matching.head.sha === publishResult?.remoteSha;
        const currentBody = matching.body || "";
        const safety = await liveSyncSafety(matching.number, publishResult?.remoteSha || "");
        const exactSafe = exactPublishedHead && safety.safe;
        const reconciledBody = exactSafe ? provenanceBody(currentBody, event, publishResult) : currentBody
          .replace(/\n*<!-- opencodex-fork-sync-provenance:[\s\S]*? -->/g, "").trimEnd();
        if (reconciledBody !== currentBody) {
          await request(`/pulls/${matching.number}`, { method: "PATCH", body: JSON.stringify({ body: reconciledBody }) });
        }
        const labelsResponse = await request(`/issues/${matching.number}/labels`);
        const labels = await labelsResponse.json() as unknown;
        if (!Array.isArray(labels)) return matching.number;
        const labelList = labels as Array<{ name?: string }>;
        const hasLabel = labelList.some(label => label?.name === "autonomous-sync");
        if (exactSafe && !hasLabel) {
          await request(`/issues/${matching.number}/labels`, { method: "POST", body: JSON.stringify({ labels: ["autonomous-sync"] }) });
        } else if (!exactSafe && hasLabel) {
          await request(`/issues/${matching.number}/labels/autonomous-sync`, { method: "DELETE" });
        }
        return matching.number;
      }
      const payload = {
        title,
        head: branch,
        base: "dev",
        body,
        draft: true,
      };
      const created = await request("/pulls", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const createdPullRequest = await created.json() as { number: number };
      if (eligible) {
        const safety = await liveSyncSafety(createdPullRequest.number, publishResult.remoteSha);
        if (!safety.safe) return createdPullRequest.number;
        await request(`/pulls/${createdPullRequest.number}`, { method: "PATCH", body: JSON.stringify({ body: provenanceBody(body, event, publishResult) }) });
        await request(`/issues/${createdPullRequest.number}/labels`, {
          method: "POST",
          body: JSON.stringify({ labels: ["autonomous-sync"] }),
        });
      }
      return createdPullRequest.number;
    },
  };
}
