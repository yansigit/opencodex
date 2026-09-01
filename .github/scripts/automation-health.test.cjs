"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const {
  API_MAX_ATTEMPTS,
  API_RETRY_BASE_MS,
  API_RETRY_MAX_MS,
  API_REQUEST_TIMEOUT_MS,
  CHECK_INTERVAL_MS,
  HEALTH_CHECK_DEADLINE_MS,
  MISSED_WINDOWS,
  UPSTREAM_BACKSTOP_MS,
  UPSTREAM_DETECTION_MS,
  WORKFLOW_SPECS,
  createGithubReader,
  evaluateHealth,
  evaluateRepositoryState,
  evaluateUpstreamSync,
  listWorkflowRuns,
  listOpenPullRequests,
  openPromotionSyncPrs,
  selectLatestRun,
  selectLatestSuccessfulRun,
  thresholdMs,
} = require("./automation-health.cjs");

const NOW = "2026-09-01T12:00:00.000Z";
const SHA_DEV = "d".repeat(40);
const SHA_MAIN = "m".repeat(40);

function run({ id, createdAt, updatedAt = createdAt, status = "completed", conclusion = "success", headSha = SHA_DEV } = {}) {
  return { id, created_at: createdAt, updated_at: updatedAt, status, conclusion, head_sha: headSha };
}

function healthyRuns() {
  return {
    "fork-upstream-sync.yml": [run({ id: 1, createdAt: "2026-09-01T06:17:00.000Z" })],
    "pr-automation.yml": [run({ id: 2, createdAt: "2026-09-01T11:59:00.000Z" })],
    "agent-maintenance.yml": [run({ id: 3, createdAt: "2026-09-01T11:58:00.000Z" })],
  };
}

describe("automation health SLO checker", () => {
  it("retries transient GitHub API failures with bounded exponential backoff", async () => {
    const waits = [];
    let calls = 0;
    const reader = createGithubReader({
      token: "test-token",
      apiUrl: "https://api.github.test",
      sleepImpl: async ms => waits.push(ms),
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.headers.authorization, "Bearer test-token");
        if (calls < 3) {
          return { ok: false, status: 502, headers: { get: () => null } };
        }
        return { ok: true, status: 200, json: async () => ({ healthy: true }) };
      },
    });

    assert.deepEqual(await reader.get("/health"), { healthy: true });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [API_RETRY_BASE_MS, API_RETRY_BASE_MS * 2]);
    assert.equal(API_MAX_ATTEMPTS, 4);
    assert.equal(API_RETRY_MAX_MS, 60_000);
  });

  it("honors Retry-After for rate limiting without retrying permanent failures", async () => {
    const waits = [];
    let rateLimitCalls = 0;
    const rateLimited = createGithubReader({
      token: "test-token",
      sleepImpl: async ms => waits.push(ms),
      fetchImpl: async () => {
        rateLimitCalls += 1;
        if (rateLimitCalls === 1) {
          return { ok: false, status: 429, headers: { get: name => name === "retry-after" ? "2" : null } };
        }
        return { ok: true, status: 200, json: async () => ({ recovered: true }) };
      },
    });
    assert.deepEqual(await rateLimited.get("/rate-limited"), { recovered: true });
    assert.deepEqual(waits, [2_000]);

    let permanentCalls = 0;
    const permanent = createGithubReader({
      token: "test-token",
      sleepImpl: async () => assert.fail("permanent failures must not sleep"),
      fetchImpl: async () => {
        permanentCalls += 1;
        return { ok: false, status: 403 };
      },
    });
    await assert.rejects(permanent.get("/forbidden"), /GitHub API GET 403 for \/forbidden/);
    assert.equal(permanentCalls, 1);
  });

  it("honors primary rate-limit reset and fails closed when it exceeds the deadline", async () => {
    const now = 1_788_292_800_000;
    const waits = [];
    let calls = 0;
    const reader = createGithubReader({
      token: "test-token",
      nowImpl: () => now,
      deadlineAt: now + HEALTH_CHECK_DEADLINE_MS,
      sleepImpl: async ms => waits.push(ms),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            headers: { get: name => name === "x-ratelimit-remaining" ? "0" : name === "x-ratelimit-reset" ? String(now / 1000 + 30) : null },
          };
        }
        return { ok: true, status: 200, json: async () => ({ recovered: true }) };
      },
    });
    assert.deepEqual(await reader.get("/primary-limit"), { recovered: true });
    assert.deepEqual(waits, [30_000]);

    const overBudget = createGithubReader({
      token: "test-token",
      nowImpl: () => now,
      deadlineAt: now + HEALTH_CHECK_DEADLINE_MS,
      sleepImpl: async () => assert.fail("an over-budget reset must not sleep"),
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: { get: name => name === "x-ratelimit-remaining" ? "0" : name === "x-ratelimit-reset" ? String(now / 1000 + 120) : null },
      }),
    });
    await assert.rejects(overBudget.get("/primary-limit"), /retry delay exceeds health-check budget/);
  });

  it("bounds each fetch and the complete GitHub read window", async () => {
    const now = 1_788_292_800_000;
    const timeouts = [];
    const reader = createGithubReader({
      token: "test-token",
      nowImpl: () => now,
      deadlineAt: now + 1_000,
      signalFactory: timeoutMs => {
        timeouts.push(timeoutMs);
        return { timeoutMs };
      },
      fetchImpl: async (_url, options) => {
        assert.deepEqual(options.signal, { timeoutMs: 1_000 });
        return { ok: true, status: 200, json: async () => ({ bounded: true }) };
      },
    });
    assert.deepEqual(await reader.get("/bounded"), { bounded: true });
    assert.deepEqual(timeouts, [1_000]);
    assert.equal(API_REQUEST_TIMEOUT_MS, 15_000);

    const expired = createGithubReader({
      token: "test-token",
      nowImpl: () => now,
      deadlineAt: now,
      fetchImpl: async () => assert.fail("an expired reader must not fetch"),
    });
    await assert.rejects(expired.get("/expired"), /GitHub API deadline exceeded/);
  });

  it("fails closed on malformed or truncated pull-request pagination", async () => {
    await assert.rejects(
      listOpenPullRequests({ get: async () => ({ items: [] }) }, "yansigit/opencodex"),
      /malformed open pull-request page 1/,
    );

    const calls = [];
    await assert.rejects(
      listOpenPullRequests({
        async get(pathname) {
          calls.push(pathname);
          return Array.from({ length: 100 }, (_, number) => ({ number }));
        },
      }, "yansigit/opencodex", { maxPages: 2 }),
      /exceeds the 2-page safety limit/,
    );
    assert.equal(calls.length, 2);
  });

  it("encodes two missed windows plus one six-hour observation grace interval", () => {
    assert.equal(MISSED_WINDOWS, 2);
    assert.equal(thresholdMs(WORKFLOW_SPECS["fork-upstream-sync.yml"]), 54 * 60 * 60 * 1000);
    assert.equal(thresholdMs(WORKFLOW_SPECS["pr-automation.yml"]), 6.5 * 60 * 60 * 1000);
    assert.equal(thresholdMs(WORKFLOW_SPECS["ci.yml"]), 18 * 60 * 60 * 1000);
    assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
    assert.equal(UPSTREAM_DETECTION_MS, 30 * 60 * 1000);
    assert.equal(UPSTREAM_BACKSTOP_MS, 26 * 60 * 60 * 1000);
  });

  it("validates the pinned vendor SHA against the latest stable upstream release", () => {
    const latestTagSha = "a".repeat(40);
    assert.equal(evaluateUpstreamSync({
      now: NOW,
      release: { tag_name: "v2.40.0", published_at: "2026-09-01T11:50:00.000Z" },
      tagSha: latestTagSha,
      vendorMainSha: "b".repeat(40),
    }).status, "warning");
    assert.equal(evaluateUpstreamSync({
      now: NOW,
      release: { tag_name: "v2.40.0", published_at: "2026-08-30T00:00:00.000Z" },
      tagSha: latestTagSha,
      vendorMainSha: "b".repeat(40),
    }).status, "alert");
    assert.equal(evaluateUpstreamSync({
      now: NOW,
      release: { tag_name: "v2.40.0", published_at: "2026-08-30T00:00:00.000Z" },
      tagSha: latestTagSha,
      vendorMainSha: latestTagSha,
    }).status, "healthy");
  });

  it("selects the newest run without depending on API response order", () => {
    const older = run({ id: 9, createdAt: "2026-09-01T10:00:00.000Z" });
    const newer = run({ id: 8, createdAt: "2026-09-01T11:00:00.000Z" });
    assert.equal(selectLatestRun([newer, older]).id, 8);
    assert.equal(selectLatestSuccessfulRun([
      { ...newer, conclusion: "failure" },
      older,
    ]).id, 9);
  });

  it("stays warning-level for a recent failed run and alerts after two missed windows", () => {
    const recentFailure = evaluateHealth({
      now: NOW,
      workflowRuns: { ...healthyRuns(), "pr-automation.yml": [run({ id: 4, createdAt: "2026-09-01T11:59:00.000Z", conclusion: "failure" })] },
      ciRuns: { dev: [run({ id: 5, createdAt: NOW, headSha: SHA_DEV })], main: [run({ id: 6, createdAt: NOW, headSha: SHA_MAIN })] },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(recentFailure.status, "warning");
    assert.equal(recentFailure.workflowSignals["pr-automation.yml"].status, "warning");

    const oldFailure = evaluateHealth({
      now: NOW,
      workflowRuns: { ...healthyRuns(), "fork-upstream-sync.yml": [run({ id: 7, createdAt: "2026-06-30T00:00:00.000Z", conclusion: "failure" })] },
      ciRuns: { dev: [run({ id: 8, createdAt: NOW, headSha: SHA_DEV })], main: [run({ id: 9, createdAt: NOW, headSha: SHA_MAIN })] },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(oldFailure.status, "alert");
    assert.equal(oldFailure.workflowSignals["fork-upstream-sync.yml"].status, "alert");
  });

  it("alerts on sustained failures even when the newest failed run is recent", () => {
    const result = evaluateHealth({
      now: NOW,
      workflowRuns: {
        ...healthyRuns(),
        "pr-automation.yml": [
          run({ id: 40, createdAt: "2026-09-01T11:59:00.000Z", conclusion: "failure" }),
          run({ id: 39, createdAt: "2026-09-01T11:44:00.000Z", conclusion: "failure" }),
          run({ id: 38, createdAt: "2026-09-01T04:00:00.000Z" }),
        ],
      },
      ciRuns: { dev: [run({ id: 41, createdAt: NOW, headSha: SHA_DEV })], main: [run({ id: 42, createdAt: NOW, headSha: SHA_MAIN })] },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(result.status, "alert");
    assert.equal(result.workflowSignals["pr-automation.yml"].status, "alert");
    assert.equal(result.workflowSignals["pr-automation.yml"].latestRun.id, 40);
    assert.equal(result.workflowSignals["pr-automation.yml"].latestSuccessfulRun.id, 38);
  });

  it("uses the oldest observed failure when no successful run exists", () => {
    const failures = Array.from({ length: 30 }, (_, index) => run({
      id: 100 - index,
      createdAt: new Date(Date.parse(NOW) - index * 15 * 60 * 1000).toISOString(),
      conclusion: "failure",
    }));
    const result = evaluateHealth({
      now: NOW,
      workflowRuns: { ...healthyRuns(), "pr-automation.yml": failures },
      ciRuns: { dev: [run({ id: 101, createdAt: NOW, headSha: SHA_DEV })], main: [run({ id: 102, createdAt: NOW, headSha: SHA_MAIN })] },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(result.workflowSignals["pr-automation.yml"].status, "alert");
    assert.equal(result.workflowSignals["pr-automation.yml"].latestSuccessfulRun, null);
  });

  it("paginates workflow runs until the complete SLO horizon is covered", async () => {
    const calls = [];
    const recent = Array.from({ length: 100 }, (_, index) => run({
      id: 200 - index,
      createdAt: new Date(Date.parse(NOW) - index * 60 * 1000).toISOString(),
      conclusion: "failure",
    }));
    const older = run({ id: 99, createdAt: "2026-09-01T04:00:00.000Z", conclusion: "failure" });
    const reader = {
      async get(pathname) {
        calls.push(pathname);
        return { workflow_runs: calls.length === 1 ? recent : [older] };
      },
    };
    const runs = await listWorkflowRuns(
      reader,
      "yansigit/opencodex",
      "pr-automation.yml",
      "main",
      null,
      { now: NOW, spec: WORKFLOW_SPECS["pr-automation.yml"] },
    );
    assert.equal(runs.length, 101);
    assert.match(calls[0], /per_page=100&page=1/);
    assert.match(calls[1], /per_page=100&page=2/);
  });

  it("requires successful exact-tip CI evidence for both dev and main", () => {
    const result = evaluateHealth({
      now: NOW,
      workflowRuns: healthyRuns(),
      ciRuns: {
        dev: [run({ id: 10, createdAt: NOW, headSha: SHA_DEV })],
        main: [run({ id: 11, createdAt: NOW, headSha: SHA_DEV })],
      },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(result.workflowSignals["ci.yml"].status, "warning");
    assert.equal(result.workflowSignals["ci.yml"].branches.dev.status, "healthy");
    assert.equal(result.workflowSignals["ci.yml"].branches.main.matchesTip, false);
  });

  it("reports absence as an alert and keeps the result deterministic", () => {
    const result = evaluateHealth({
      now: NOW,
      workflowRuns: {},
      ciRuns: { dev: [], main: [] },
      branchShas: { dev: SHA_DEV, main: SHA_MAIN },
      compare: { status: "ahead", ahead_by: 1, behind_by: 0 },
      pullRequests: [],
    });
    assert.equal(result.status, "alert");
    assert.equal(result.checkedAt, NOW);
    assert.equal(result.workflowSignals["agent-maintenance.yml"].latestRun, null);
  });

  it("summarizes only open same-repository promotion and sync PRs", () => {
    const result = openPromotionSyncPrs({
      repository: "yansigit/opencodex",
      pullRequests: [
        { number: 12, title: "promote", state: "open", base: { ref: "main" }, head: { ref: "dev", sha: SHA_DEV, repo: { full_name: "yansigit/opencodex" } } },
        { number: 13, title: "sync", state: "open", draft: true, base: { ref: "dev" }, head: { ref: "sync/upstream-v2.39.2-abcdef1", sha: SHA_DEV, repo: { full_name: "yansigit/opencodex" } } },
        { number: 14, title: "closed", state: "closed", base: { ref: "main" }, head: { ref: "dev" } },
        { number: 15, title: "foreign", state: "open", base: { ref: "main" }, head: { ref: "dev", repo: { full_name: "someone/opencodex" } } },
        { number: 16, title: "missing repo", state: "open", base: { ref: "main" }, head: { ref: "dev" } },
      ],
    });
    assert.deepEqual(result.promotion.prs.map(pr => pr.number), [12]);
    assert.deepEqual(result.sync.prs.map(pr => pr.number), [13]);
    assert.equal(evaluateRepositoryState({
      relation: { status: "ahead" },
      prs: result,
    }).status, "healthy");
    assert.equal(evaluateRepositoryState({
      relation: { status: "diverged" },
      prs: result,
    }).status, "alert");
  });

  it("has the required read-only workflow contract", () => {
    const workflow = fs.readFileSync(path.join(__dirname, "../workflows/automation-health.yml"), "utf8");
    assert.match(workflow, /cron:\s*["']37 \*\/6 \* \* \*["']/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /actions:\s*read/);
    assert.match(workflow, /contents:\s*read/);
    assert.match(workflow, /pull-requests:\s*read/);
    assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(workflow, /persist-credentials:\s*false/);
    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /actions:\s*write|contents:\s*write|pull-requests:\s*write|issues:/);
    assert.doesNotMatch(workflow, /uses:\s*(?!actions\/checkout@)[^\s]+/);
  });
});
