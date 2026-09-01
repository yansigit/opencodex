"use strict";

const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * HOUR_MS;
const MISSED_WINDOWS = 2;
const UPSTREAM_DETECTION_MS = 30 * 60 * 1000;
const UPSTREAM_BACKSTOP_MS = 26 * HOUR_MS;
const API_MAX_ATTEMPTS = 4;
const API_RETRY_BASE_MS = 250;
const API_RETRY_MAX_MS = 60 * 1000;
const API_REQUEST_TIMEOUT_MS = 15 * 1000;
const HEALTH_CHECK_DEADLINE_MS = 4 * 60 * 1000;

// The extra checker interval is deliberate: a six-hour checker can observe a
// missed cron window only on its next tick. The two-window portion is the SLO;
// the grace portion prevents an observation-boundary false positive.
const WORKFLOW_SPECS = Object.freeze({
  "fork-upstream-sync.yml": Object.freeze({ cadenceMs: 24 * HOUR_MS, event: null }),
  "pr-automation.yml": Object.freeze({ cadenceMs: 15 * 60 * 1000, event: null }),
  "agent-maintenance.yml": Object.freeze({ cadenceMs: 15 * 60 * 1000, event: null }),
  "ci.yml": Object.freeze({ cadenceMs: CHECK_INTERVAL_MS, event: "push" }),
});

const SYNC_BRANCH_RE = /^sync\/upstream-[A-Za-z0-9._-]+-[0-9a-f]{7,64}$/i;

function thresholdMs(spec) {
  return MISSED_WINDOWS * spec.cadenceMs + CHECK_INTERVAL_MS;
}

function asTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function checkedAt(value) {
  const time = asTime(value);
  if (time === null) throw new TypeError("now must be a valid date");
  return new Date(time).toISOString();
}

function hours(value) {
  return value === null ? null : Number((value / HOUR_MS).toFixed(1));
}

function runSortTime(run) {
  return asTime(run?.created_at) ?? asTime(run?.run_started_at) ?? asTime(run?.updated_at) ?? -1;
}

function selectLatestRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter(run => run && typeof run === "object")
    .slice()
    .sort((left, right) => runSortTime(right) - runSortTime(left) || Number(right.id || 0) - Number(left.id || 0))[0] || null;
}

function selectLatestSuccessfulRun(runs) {
  return selectLatestRun((Array.isArray(runs) ? runs : []).filter(run =>
    run?.status === "completed" && run?.conclusion === "success"));
}

function selectOldestRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter(run => run && typeof run === "object")
    .slice()
    .sort((left, right) => runSortTime(left) - runSortTime(right) || Number(left.id || 0) - Number(right.id || 0))[0] || null;
}

function runObservationTime(run) {
  return asTime(run?.updated_at) ?? asTime(run?.completed_at) ?? asTime(run?.created_at) ?? asTime(run?.run_started_at);
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: Number.isSafeInteger(Number(run.id)) ? Number(run.id) : null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    event: run.event ?? null,
    headSha: run.head_sha ?? null,
    createdAt: run.created_at ?? null,
    updatedAt: run.updated_at ?? null,
  };
}

function evaluateWorkflowSignal({ runs, now, spec, label }) {
  const nowMs = asTime(now);
  if (nowMs === null) throw new TypeError("now must be a valid date");
  const latest = selectLatestRun(runs);
  const latestSuccess = selectLatestSuccessfulRun(runs);
  const oldest = selectOldestRun(runs);
  const limit = thresholdMs(spec);
  const observed = runObservationTime(latest);
  const ageMs = observed === null ? null : Math.max(0, nowMs - observed);
  const successObserved = runObservationTime(latestSuccess);
  const successAgeMs = successObserved === null ? null : Math.max(0, nowMs - successObserved);
  const oldestObserved = runObservationTime(oldest);
  const oldestAgeMs = oldestObserved === null ? null : Math.max(0, nowMs - oldestObserved);
  const successful = latest?.status === "completed" && latest?.conclusion === "success";
  let status = "healthy";
  let reason = "latest run completed successfully within the SLO window";

  if (!latest) {
    status = "alert";
    reason = "no run observed; absence exceeds two expected schedule windows";
  } else if (ageMs === null) {
    status = "alert";
    reason = "latest run has no usable timestamp; freshness cannot be established";
  } else if (successful && ageMs > limit) {
    status = "alert";
    reason = "latest successful run is older than two expected schedule windows";
  } else if (!successful) {
    const failureWindowAge = successAgeMs ?? oldestAgeMs;
    if (failureWindowAge !== null && failureWindowAge > limit) {
      status = "alert";
      reason = latestSuccess
        ? "no successful run within two expected schedule windows"
        : "workflow has never succeeded and failures span two expected schedule windows";
    } else {
      status = "warning";
      reason = `latest run is ${latest.status || "unknown"}/${latest.conclusion || "incomplete"}; waiting for two missed windows before alerting`;
    }
  }

  return {
    status,
    workflow: label,
    cadenceHours: Number((spec.cadenceMs / HOUR_MS).toFixed(2)),
    missedWindows: MISSED_WINDOWS,
    thresholdHours: hours(limit),
    ageHours: hours(ageMs),
    lastSuccessAgeHours: hours(successAgeMs),
    latestRun: summarizeRun(latest),
    latestSuccessfulRun: summarizeRun(latestSuccess),
    reason,
  };
}

function evaluateCiBranch({ runs, branch, sha, now }) {
  const spec = WORKFLOW_SPECS["ci.yml"];
  const signal = evaluateWorkflowSignal({ runs, now, spec, label: `ci.yml:${branch}` });
  const latest = selectLatestRun(runs);
  const matchesTip = Boolean(sha && latest?.head_sha === sha);
  const exactSuccess = matchesTip && latest?.status === "completed" && latest?.conclusion === "success";

  if (sha === null || sha === undefined) {
    return {
      ...signal,
      status: "alert",
      tipSha: null,
      matchesTip: false,
      reason: `branch ${branch} SHA could not be read`,
    };
  }
  if (exactSuccess) {
    return {
      ...signal,
      status: "healthy",
      tipSha: sha,
      matchesTip: true,
      reason: `latest successful CI run covers ${branch} tip`,
    };
  }
  if (signal.status === "healthy") {
    return {
      ...signal,
      status: "warning",
      tipSha: sha,
      matchesTip,
      reason: `latest CI run does not cover the current ${branch} tip; waiting for two missed windows before alerting`,
    };
  }
  return {
    ...signal,
    tipSha: sha,
    matchesTip,
    reason: `${signal.reason}; current ${branch} tip is not covered by a successful CI run`,
  };
}

function evaluateCiFreshness({ runsByBranch, branchShas, now }) {
  const branches = {};
  for (const branch of ["dev", "main"]) {
    branches[branch] = evaluateCiBranch({
      runs: runsByBranch?.[branch],
      branch,
      sha: branchShas?.[branch] ?? null,
      now,
    });
  }
  return {
    status: Object.values(branches).some(signal => signal.status === "alert")
      ? "alert"
      : Object.values(branches).some(signal => signal.status === "warning")
        ? "warning"
        : "healthy",
    workflow: "ci.yml",
    cadenceHours: Number((CHECK_INTERVAL_MS / HOUR_MS).toFixed(2)),
    missedWindows: MISSED_WINDOWS,
    thresholdHours: hours(thresholdMs(WORKFLOW_SPECS["ci.yml"])),
    branches,
  };
}

function shaRelation({ branchShas, compare }) {
  const dev = branchShas?.dev ?? null;
  const main = branchShas?.main ?? null;
  const status = compare?.status || (dev && main ? (dev === main ? "identical" : "different") : "unknown");
  return {
    dev,
    main,
    status,
    aheadBy: Number.isInteger(compare?.ahead_by) ? compare.ahead_by : null,
    behindBy: Number.isInteger(compare?.behind_by) ? compare.behind_by : null,
    mergeBaseSha: compare?.merge_base_commit?.sha ?? null,
  };
}

function evaluateUpstreamSync({ release, tagSha, vendorMainSha, now }) {
  const nowMs = asTime(now);
  if (nowMs === null) throw new TypeError("now must be a valid date");
  const publishedAt = release?.published_at ?? release?.created_at ?? null;
  const publishedMs = asTime(publishedAt);
  const ageMs = publishedMs === null ? null : Math.max(0, nowMs - publishedMs);
  const tag = typeof release?.tag_name === "string" ? release.tag_name : null;
  const validSha = value => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
  if (!tag || !validSha(tagSha) || !validSha(vendorMainSha) || ageMs === null) {
    return {
      status: "alert",
      latestTag: tag,
      latestTagSha: validSha(tagSha) ? tagSha : null,
      vendorMainSha: validSha(vendorMainSha) ? vendorMainSha : null,
      releaseAgeHours: hours(ageMs),
      reason: "latest stable upstream release provenance could not be established",
    };
  }
  if (tagSha === vendorMainSha) {
    return {
      status: "healthy",
      latestTag: tag,
      latestTagSha: tagSha,
      vendorMainSha,
      releaseAgeHours: hours(ageMs),
      reason: "vendor/main matches the latest stable upstream release",
    };
  }
  return {
    status: ageMs > UPSTREAM_BACKSTOP_MS ? "alert" : "warning",
    latestTag: tag,
    latestTagSha: tagSha,
    vendorMainSha,
    releaseAgeHours: hours(ageMs),
    detectionTargetMinutes: UPSTREAM_DETECTION_MS / 60_000,
    backstopHours: UPSTREAM_BACKSTOP_MS / HOUR_MS,
    reason: ageMs <= UPSTREAM_DETECTION_MS
      ? "new stable upstream release is inside the detection target"
      : ageMs <= UPSTREAM_BACKSTOP_MS
        ? "fork is behind the latest stable upstream release; sync is inside the hard backstop"
        : "fork remained behind the latest stable upstream release beyond the hard backstop",
  };
}

function sameRepository(pr, repository) {
  const headRepository = pr?.head?.repo?.full_name;
  return Boolean(repository && headRepository && headRepository.toLowerCase() === repository.toLowerCase());
}

function pullRequestSummary(pr) {
  return {
    number: Number.isSafeInteger(Number(pr.number)) ? Number(pr.number) : null,
    title: pr.title ?? null,
    draft: pr.draft === true,
    base: pr.base?.ref ?? null,
    head: pr.head?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    updatedAt: pr.updated_at ?? null,
  };
}

function sortPullRequests(prs) {
  return prs.slice().sort((left, right) => Number(left.number || 0) - Number(right.number || 0));
}

function openPromotionSyncPrs({ pullRequests, repository }) {
  const open = (Array.isArray(pullRequests) ? pullRequests : []).filter(pr =>
    (!pr.state || pr.state === "open") && sameRepository(pr, repository));
  const promotions = sortPullRequests(open.filter(pr => pr.base?.ref === "main" && pr.head?.ref === "dev"));
  const syncs = sortPullRequests(open.filter(pr => pr.base?.ref === "dev" && SYNC_BRANCH_RE.test(pr.head?.ref || "")));
  return {
    promotion: { count: promotions.length, prs: promotions.map(pullRequestSummary) },
    sync: { count: syncs.length, prs: syncs.map(pullRequestSummary) },
  };
}

function evaluateRepositoryState({ relation, prs }) {
  const relationHealthy = relation.status === "ahead" || relation.status === "identical";
  const duplicatePrs = prs.promotion.count > 1 || prs.sync.count > 1;
  return {
    status: relationHealthy && !duplicatePrs ? "healthy" : "alert",
    reason: !relationHealthy
      ? `dev/main relation is ${relation.status}; dev must contain main`
      : duplicatePrs
        ? "multiple open promotion or sync PRs violate controller uniqueness"
        : "branch relation and controller PR uniqueness are healthy",
  };
}

function overallStatus(signals) {
  const values = Object.values(signals);
  if (values.some(signal => signal.status === "alert")) return "alert";
  if (values.some(signal => signal.status === "warning")) return "warning";
  return "ok";
}

function evaluateHealth({ now, workflowRuns, ciRuns, branchShas, compare, pullRequests, repository, upstream }) {
  const at = checkedAt(now);
  const atMs = asTime(at);
  const workflowSignals = {};
  for (const [workflow, spec] of Object.entries(WORKFLOW_SPECS)) {
    if (workflow === "ci.yml") continue;
    workflowSignals[workflow] = evaluateWorkflowSignal({
      runs: workflowRuns?.[workflow],
      now: atMs,
      spec,
      label: workflow,
    });
  }
  workflowSignals["ci.yml"] = evaluateCiFreshness({
    runsByBranch: ciRuns,
    branchShas,
    now: atMs,
  });

  const relation = shaRelation({ branchShas, compare });
  const prs = openPromotionSyncPrs({ pullRequests, repository });
  const repositoryState = evaluateRepositoryState({ relation, prs });
  const upstreamSync = upstream ? evaluateUpstreamSync({ ...upstream, now: atMs }) : null;
  return {
    status: overallStatus({ ...workflowSignals, repositoryState, ...(upstreamSync ? { upstreamSync } : {}) }),
    checkedAt: at,
    workflowSignals,
    shaRelation: relation,
    repositoryState,
    upstreamSync,
    openPromotionSyncPrs: prs,
  };
}

function apiBaseUrl(value) {
  if (value) return String(value).replace(/\/$/, "");
  return "https://api.github.com";
}

function queryString(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)).toString();
}

function retryableStatus(response) {
  if (!response) return true;
  if (response.status === 408 || response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  return response.headers?.get?.("retry-after") != null
    || response.headers?.get?.("x-ratelimit-remaining") === "0";
}

function retryDelayMs(response, attempt, now = Date.now()) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, Date.parse(retryAfter) - now);
    if (Number.isFinite(requested)) return Math.max(0, requested);
  }
  if (response?.headers?.get?.("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(response.headers?.get?.("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds)) return Math.max(0, resetSeconds * 1000 - now);
    return API_RETRY_MAX_MS;
  }
  if (response?.status === 429) return API_RETRY_MAX_MS;
  return Math.min(API_RETRY_MAX_MS, API_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createGithubReader({
  token,
  apiUrl,
  fetchImpl = fetch,
  sleepImpl = sleep,
  nowImpl = Date.now,
  deadlineAt = nowImpl() + HEALTH_CHECK_DEADLINE_MS,
  signalFactory = timeoutMs => AbortSignal.timeout(timeoutMs),
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const base = apiBaseUrl(apiUrl);
  async function get(path) {
    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt += 1) {
      const remainingBeforeRequest = deadlineAt - nowImpl();
      if (remainingBeforeRequest <= 0) throw new Error(`GitHub API deadline exceeded for ${path}`);
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "opencodex-automation-health",
            "x-github-api-version": "2022-11-28",
          },
          signal: signalFactory(Math.min(API_REQUEST_TIMEOUT_MS, remainingBeforeRequest)),
        });
        if (response.ok) return await response.json();
      } catch (error) {
        if (attempt === API_MAX_ATTEMPTS) {
          throw new Error(`GitHub API GET failed after ${attempt} attempts for ${path}`, { cause: error });
        }
        const delay = retryDelayMs(null, attempt, nowImpl());
        if (delay >= deadlineAt - nowImpl()) throw new Error(`GitHub API retry deadline exceeded for ${path}`, { cause: error });
        await sleepImpl(delay);
        continue;
      }

      if (!retryableStatus(response) || attempt === API_MAX_ATTEMPTS) {
        const suffix = attempt > 1 ? ` after ${attempt} attempts` : "";
        throw new Error(`GitHub API GET ${response.status}${suffix} for ${path}`);
      }
      const delay = retryDelayMs(response, attempt, nowImpl());
      if (delay > API_RETRY_MAX_MS || delay >= deadlineAt - nowImpl()) {
        throw new Error(`GitHub API GET ${response.status}; retry delay exceeds health-check budget for ${path}`);
      }
      await sleepImpl(delay);
    }
    throw new Error(`GitHub API GET exhausted retries for ${path}`);
  }
  return { get };
}

async function listWorkflowRuns(reader, repository, workflow, branch, event, { now, spec }) {
  const nowMs = asTime(now);
  if (nowMs === null) throw new TypeError("now must be a valid date");
  const cutoff = nowMs - thresholdMs(spec);
  const runs = [];
  for (let page = 1; ; page += 1) {
    const query = queryString({ branch, event, per_page: 100, page });
    const data = await reader.get(`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`);
    const batch = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    runs.push(...batch);
    if (batch.length < 100) break;
    const oldest = selectOldestRun(batch);
    if (oldest && runSortTime(oldest) <= cutoff) break;
  }
  return runs;
}

async function readBranch(reader, repository, branch) {
  const data = await reader.get(`/repos/${repository}/branches/${encodeURIComponent(branch)}`);
  return data?.commit?.sha ?? null;
}

async function readCompare(reader, repository) {
  return reader.get(`/repos/${repository}/compare/${encodeURIComponent("main...dev")}`);
}

async function readTagCommit(reader, repository, tag) {
  const ref = await reader.get(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref?.object;
  for (let depth = 0; depth < 5 && object?.type === "tag"; depth += 1) {
    const annotated = await reader.get(`/repos/${repository}/git/tags/${encodeURIComponent(object.sha)}`);
    object = annotated?.object;
  }
  return object?.type === "commit" ? object.sha ?? null : null;
}

async function listOpenPullRequests(reader, repository, { maxPages = 10 } = {}) {
  const result = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const query = queryString({ state: "open", per_page: 100, page });
    const data = await reader.get(`/repos/${repository}/pulls?${query}`);
    if (!Array.isArray(data)) throw new Error(`GitHub API returned a malformed open pull-request page ${page}`);
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw new Error(`Open pull-request listing exceeds the ${maxPages}-page safety limit`);
}

async function runHealthCheck({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  now = new Date(),
  fetchImpl = fetch,
  upstreamRepository = process.env.FORK_SYNC_UPSTREAM_REPOSITORY || "lidge-jun/opencodex",
} = {}) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const reader = createGithubReader({ token, apiUrl, fetchImpl });
  const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH || "main";
  const workflows = Object.entries(WORKFLOW_SPECS);
  if (!/^[^/]+\/[^/]+$/.test(upstreamRepository)) throw new Error("upstream repository must be owner/name");
  const [workflowResults, devRuns, mainRuns, devSha, mainSha, vendorMainSha, compare, pullRequests, release] = await Promise.all([
    Promise.all(workflows
      .filter(([workflow]) => workflow !== "ci.yml")
      .map(async ([workflow, spec]) => [workflow, await listWorkflowRuns(reader, repository, workflow, defaultBranch, spec.event, { now, spec })])),
    listWorkflowRuns(reader, repository, "ci.yml", "dev", "push", { now, spec: WORKFLOW_SPECS["ci.yml"] }),
    listWorkflowRuns(reader, repository, "ci.yml", "main", "push", { now, spec: WORKFLOW_SPECS["ci.yml"] }),
    readBranch(reader, repository, "dev"),
    readBranch(reader, repository, "main"),
    readBranch(reader, repository, "vendor/main"),
    readCompare(reader, repository),
    listOpenPullRequests(reader, repository),
    reader.get(`/repos/${upstreamRepository}/releases/latest`),
  ]);
  const tagSha = await readTagCommit(reader, upstreamRepository, release?.tag_name);
  return evaluateHealth({
    now,
    repository,
    workflowRuns: Object.fromEntries(workflowResults),
    ciRuns: { dev: devRuns, main: mainRuns },
    branchShas: { dev: devSha, main: mainSha },
    compare,
    pullRequests,
    upstream: { release, tagSha, vendorMainSha },
  });
}

async function main() {
  const at = new Date().toISOString();
  try {
    const result = await runHealthCheck({ now: at });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "alert") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "error",
      checkedAt: at,
      workflowSignals: null,
      shaRelation: null,
      repositoryState: null,
      upstreamSync: null,
      openPromotionSyncPrs: null,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  API_MAX_ATTEMPTS,
  API_RETRY_BASE_MS,
  API_RETRY_MAX_MS,
  API_REQUEST_TIMEOUT_MS,
  CHECK_INTERVAL_MS,
  HEALTH_CHECK_DEADLINE_MS,
  MISSED_WINDOWS,
  UPSTREAM_BACKSTOP_MS,
  UPSTREAM_DETECTION_MS,
  SYNC_BRANCH_RE,
  WORKFLOW_SPECS,
  createGithubReader,
  evaluateCiFreshness,
  evaluateHealth,
  evaluateRepositoryState,
  evaluateUpstreamSync,
  evaluateWorkflowSignal,
  listOpenPullRequests,
  listWorkflowRuns,
  openPromotionSyncPrs,
  selectLatestRun,
  selectLatestSuccessfulRun,
  shaRelation,
  thresholdMs,
};

if (require.main === module) void main();
