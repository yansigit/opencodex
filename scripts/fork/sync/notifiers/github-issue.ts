import type {
  ForkSyncNotifier,
  GitHubIssue,
  GitHubIssuesClient,
  SyncEvent,
} from "../types";
import { branchFor, candidateIdentityFor } from "../prepare";

const LABEL = "fork-sync";
const JULES_LABEL = "agent:jules";
const GENERATED_LABEL = "agent:generated";

export interface GitHubIssueNotifierOptions {
  client: GitHubIssuesClient;
  upstreamRepo: string;
}

function publicValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function syncBranch(event: SyncEvent): string {
  return event.prepareResult?.branch ?? branchFor(event);
}

function candidateMarker(event: SyncEvent): string | undefined {
  const candidate = candidateIdentityFor(event);
  if (!candidate) return undefined;
  return `<!-- opencodex-fork-sync-candidate:${candidate.upstreamSha}:${candidate.baseSha} -->`;
}

function publicList(values: string[] | undefined): string {
  if (!values?.length) return "(none)";
  return values.map(value => `- ${publicValue(value)}`).join("\n");
}

function issueText(event: SyncEvent, upstreamRepo: string): {
  title: string;
  body: string;
} {
  const tag = publicValue(event.candidate?.upstreamTag ?? event.upstreamTag ?? event.latestTag) || "unknown-release";
  const kind = publicValue(event.kind);
  const recommendedLane = publicValue(event.recommendedLane ?? "unspecified");
  const conflict = event.prepareStatus === "decision-handoff" || event.kind === "history-diverged";
  const action = event.prepareStatus === "decision-handoff"
    ? "Action: follow docs/fork/OWNED.md, fix the underlying hotspot on dev, then generate a new immutable successor candidate."
    : event.kind === "history-diverged"
    ? "Action: follow docs/fork/OWNED.md, resolve the divergence on dev, then generate a new immutable successor candidate."
    : event.kind === "pin-updated" || event.kind === "main-behind"
    ? "Action: open a draft PR for this immutable upstream candidate."
    : "Action: investigate the fork sync event.";
  const title = conflict
    ? `[agent:sync] Upstream Conflict Hotspot: ${tag}`
    : `[fork-sync] ${kind}: ${tag}`;
  const body = [
    "<!-- opencodex-fork-sync -->",
    candidateMarker(event),
    `Upstream repository: ${publicValue(upstreamRepo)}`,
    `Event: ${kind}`,
    event.prepareStatus ? `prepareStatus: ${publicValue(event.prepareStatus)}` : undefined,
    `recommendedLane: ${recommendedLane}`,
    `Latest tag: ${tag}`,
    `Latest tag SHA: ${publicValue(event.latestTagSha) || "unavailable"}`,
    event.upstreamTag ? `Upstream tag: ${publicValue(event.upstreamTag)}` : undefined,
    event.upstreamSha ? `Upstream SHA: ${publicValue(event.upstreamSha)}` : undefined,
    event.baseRef ? `Base ref: ${publicValue(event.baseRef)}` : undefined,
    event.baseSha ? `Base SHA: ${publicValue(event.baseSha)}` : undefined,
    `vendor/main SHA: ${publicValue(event.vendorMainSha) || "unavailable"}`,
    `vendor/dev SHA: ${publicValue(event.vendorDevSha) || "unavailable"}`,
    `head SHA: ${publicValue(event.headSha ?? "") || "unavailable"}`,
    `mergeBaseCount: ${event.mergeBaseCount ?? "unavailable"}`,
    event.mergeBaseShas?.length
      ? `merge base SHAs:\n${publicList(event.mergeBaseShas)}`
      : undefined,
    conflict ? `Sync branch: ${publicValue(event.prepareResult?.branch ?? syncBranch(event))}` : undefined,
    conflict ? "Conflict paths:" : undefined,
    conflict ? publicList(event.prepareResult?.unresolved) : undefined,
    conflict && event.prepareResult?.resolutions.length
      ? `Resolutions:\n${event.prepareResult.resolutions.map(resolution =>
        `- ${publicValue(resolution.path)} (${publicValue(resolution.classification)}): ${publicValue(resolution.action)}`
      ).join("\n")}`
      : undefined,
    `Detected at: ${publicValue(event.detectedAt)}`,
    event.error ? `Error: ${publicValue(event.error)}` : action,
  ].filter(Boolean).join("\n");
  return { title, body };
}

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels
    .map(label => typeof label === "string" ? label : label.name ?? "")
    .filter(Boolean);
}

export function createGitHubIssueNotifier(
  options: GitHubIssueNotifierOptions,
): ForkSyncNotifier {
  return {
    id: "github-issue",
    async notify(event) {
      if (event.kind === "already-current" && event.vendorContainedInMain === true) return;
      const issues = await options.client.listOpen({ label: LABEL });
      const marker = candidateMarker(event);
      const matching = marker
        ? issues.find(issue => issue.body.includes(marker))
        : event.latestTag
          ? issues.find(issue => `${issue.title}\n${issue.body}`.includes(event.latestTag))
          : undefined;
      const text = issueText(event, options.upstreamRepo);
      const conflict = event.prepareStatus === "decision-handoff" || event.kind === "history-diverged";
      const targetLabels = conflict
        ? [LABEL, JULES_LABEL, GENERATED_LABEL]
        : [LABEL];
      if (matching) {
        // Candidate issues are create-once records. Preserve human edits and
        // never retarget an existing issue to another snapshot.
        if (marker) return;
        const labels = labelNames(matching);
        for (const l of targetLabels) {
          if (!labels.includes(l)) labels.push(l);
        }
        await options.client.update({
          issueNumber: matching.number,
          title: text.title,
          body: text.body,
          labels,
        });
      } else {
        await options.client.create({
          title: text.title,
          body: text.body,
          labels: targetLabels,
        });
      }
    },
  };
}
