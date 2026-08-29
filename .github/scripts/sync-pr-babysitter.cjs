"use strict";

const PROGRESS_MARKER = "<!-- cursor-sync-progress -->";

const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
  "stale",
]);

function latestChecks(checkRuns = []) {
  const latest = new Map();
  for (const check of checkRuns) {
    if (!check?.name) continue;
    const previous = latest.get(check.name);
    if (!previous || Number(check.id) > Number(previous.id)) latest.set(check.name, check);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeChecks(checkRuns = []) {
  const checks = latestChecks(checkRuns);
  return {
    checks,
    failed: checks.filter((check) => FAILED_CONCLUSIONS.has(String(check.conclusion || "").toLowerCase())),
    pending: checks.filter((check) => String(check.status || "").toLowerCase() !== "completed"),
    successful: checks.filter((check) =>
      String(check.status || "").toLowerCase() === "completed" &&
      ["success", "skipped", "neutral"].includes(String(check.conclusion || "").toLowerCase())
    ),
  };
}

function checkLabel(check) {
  const conclusion = String(check.conclusion || check.status || "unknown").toLowerCase();
  const url = typeof check.details_url === "string" && check.details_url.startsWith("https://github.com/")
    ? ` ([details](${check.details_url}))`
    : "";
  return `\`${check.name}\` — ${conclusion}${url}`;
}

function buildProgressComment({
  headSha,
  baseRef = "dev",
  mergeable,
  mergeableState,
  checkRuns = [],
  reconciledAt = new Date().toISOString(),
}) {
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ""))) throw new Error("invalid sync PR head SHA");
  const summary = summarizeChecks(checkRuns);
  const mergeableText = mergeable === true
    ? "MERGEABLE"
    : mergeable === false
      ? "DIRTY / not mergeable"
      : "pending (GitHub has not computed mergeability)";
  const checkText = summary.checks.length === 0
    ? "pending — no check runs reported yet"
    : summary.failed.length > 0
      ? `failed: ${summary.failed.map(checkLabel).join(", ")}`
      : summary.pending.length > 0
        ? `pending: ${summary.pending.map(checkLabel).join(", ")}`
        : "all reported checks passed";
  const cursor = summary.checks.find((check) => check.name === "Cursor Bugbot");
  const cursorText = cursor
    ? checkLabel(cursor)
    : "not reported for this exact head";
  const rebaseText = mergeable === false && String(mergeableState || "").toLowerCase() === "behind"
    ? `behind \`${baseRef}\` — branch preserved for agent or human resolution`
    : "checked by GitHub mergeability";

  return [
    "### Sync progress (bot-owned)",
    PROGRESS_MARKER,
    `- Head: \`${String(headSha).toLowerCase()}\``,
    `- Base relation to \`${baseRef}\`: ${rebaseText}`,
    `- Mergeability: **${mergeableText}**${mergeableState ? ` (state: \`${mergeableState}\`)` : ""}`,
    `- CI/CD for this exact head: ${checkText}`,
    `- Cursor Bugbot: ${cursorText}`,
    "",
    "This comment is refreshed on PR updates and completed check runs. The babysitter reports status; it never updates or merges the branch.",
    `Last reconciled: ${reconciledAt}`,
  ].join("\n");
}

module.exports = {
  PROGRESS_MARKER,
  buildProgressComment,
  latestChecks,
  summarizeChecks,
};
