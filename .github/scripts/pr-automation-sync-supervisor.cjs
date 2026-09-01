"use strict";

const SHA_RE = /^[0-9a-f]{40}$/i;
const SYNC_BRANCH_RE = /^sync\/upstream-[A-Za-z0-9._-]+-[0-9a-f]{7,64}$/i;
const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "stale",
  "timed_out",
]);
const ACTIVE_RUN_STATUSES = new Set(["in_progress", "pending", "queued", "requested", "waiting"]);
const DEFAULT_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const SYNC_REPAIR_MARKER_RE = /<!-- opencodex-sync-repair:pr=(\d+);head=([0-9a-f]{40}) -->/i;

function latestCheck(checkRuns, name, headSha, expectedAppId) {
  return (checkRuns || [])
    .filter((check) =>
      check?.name === name &&
      check?.head_sha === headSha &&
      Number(check?.app?.id) === Number(expectedAppId))
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] || null;
}

function syncCiRepairDisposition({
  pr,
  checkRuns = [],
  repository,
  expectedChecksAppId = 15368,
  trustedProducerIds = [41898282],
} = {}) {
  const headSha = pr?.head?.sha;
  const producerIds = new Set((trustedProducerIds || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  const trustedSync =
    pr?.state === "open" &&
    pr?.base?.ref === "dev" &&
    pr?.base?.repo?.full_name === repository &&
    pr?.head?.repo?.full_name === repository &&
    SYNC_BRANCH_RE.test(String(pr?.head?.ref || "")) &&
    SHA_RE.test(String(headSha || "")) &&
    String(pr?.body || "").includes("<!-- opencodex-fork-sync -->") &&
    pr?.user?.type === "Bot" &&
    producerIds.has(Number(pr?.user?.id));
  if (!trustedSync) return { action: "ignore", reason: "untrusted-sync" };

  const ci = latestCheck(checkRuns, "ci", headSha, expectedChecksAppId);
  if (!ci || ci.status !== "completed") return { action: "wait", reason: "ci-pending" };
  if (ci.conclusion === "success") return { action: "healthy", reason: "ci-success" };
  if (!FAILED_CONCLUSIONS.has(String(ci.conclusion || ""))) {
    return { action: "wait", reason: "ci-inconclusive" };
  }
  return {
    action: "repair",
    reason: `ci-${ci.conclusion}`,
    branch: pr.head.ref,
    checkRunId: Number(ci.id),
    headSha,
  };
}

function syncRepairMarker(prNumber, headSha) {
  if (!Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0 || !SHA_RE.test(String(headSha || ""))) {
    throw new Error("invalid sync repair identity");
  }
  return `<!-- opencodex-sync-repair:pr=${Number(prNumber)};head=${String(headSha).toLowerCase()} -->`;
}

function parseSyncRepairMarker(body) {
  const match = String(body || "").match(SYNC_REPAIR_MARKER_RE);
  if (!match) return null;
  const prNumber = Number(match[1]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { prNumber, headSha: match[2].toLowerCase() };
}

function syncRepairIssueDisposition({
  issue,
  pr,
  repository,
  trustedProducerIds = [41898282],
} = {}) {
  const marker = parseSyncRepairMarker(issue?.body);
  const labels = new Set((issue?.labels || [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter(Boolean));
  if (issue?.pull_request || !labels.has("fork-sync") || !labels.has("agent:generated") ||
      !String(issue?.body || "").includes("<!-- opencodex-fork-sync -->") || !marker ||
      typeof repository !== "string" || repository.length === 0) {
    return { action: "ignore", reason: "untrusted-sync-repair" };
  }
  const producerIds = new Set((trustedProducerIds || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  if (issue?.user?.type !== "Bot" || !producerIds.has(Number(issue?.user?.id))) {
    return { action: "ignore", reason: "untrusted-sync-issue-producer" };
  }
  const trustedSyncPr =
    pr?.number === marker.prNumber &&
    pr?.base?.repo?.full_name === repository &&
    pr?.head?.repo?.full_name === repository &&
    pr?.base?.ref === "dev" &&
    SYNC_BRANCH_RE.test(String(pr?.head?.ref || "")) &&
    String(pr?.body || "").includes("<!-- opencodex-fork-sync -->") &&
    pr?.user?.type === "Bot" &&
    producerIds.has(Number(pr?.user?.id));
  if (!trustedSyncPr) return { action: "ignore", reason: "untrusted-sync-pr" };

  const currentHeadSha = String(pr?.head?.sha || "").toLowerCase();
  if (pr.state !== "open") return { action: "close", reason: "pr-not-open", ...marker };
  if (!SHA_RE.test(currentHeadSha) || currentHeadSha !== marker.headSha) {
    return { action: "close", reason: "pr-head-changed", ...marker, currentHeadSha };
  }
  return { action: "keep", reason: "exact-head", ...marker };
}

function buildSyncRepairIssue({ pr, disposition }) {
  if (disposition?.action !== "repair" || !SYNC_BRANCH_RE.test(String(disposition.branch || ""))) {
    throw new Error("sync repair issue requires a validated repair disposition");
  }
  const marker = syncRepairMarker(pr?.number, disposition.headSha);
  const release = disposition.branch.replace(/^sync\/upstream-/, "");
  return {
    marker,
    title: `[agent:sync] CI repair for PR #${Number(pr.number)} (${release})`,
    body: [
      "<!-- opencodex-fork-sync -->",
      marker,
      `Pull request: #${Number(pr.number)}`,
      `Sync branch: ${disposition.branch}`,
      `Exact head SHA: ${disposition.headSha}`,
      `Trusted CI check run: ${disposition.checkRunId}`,
      `Failure: ${disposition.reason}`,
      "",
      "Action: reproduce the exact-head CI failure, fix only regressions introduced by the upstream integration, and push the fix to the existing sync branch. Follow AGENTS.md and docs/fork/OWNED.md. Do not weaken required checks, sponsorship rules, protected-path review, or merge policy. Run the smallest focused checks first, then the required pre-PR validation.",
    ].join("\n"),
  };
}

function syncFreshnessDisposition({
  latestReleaseSha,
  vendorMainSha,
  workflowRuns = [],
  now = Date.now(),
  retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS,
} = {}) {
  if (!SHA_RE.test(String(latestReleaseSha || ""))) return { action: "error", reason: "invalid-release-sha" };
  if (String(latestReleaseSha).toLowerCase() === String(vendorMainSha || "").toLowerCase()) {
    return { action: "current", reason: "vendor-current" };
  }
  if ((workflowRuns || []).some((run) => ACTIVE_RUN_STATUSES.has(String(run?.status || "").toLowerCase()))) {
    return { action: "wait", reason: "sync-active" };
  }
  const completedAt = (workflowRuns || [])
    .filter((run) => run?.status === "completed")
    .map((run) => Date.parse(run.updated_at || run.created_at || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (Number.isFinite(completedAt) && now - completedAt < retryCooldownMs) {
    return { action: "wait", reason: "retry-cooldown" };
  }
  return { action: "dispatch", reason: "upstream-release-behind" };
}

module.exports = {
  DEFAULT_RETRY_COOLDOWN_MS,
  parseSyncRepairMarker,
  SYNC_BRANCH_RE,
  buildSyncRepairIssue,
  syncCiRepairDisposition,
  syncFreshnessDisposition,
  syncRepairIssueDisposition,
  syncRepairMarker,
};
