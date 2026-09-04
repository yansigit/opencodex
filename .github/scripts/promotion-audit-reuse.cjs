"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const API_TIMEOUT_MS = 5_000;
const AUDIT_STEP = "Dependency audit (high severity)";
const PROOF_PATHS = [
  ".github/scripts/promotion-audit-reuse.cjs",
  ".github/workflows/ci.yml",
  ".github/actions/setup-project-bun/action.yml",
  "scripts/ci/audit-high.ts",
];

function auditEvidenceArtifactName(pull, tree) {
  return `dependency-audit-pr-${pull.number}-base-${pull.base.sha}-head-${pull.head.sha}-tree-${tree}`;
}

function matchingPromotion({
  repository,
  beforeSha,
  headSha,
  parents,
  headTree,
  promotedTree,
  pulls,
}) {
  if (
    !SHA_RE.test(beforeSha) ||
    !SHA_RE.test(headSha) ||
    parents.length !== 2 ||
    parents[0] !== beforeSha ||
    !SHA_RE.test(parents[1]) ||
    headTree !== promotedTree
  ) {
    return undefined;
  }

  const candidates = pulls.filter((pull) =>
    pull?.state === "closed" &&
    typeof pull?.merged_at === "string" &&
    pull?.merge_commit_sha === headSha &&
    pull?.base?.ref === "main" &&
    pull?.base?.sha === beforeSha &&
    pull?.base?.repo?.full_name === repository &&
    pull?.head?.ref === "dev" &&
    pull?.head?.sha === parents[1] &&
    pull?.head?.repo?.full_name === repository
  );

  return candidates.length === 1 ? candidates[0] : undefined;
}

function hasFreshAuditEvidence({ promotionPull, promotedSha, promotedTree, runs, jobsByRun, artifactsByRun, nowMs }) {
  const evidenceArtifact = auditEvidenceArtifactName(promotionPull, promotedTree);
  return runs.some((run) => {
    if (
      run?.event !== "pull_request" ||
      run?.head_sha !== promotedSha ||
      run?.status !== "completed"
    ) {
      return false;
    }

    return (jobsByRun.get(run.id) ?? []).some((job) => {
      if (job?.name !== "gates" || job?.conclusion !== "success") return false;
      const auditSucceeded = (job.steps ?? []).some((step) => {
        if (step?.name !== AUDIT_STEP || step?.conclusion !== "success") return false;
        const completedAt = Date.parse(step.completed_at ?? "");
        return Number.isFinite(completedAt) &&
          completedAt <= nowMs &&
          nowMs - completedAt <= MAX_EVIDENCE_AGE_MS;
      });
      const artifact = (artifactsByRun.get(run.id) ?? []).find((candidate) =>
        candidate?.name === evidenceArtifact && candidate?.expired === false
      );
      const artifactCreatedAt = Date.parse(artifact?.created_at ?? "");
      const artifactIsFresh = Number.isFinite(artifactCreatedAt) &&
        artifactCreatedAt <= nowMs &&
        nowMs - artifactCreatedAt <= MAX_EVIDENCE_AGE_MS;
      return auditSucceeded && artifactIsFresh;
    });
  });
}

function decidePromotionAuditReuse(input) {
  if (input.dependenciesChanged !== true) {
    return { reuse: false, reason: "dependency graph unchanged" };
  }
  if (input.eventName !== "push" || input.refName !== "main") {
    return { reuse: false, reason: "not a main push" };
  }
  if (input.proofChanged) {
    return { reuse: false, reason: "audit proof implementation changed" };
  }

  const pull = matchingPromotion(input);
  if (!pull) {
    return { reuse: false, reason: "main commit is not one exact same-repository dev promotion" };
  }
  if (!hasFreshAuditEvidence({
    promotionPull: pull,
    promotedSha: input.parents[1],
    promotedTree: input.promotedTree,
    runs: input.runs,
    jobsByRun: input.jobsByRun,
    artifactsByRun: input.artifactsByRun,
    nowMs: input.nowMs,
  })) {
    return { reuse: false, reason: "no fresh successful promotion audit step" };
  }

  return { reuse: true, reason: `promotion PR #${pull.number} already passed the exact audit step` };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function proofImplementationChanged(beforeSha, promotedSha) {
  const diff = spawnSync("git", ["diff", "--quiet", beforeSha, promotedSha, "--", ...PROOF_PATHS]);
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(diff.stderr?.toString().trim() || "could not compare audit proof paths");
  }
  if (diff.status === 1) return true;

  const scriptAt = (sha) => {
    const pkg = JSON.parse(git(["show", `${sha}:package.json`]));
    return pkg?.scripts?.["audit:high"];
  };
  return scriptAt(beforeSha) !== scriptAt(promotedSha);
}

async function githubJson(path, token, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("GitHub API request timed out")), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencodex-promotion-audit-verifier",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    // Keep the deadline armed until the response body is consumed. A server
    // can send headers and then stall the JSON body indefinitely.
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveReuseFromEnvironment(env = process.env) {
  const base = {
    dependenciesChanged: env.DEPENDENCIES_CHANGED === "true",
    eventName: env.GITHUB_EVENT_NAME ?? "",
    refName: env.GITHUB_REF_NAME ?? "",
  };
  if (!base.dependenciesChanged || base.eventName !== "push" || base.refName !== "main") {
    return decidePromotionAuditReuse({ ...base });
  }

  const repository = env.GITHUB_REPOSITORY ?? "";
  const beforeSha = env.BEFORE_SHA ?? "";
  const headSha = env.GITHUB_SHA ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  if (!repository || !token || !SHA_RE.test(beforeSha) || !SHA_RE.test(headSha)) {
    return { reuse: false, reason: "promotion environment is incomplete" };
  }

  const parents = git(["show", "-s", "--format=%P", headSha]).split(/\s+/).filter(Boolean);
  const promotedSha = parents[1] ?? "";
  const headTree = git(["rev-parse", `${headSha}^{tree}`]);
  const promotedTree = SHA_RE.test(promotedSha)
    ? git(["rev-parse", `${promotedSha}^{tree}`])
    : "";
  const proofChanged = SHA_RE.test(promotedSha)
    ? proofImplementationChanged(beforeSha, promotedSha)
    : true;

  const pulls = await githubJson(`/repos/${repository}/commits/${headSha}/pulls?per_page=100`, token);
  if (!Array.isArray(pulls) || pulls.length >= 100) {
    return { reuse: false, reason: "promotion PR associations are missing or truncated" };
  }
  const runsResponse = await githubJson(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${promotedSha}&per_page=10`,
    token,
  );
  const runs = Array.isArray(runsResponse?.workflow_runs) ? runsResponse.workflow_runs : [];
  const jobsByRun = new Map();
  const artifactsByRun = new Map();
  for (const run of runs) {
    if (!Number.isInteger(run?.id)) continue;
    const jobsResponse = await githubJson(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`, token);
    const jobs = Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs : [];
    if (jobsResponse?.total_count !== jobs.length || jobs.length >= 100) continue;
    const artifactsResponse = await githubJson(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, token);
    const artifacts = Array.isArray(artifactsResponse?.artifacts) ? artifactsResponse.artifacts : [];
    if (artifactsResponse?.total_count !== artifacts.length || artifacts.length >= 100) continue;
    jobsByRun.set(run.id, jobs);
    artifactsByRun.set(run.id, artifacts);
  }

  return decidePromotionAuditReuse({
    ...base,
    repository,
    beforeSha,
    headSha,
    parents,
    headTree,
    promotedTree,
    proofChanged,
    pulls,
    runs,
    jobsByRun,
    artifactsByRun,
    nowMs: Date.now(),
  });
}

async function main() {
  let decision;
  try {
    decision = await resolveReuseFromEnvironment();
  } catch (error) {
    decision = { reuse: false, reason: `verification unavailable: ${error.message}` };
  }

  const output = `reuse=${decision.reuse ? "true" : "false"}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  const annotation = decision.reuse ? "notice" : "warning";
  console.log(`::${annotation}::Dependency audit reuse: ${decision.reason}`);
}

if (require.main === module) main();

module.exports = {
  AUDIT_STEP,
  API_TIMEOUT_MS,
  MAX_EVIDENCE_AGE_MS,
  auditEvidenceArtifactName,
  decidePromotionAuditReuse,
  hasFreshAuditEvidence,
  githubJson,
  matchingPromotion,
};
