"use strict";

const {
  autonomousMergeEvidence,
  exactHeadBugbotEvidence,
} = require("./agent-maintenance.cjs");
const {
  isAgentProtectedPath,
  isRestrictedPath,
} = require("./pr-sponsored-surface.cjs");

const AUTOMATION_COMMENT_MARKER = "<!-- opencodex-pr-automation:v1 -->";
const SHA_RE = /^[0-9a-f]{40}$/i;
const SYNC_BRANCH_RE = /^sync\/upstream-[A-Za-z0-9._-]+-[0-9a-f]{7,64}$/i;
const ACTIVE_JULES_STATES = new Set(["QUEUED", "IN_PROGRESS", "PLANNING", "AWAITING_PLAN_APPROVAL"]);
const TERMINAL_JULES_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "CANCELED"]);
const REQUIRED_CHECKS = ["ci", "hygiene", "enforce-target", "mergeable"];
const KNOWN_CHECKS = new Set([
  ...REQUIRED_CHECKS,
  "react-doctor",
  "service-lifecycle",
  "fork-pr-mergeable",
  "Cursor Bugbot",
]);

function labelsOf(labels = []) {
  return new Set((labels || []).map(label =>
    typeof label === "string" ? label : label?.name,
  ).filter(Boolean));
}

function repositoryName(repository) {
  if (typeof repository === "string") return repository.toLowerCase();
  return String(repository?.full_name || repository?.name || "").toLowerCase();
}

function pullRequestOf(input = {}) {
  return input.pr || input.pullRequest || input;
}

function stateOf(input, pr) {
  return String(input.julesState ?? input.agentState ?? input.sessionState ??
    pr.julesState ?? "").toUpperCase();
}

function syncPullRequest(pr, input) {
  const branch = String(pr.head?.ref || "");
  const body = String(pr.body || "");
  return Boolean(input.syncGenerated || input.deterministicSync ||
    (SYNC_BRANCH_RE.test(branch) && (body.includes("<!-- opencodex-fork-sync -->") ||
      input.agentResolved || input.agentResolution || pr.agentResolved || pr.agentResolution)));
}

function agentResolved(input, pr) {
  const provenance = input.provenance || input.syncProvenance || {};
  return Boolean(
    input.agentResolved || input.agentResolution || input.agentResolvedSync ||
    input.julesResolved || pr.agentResolved || pr.agentResolution || pr.agentResolvedSync ||
    pr.julesResolved || provenance.agentResolved || provenance.resolvedBy ||
    ["agent-resolved-sync", "jules-resolved"].includes(provenance.kind),
  );
}

function maintainerLogins(input) {
  const values = input.maintainerLogins || input.maintainers || [];
  return new Set(values.map(value =>
    typeof value === "string" ? value : value?.login,
  ).filter(Boolean).map(value => value.toLowerCase()));
}

function classifyPullRequest(input = {}) {
  const pr = pullRequestOf(input);
  const repository = repositoryName(input.repository || input.repo || pr.base?.repo);
  const headRepository = repositoryName(pr.head?.repo);
  const baseRef = String(pr.base?.ref || input.baseRef || "");
  const headRef = String(pr.head?.ref || input.headRef || "");
  const labels = labelsOf(pr.labels || input.labels);
  const sync = syncPullRequest(pr, input);
  const resolved = agentResolved(input, pr);
  const julesState = stateOf(input, pr);
  const sameRepository = Boolean(repository && headRepository && repository === headRepository);
  const promotion = Boolean(input.promotion ||
    (baseRef === "main" && headRef === "dev" && /^promote:/i.test(String(pr.title || ""))));
  const stacked = Boolean(input.stacked || input.baseIsPullRequest || input.openParentPullRequest ||
    pr.baseIsPullRequest || pr.openParentPullRequest ||
    (baseRef !== "" && baseRef !== "dev" && baseRef !== "main" && (input.basePullRequest || pr.basePullRequest)));

  let className = "same-repo-human";
  let reason = "same-repo-human";
  if (!pr || !pr.state) {
    className = "hold";
    reason = "invalid-pr";
  } else if (pr.state !== "open") {
    className = "hold";
    reason = "closed";
  } else if (!pr.head?.repo || !pr.head?.sha) {
    className = "hold";
    reason = "deleted-head";
  } else if (promotion) {
    className = "promotion";
    reason = "promotion";
  } else if (labels.has("automation:hold")) {
    className = "hold";
    reason = "automation-hold";
  } else if (stacked) {
    className = "stacked";
    reason = "stacked";
  } else if (julesState && ACTIVE_JULES_STATES.has(julesState)) {
    className = "jules-active";
    reason = "jules-active";
  } else if (julesState && TERMINAL_JULES_STATES.has(julesState) && !sync) {
    className = "jules-terminal";
    reason = "jules-terminal";
  } else if (pr.draft) {
    className = "draft";
    reason = "draft";
  } else if (!sameRepository) {
    className = "fork";
    reason = "fork-head";
  } else if (baseRef !== "dev") {
    className = "hold";
    reason = "retargeted";
  } else if (resolved && sync) {
    className = "agent-resolved-sync";
    reason = "agent-resolved-sync";
  } else if (sync) {
    className = "deterministic-sync";
    reason = "deterministic-sync";
  }

  const updateable = pr?.state === "open" && !pr.draft && sameRepository &&
    ["same-repo-human", "deterministic-sync"].includes(className) &&
    !labels.has("automation:hold");
  return {
    class: className,
    kind: className,
    reason,
    sameRepository,
    deterministicSync: className === "deterministic-sync",
    agentResolvedSync: className === "agent-resolved-sync",
    eligibleForUpdate: updateable,
    eligibleForMerge: false,
  };
}

function filePathEntries(files = []) {
  return (files || []).flatMap(file => {
    if (typeof file === "string") return [{ filename: file }];
    return file && typeof file === "object" ? [file] : [];
  });
}

function sensitivePaths(files, supplied = []) {
  const paths = [];
  const add = path => {
    if (typeof path === "string" && path && !paths.includes(path)) paths.push(path);
  };
  for (const file of filePathEntries(files)) {
    if (isAgentProtectedPath(file) ||
        (typeof file.filename === "string" && isRestrictedPath(file.filename)) ||
        (typeof file.previous_filename === "string" && isRestrictedPath(file.previous_filename))) {
      add(file.filename);
      add(file.previous_filename);
    }
  }
  for (const path of supplied || []) add(path);
  return paths;
}

function checkAppId(check) {
  return Number(check?.app?.id ?? check?.app_id ?? check?.appId);
}

function latestCheck(checks, name) {
  return checks.filter(check => check?.name === name)
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0];
}

function exactHeadGate(input = {}) {
  const failures = [];
  const liveHeadSha = input.liveHeadSha || input.pr?.head?.sha || input.headSha;
  const expectedHeadSha = input.expectedHeadSha || input.headSha || input.pr?.head?.sha;
  if (!SHA_RE.test(String(liveHeadSha || "")) ||
      (expectedHeadSha && !SHA_RE.test(String(expectedHeadSha)))) {
    failures.push("invalid-head-sha");
  } else if (expectedHeadSha && String(liveHeadSha).toLowerCase() !== String(expectedHeadSha).toLowerCase()) {
    failures.push("head-mismatch");
  }

  const files = input.changedFiles;
  const validFiles = Array.isArray(files) && files.every(file =>
    Boolean(file && typeof file === "object" && typeof file.filename === "string" && file.filename.length > 0));
  const complete = input.changedFilesComplete === true && validFiles &&
    Number.isInteger(input.changedFilesCount) && input.changedFilesCount >= 0 &&
    input.changedFilesCount === files.length;
  if (!complete) failures.push("changed-files-incomplete");

  if (input.mergeable !== true) failures.push("not-mergeable");
  if (["dirty", "behind", "blocked", "unknown"].includes(String(input.mergeableState || "").toLowerCase())) {
    failures.push("not-mergeable");
  }
  const baseAncestry = input.baseAncestry ?? input.isBaseAncestor ?? input.baseIsAncestor;
  if (baseAncestry !== true) failures.push("base-not-ancestor");
  const baseRef = input.baseRef || input.pr?.base?.ref;
  if (baseRef && baseRef !== "dev") failures.push("retargeted");
  const currentBaseSha = input.currentBaseSha || input.liveBaseSha;
  const expectedBaseSha = input.expectedBaseSha;
  if (!SHA_RE.test(String(currentBaseSha || "")) || !SHA_RE.test(String(expectedBaseSha || ""))) {
    failures.push("base-sha-invalid");
  } else if (currentBaseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
    failures.push("base-mismatch");
  }

  const checks = Array.isArray(input.checkRuns) ? input.checkRuns : [];
  const requested = input.requiredChecks || input.requiredCheckNames;
  const required = REQUIRED_CHECKS;
  if (requested && (!Array.isArray(requested) ||
      !REQUIRED_CHECKS.every(name => requested.includes(name)) ||
      requested.some(name => !KNOWN_CHECKS.has(name)))) {
    failures.push("required-checks-invalid");
  }
  const hasExpectedApps = input.expectedAppIds !== undefined;
  const expectedApps = hasExpectedApps && input.expectedAppIds && typeof input.expectedAppIds === "object" && !Array.isArray(input.expectedAppIds)
    ? input.expectedAppIds
    : {};
  for (const name of required) {
    const check = latestCheck(checks, name);
    if (!check) {
      failures.push("check-missing");
      continue;
    }
    if (check.head_sha !== liveHeadSha) {
      failures.push("check-not-exact-head");
      continue;
    }
    const expectedApp = hasExpectedApps
      ? expectedApps[name]
      : input.expectedAppId;
    if (!Number.isSafeInteger(Number(expectedApp)) || Number(expectedApp) <= 0) {
      failures.push("app-id-invalid");
      continue;
    }
    if (checkAppId(check) !== Number(expectedApp)) {
      failures.push("check-wrong-app");
      continue;
    }
    if (check.status !== "completed" || check.conclusion !== "success") failures.push("check-not-success");
  }

  const paths = sensitivePaths(files, input.sensitivePaths);
  const uniqueFailures = [...new Set(failures)];
  return {
    ok: uniqueFailures.length === 0,
    passed: uniqueFailures.length === 0,
    liveHeadSha,
    failures: uniqueFailures,
    changedFilesComplete: complete,
    mergeable: input.mergeable === true,
    baseAncestry: baseAncestry === true,
    sensitive: paths.length > 0,
    sensitivePaths: paths,
    safeForAutomation: uniqueFailures.length === 0 && paths.length === 0,
  };
}

function eventLabelName(event) {
  return event?.label?.name || event?.label_name || event?.name;
}

function eventAction(event) {
  return String(event?.event || event?.action || "").toLowerCase();
}

function eventHeadSha(event) {
  return event?.head_sha || event?.headSha || event?.pull_request?.head?.sha || null;
}

function approvalEvidence(input = {}) {
  const liveHeadSha = input.liveHeadSha || input.pr?.head?.sha;
  const labels = input.labels ?? input.pr?.labels;
  if (!SHA_RE.test(String(liveHeadSha || ""))) return { approved: false, ok: false, reason: "invalid-head-sha" };
  if (!Array.isArray(labels) || !labelsOf(labels).has("automerge-approved")) {
    return { approved: false, ok: false, reason: "label-absent" };
  }
  const events = (input.labelEvents || input.events || [])
    .filter(event => eventLabelName(event) === "automerge-approved")
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
  const latest = events[0];
  if (!latest || eventAction(latest) !== "labeled") return { approved: false, ok: false, reason: "latest-event-not-labeled" };
  const actor = latest.actor?.login || latest.user?.login;
  if (!actor || !maintainerLogins(input).has(actor.toLowerCase())) {
    return { approved: false, ok: false, reason: "actor-not-maintainer" };
  }
  const record = input.approvalRecord || input.approval;
  if (!record || record.headSha !== liveHeadSha ||
      !record.actor || String(record.actor).toLowerCase() !== actor.toLowerCase() ||
      Number(record.labeledEventId) !== Number(latest.id)) {
    return { approved: false, ok: false, reason: "approval-record-mismatch" };
  }
  const recordedEventId = record?.labeledEventId ?? record?.eventId;
  if (recordedEventId != null && Number(recordedEventId) !== Number(latest.id)) {
    return { approved: false, ok: false, reason: "approval-event-not-latest" };
  }
  const approvedHead = eventHeadSha(latest) || record?.headSha;
  if (String(approvedHead).toLowerCase() !== String(liveHeadSha).toLowerCase()) {
    return { approved: false, ok: false, reason: "approval-head-mismatch" };
  }
  return { approved: true, ok: true, reason: "maintainer-approved", actor, eventId: Number(latest.id), headSha: liveHeadSha };
}

function trustedSyncProvenance(input, pr) {
  const provenance = input.provenance || input.syncProvenance || {};
  return Boolean(
    provenance && provenance.trusted === true && provenance.authenticated === true &&
      ["deterministic-sync", "fork-upstream-sync"].includes(provenance.kind) &&
      typeof provenance.producerIdentity === "string" &&
      provenance.producerIdentity === input.expectedTrustedProducerIdentity,
  );
}

function botMergeEvidence(input = {}) {
  const universalGate = exactHeadGate(input);
  const pr = pullRequestOf(input);
  const classification = classifyPullRequest(input);
  if (input.pr) {
    const jules = autonomousMergeEvidence(input);
    const julesState = stateOf(input, pr);
    const julesClassificationAllowed = classification.class === "jules-terminal" &&
      julesState === "COMPLETED" && classification.sameRepository &&
      pr.state === "open" && !pr.draft && pr.base?.ref === "dev";
    if (jules.ready && julesClassificationAllowed && universalGate.ok && universalGate.safeForAutomation) {
      return { ...jules, source: "jules" };
    }
  }
  const gate = universalGate;
  const liveHeadSha = input.liveHeadSha || pr.head?.sha;
  const checks = input.checkRuns || [];
  const bugbot = exactHeadBugbotEvidence({
    checkRuns: checks,
    liveHeadSha,
    expectedAppId: input.expectedBugbotAppId,
  });
  const files = input.changedFiles || [];
  const paths = sensitivePaths(files, gate.sensitivePaths);
  const resolved = agentResolved(input, pr) || classification.class === "agent-resolved-sync";
  const ready = classification.class === "deterministic-sync" &&
    pr.state === "open" && pr.base?.ref === "dev" && !pr.draft &&
    trustedSyncProvenance(input, pr) && gate.ok && gate.safeForAutomation &&
    paths.length === 0 && !resolved && Boolean(bugbot);
  return {
    ready,
    source: ready ? "autonomous-sync" : null,
    bugbotEvidence: bugbot,
    sensitive: paths.length > 0,
    sensitivePaths: paths,
    reason: ready ? "deterministic-sync" : "sync-evidence-incomplete",
  };
}

function printable(value, max = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeAgedHolds(records = [], now = new Date().toISOString()) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  return records.flatMap(record => {
    const labels = new Set((record.labels || []).map(label => typeof label === "string" ? label : label?.name));
    const sinceMs = Date.parse(record.holdSince || record.updatedAt || record.createdAt || "");
    if (!labels.has("automation:hold") || !Number.isFinite(sinceMs) || nowMs - sinceMs < 24 * 60 * 60 * 1000) return [];
    return [{ number: Number(record.number), title: printable(record.title), ageHours: Math.floor((nowMs - sinceMs) / (60 * 60 * 1000)) }];
  });
}

function buildAutomationComment(input = {}) {
  const classification = input.classification || classifyPullRequest(input);
  const gate = input.exactHeadGate || input.headGate || {};
  const approval = input.approvalEvidence || input.approval || {};
  const merge = input.botMergeEvidence || input.mergeEvidence || {};
  const headSha = input.headSha || gate.liveHeadSha || input.pr?.head?.sha || "unknown";
  const baseSha = input.baseSha || input.pr?.base?.sha || "unknown";
  const failures = Array.isArray(gate.failures) && gate.failures.length ? gate.failures.join(", ") : "none";
  const sensitive = gate.sensitivePaths?.length ? gate.sensitivePaths.join(", ") : "none";
  const next = input.nextAction || (merge.ready ? "merge authorized by bot evidence" :
    classification.eligibleForUpdate ? "wait for exact-head checks" : "human review required");
  return [
    AUTOMATION_COMMENT_MARKER,
    "### PR automation (bot-owned)",
    `- Class: \`${printable(classification.class)}\` (${printable(classification.reason)})`,
    `- Base: \`${printable(baseSha)}\``,
    `- Head: \`${printable(headSha)}\``,
    `- Action: ${printable(input.action || "none")}`,
    `- Exact-head gate: **${gate.ok ? "PASS" : "BLOCKED"}**${gate.ok ? "" : ` (${printable(failures)})`}`,
    `- Sensitive paths: ${printable(sensitive)}`,
    `- Maintainer auto-merge approval: **${approval.approved ? "YES" : "NO"}**`,
    `- Bot merge evidence: **${merge.ready ? "YES" : "NO"}**${merge.source ? ` (${printable(merge.source)})` : ""}`,
    `- Next action: ${printable(next)}`,
  ].join("\n");
}

module.exports = {
  AUTOMATION_COMMENT_MARKER,
  REQUIRED_CHECKS,
  approvalEvidence,
  botMergeEvidence,
  buildAutomationComment,
  classifyPullRequest,
  exactHeadGate,
  summarizeAgedHolds,
};
