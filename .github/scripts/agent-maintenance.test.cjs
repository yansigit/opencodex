"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildJulesSessionRequest,
  buildJulesRepairComment,
  createJulesClient,
  defaultAgentMaintenanceState,
  changedFileListComplete,
  exactHeadBugbotEvidence,
  generatedSyncBaselineDisposition,
  maintenanceReadyEvidence,
  autonomousMergeEvidence,
  findGithubSource,
  hasExactHeadMaintainerWaiver,
  isExpectedJulesHeadAdvance,
  julesSessionDisposition,
  latestActiveLabelActor,
  parseAgentMaintenanceState,
  parseJulesCredentialPool,
  quotaExhaustionExpired,
  requiredChecksSuccessful,
  repairMarker,
  stateMarker,
  trustedActiveMaintenanceCount,
  validateSessionPullRequest,
  verifiedBugbotFindings,
  createJulesCredentialPoolClient,
} = require("./agent-maintenance.cjs");

const SHA = "a".repeat(40);

describe("maintenance state marker", () => {
  it("round-trips v1 and fills fields omitted by an early v1 marker", () => {
    const state = defaultAgentMaintenanceState({
      taskId: "docs-2026-w35",
      taskKind: "scheduled-docs",
      issueNumber: 42,
      now: "2026-08-24T00:00:00.000Z",
    });
    assert.deepEqual(parseAgentMaintenanceState(stateMarker(state)), state);

    const early = { ...state };
    delete early.lastBugbotCheckRunId;
    delete early.reason;
    assert.deepEqual(parseAgentMaintenanceState(stateMarker(early)), state);
  });

  it("fails closed for corrupt or invalid state", () => {
    assert.throws(
      () => parseAgentMaintenanceState("<!-- opencodex-agent-maintenance-state:{bad -->"),
      /invalid maintenance state JSON/,
    );
    const invalid = defaultAgentMaintenanceState({ taskId: "x", taskKind: "implement", issueNumber: 1 });
    invalid.repairAttempts = 3;
    assert.throws(() => parseAgentMaintenanceState(stateMarker(invalid)), /repairAttempts/);
  });

  it("cannot terminate its hidden marker through vendor-controlled strings", () => {
    const state = defaultAgentMaintenanceState({ taskId: "x", taskKind: "implement", issueNumber: 1 });
    state.reason = "vendor text --> injected comment";
    const marker = stateMarker(state);
    assert.equal(marker.match(/ -->/g)?.length, 1);
    assert.deepEqual(parseAgentMaintenanceState(marker), state);
  });
});

describe("Cursor Bugbot evidence", () => {
  it("accepts only a successful exact-name, exact-app, exact-head check", () => {
    const checks = [
      { id: 1, name: "Cursor Bugbot", app: { id: 99 }, head_sha: "b".repeat(40), status: "completed", conclusion: "success" },
      { id: 2, name: "Cursor Bugbot", app: { id: 7 }, head_sha: SHA, status: "completed", conclusion: "success" },
      { id: 3, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "completed", conclusion: "neutral" },
      { id: 4, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "completed", conclusion: "success" },
    ];
    assert.deepEqual(exactHeadBugbotEvidence({ checkRuns: checks, liveHeadSha: SHA, expectedAppId: 99 }), {
      name: "Cursor Bugbot",
      appId: 99,
      checkRunId: 4,
      headSha: SHA,
      status: "completed",
      conclusion: "success",
    });
  });

  it("blocks pending, neutral, stale, and spoofed checks", () => {
    for (const check of [
      { id: 1, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "in_progress", conclusion: null },
      { id: 2, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "completed", conclusion: "neutral" },
      { id: 3, name: "Cursor Bugbot", app: { id: 99 }, head_sha: "b".repeat(40), status: "completed", conclusion: "success" },
      { id: 4, name: "Cursor Bugbot", app: { id: 7 }, head_sha: SHA, status: "completed", conclusion: "success" },
    ]) {
      assert.equal(exactHeadBugbotEvidence({ checkRuns: [check], liveHeadSha: SHA, expectedAppId: 99 }), null);
    }
  });

  it("does not let an older success mask a newer neutral rerun", () => {
    assert.equal(exactHeadBugbotEvidence({
      checkRuns: [
        { id: 4, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "completed", conclusion: "success" },
        { id: 5, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA, status: "completed", conclusion: "neutral" },
      ],
      liveHeadSha: SHA,
      expectedAppId: 99,
    }), null);
  });

  it("accepts an outage waiver only after two current maintainers approve the exact head", () => {
    const reviews = [
      { id: 1, user: { login: "alice" }, commit_id: SHA, state: "APPROVED" },
      { id: 2, user: { login: "bob" }, commit_id: "b".repeat(40), state: "APPROVED" },
      { id: 3, user: { login: "carol" }, commit_id: SHA, state: "APPROVED" },
    ];
    assert.equal(hasExactHeadMaintainerWaiver({ labels: ["review-bot-waived"], reviews, maintainers: ["alice", "carol"], headSha: SHA }), true);
    assert.equal(hasExactHeadMaintainerWaiver({ labels: [], reviews, maintainers: ["alice", "carol"], headSha: SHA }), false);
    assert.equal(hasExactHeadMaintainerWaiver({ labels: ["review-bot-waived"], reviews, maintainers: ["alice", "bob"], headSha: SHA }), false);
  });
});

describe("baseline CI evidence", () => {
  it("keeps a generated sync gate pending until CI completes, but rejects a completed failure", () => {
    const pending = [
      { id: 1, name: "hygiene", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
      { id: 2, name: "ci", app: { id: 15368 }, head_sha: SHA, status: "queued", conclusion: null },
      { id: 3, name: "mergeable", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
    ];
    assert.equal(generatedSyncBaselineDisposition({ syncGenerated: true, checkRuns: pending, headSha: SHA }), "pending");
    assert.equal(generatedSyncBaselineDisposition({
      syncGenerated: true,
      checkRuns: pending.filter(check => check.name !== "ci"),
      headSha: SHA,
    }), "pending");
    assert.equal(generatedSyncBaselineDisposition({
      syncGenerated: true,
      checkRuns: pending.map(check => check.name === "ci" ? { ...check, status: "completed", conclusion: "failure" } : check),
      headSha: SHA,
    }), "failed");
  });

  it("requires latest successful exact-head evidence for every configured check", () => {
    const checks = [
      { id: 1, name: "ci", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
      { id: 2, name: "hygiene", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
    ];
    assert.equal(requiredChecksSuccessful(checks, SHA, ["ci", "hygiene"], 15368), true);
    checks.push({ id: 3, name: "ci", app: { id: 999 }, head_sha: SHA, status: "completed", conclusion: "success" });
    assert.equal(requiredChecksSuccessful(checks, SHA, ["ci", "hygiene"], 15368), true);
    checks.push({ id: 4, name: "ci", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "failure" });
    assert.equal(requiredChecksSuccessful(checks, SHA, ["ci", "hygiene"], 15368), false);
  });
});

describe("maintenance PR readiness", () => {
  const checks = [
    { id: 1, name: "ci", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
    { id: 2, name: "enforce-target", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
    { id: 3, name: "hygiene", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
    { id: 4, name: "mergeable", app: { id: 15368 }, head_sha: SHA, status: "completed", conclusion: "success" },
  ];

  it("accepts an exact-head Bugbot success with all baseline checks", () => {
    const result = maintenanceReadyEvidence({
      checkRuns: [...checks, {
        id: 4, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA,
        status: "completed", conclusion: "success",
      }],
      headSha: SHA,
      expectedBugbotAppId: 99,
    });
    assert.equal(result.ready, true);
    assert.equal(result.bugbotWaived, false);
  });

  it("allows missing Bugbot evidence only in shadow policy", () => {
    const result = maintenanceReadyEvidence({
      checkRuns: checks,
      headSha: SHA,
      expectedBugbotAppId: 99,
      bugbotPolicy: "shadow",
    });
    assert.equal(result.ready, true);
    assert.equal(result.bugbotShadow, true);
  });

  it("accepts a two-maintainer exact-head outage waiver", () => {
    const result = maintenanceReadyEvidence({
      checkRuns: checks,
      headSha: SHA,
      expectedBugbotAppId: 99,
      bugbotPolicy: "required",
      labels: ["review-bot-waived"],
      maintainers: ["alice", "carol"],
      reviews: [
        { id: 1, user: { login: "alice" }, commit_id: SHA, state: "APPROVED" },
        { id: 2, user: { login: "carol" }, commit_id: SHA, state: "APPROVED" },
      ],
    });
    assert.equal(result.ready, true);
    assert.equal(result.bugbotWaived, true);
  });
});

describe("Jules controller head advances", () => {
  it("accepts only a recorded controller merge with prior Jules and current dev parents", () => {
    const previousSha = "a".repeat(40);
    const currentSha = "b".repeat(40);
    const devSha = "c".repeat(40);
    assert.equal(isExpectedJulesHeadAdvance({
      previousSha,
      currentSha,
      currentBaseSha: devSha,
      reason: "controller-base-merge",
      expectedJulesUserId: 77,
      observedPusherId: 15368,
      controllerMerge: {
        recorded: true,
        sha: currentSha,
        parents: [{ sha: previousSha }, { sha: devSha }],
      },
      sessionStatus: "reviewing",
      comparison: { status: "ahead", ahead_by: 1, merge_base_commit: { sha: previousSha } },
      headCommit: { sha: currentSha, author: { id: 15368 }, committer: { id: 15368 } },
    }), true);
    assert.equal(isExpectedJulesHeadAdvance({
      previousSha,
      currentSha,
      currentBaseSha: devSha,
      reason: "controller-base-merge",
      expectedJulesUserId: 77,
      controllerMerge: { recorded: true, sha: currentSha, parents: [{ sha: previousSha }, { sha: devSha }] },
      sessionStatus: "running",
    }), false);
    assert.equal(isExpectedJulesHeadAdvance({
      previousSha,
      currentSha,
      currentBaseSha: devSha,
      reason: "controller-base-merge",
      expectedJulesUserId: 77,
      controllerMerge: { recorded: true, sha: currentSha, parents: [{ sha: devSha }, { sha: previousSha }] },
      sessionStatus: "reviewing",
    }), false);
  });
});

describe("autonomous merge evidence", () => {
  const pr = {
    number: 42,
    state: "open",
    base: { ref: "dev" },
    user: { id: 77 },
    head: { sha: SHA },
    labels: [{ name: "autonomous-fix" }],
  };
  const checks = [
    ...["ci", "enforce-target", "hygiene", "mergeable"].map((name, id) => ({
      id: id + 1, name, app: { id: 15368 }, head_sha: SHA,
      status: "completed", conclusion: "success",
    })),
    { id: 5, name: "Cursor Bugbot", app: { id: 99 }, head_sha: SHA,
      status: "completed", conclusion: "success" },
  ];
  const valid = {
    pr,
    checkRuns: checks,
    headCommit: { sha: SHA, author: { id: 77 }, committer: { id: 77 } },
    expectedJulesUserId: 77,
    expectedBugbotAppId: 99,
    authorizedSessionId: "sessions/abc",
    sessionId: "sessions/abc",
  };

  it("accepts a labeled exact-head Jules fix with all required checks", () => {
    const result = autonomousMergeEvidence(valid);
    assert.equal(result.ready, true);
    assert.equal(result.bugbotEvidence.checkRunId, 5);
  });

  it("rejects a waiver or missing autonomous-fix label", () => {
    assert.equal(autonomousMergeEvidence({
      ...valid,
      checkRuns: checks.slice(0, 3),
      labels: ["review-bot-waived"],
      reviews: [
        { id: 1, user: { login: "alice" }, commit_id: SHA, state: "APPROVED" },
        { id: 2, user: { login: "carol" }, commit_id: SHA, state: "APPROVED" },
      ],
      maintainers: ["alice", "carol"],
    }).ready, false);
    assert.equal(autonomousMergeEvidence({ ...valid, pr: { ...pr, labels: [] } }).ready, false);
  });

  it("rejects stale checks, unauthorized session, and non-Jules head authorship", () => {
    assert.equal(autonomousMergeEvidence({ ...valid, sessionId: "sessions/other" }).ready, false);
    assert.equal(autonomousMergeEvidence({
      ...valid,
      headCommit: { ...valid.headCommit, sha: "b".repeat(40) },
    }).ready, false);
    assert.equal(autonomousMergeEvidence({
      ...valid,
      checkRuns: checks.map(check => check.name === "ci" ? { ...check, conclusion: "failure" } : check),
    }).ready, false);
  });
});

describe("controller fail-closed helpers", () => {
  it("uses the latest labeled or unlabeled event for an active dispatch label", () => {
    const events = [
      { id: 1, event: "labeled", label: { name: "agent:jules" }, actor: { login: "trusted" } },
      { id: 2, event: "unlabeled", label: { name: "agent:jules" }, actor: { login: "trusted" } },
      { id: 3, event: "labeled", label: { name: "agent:jules" }, actor: { login: "untrusted" } },
    ];
    assert.equal(latestActiveLabelActor(events, "agent:jules"), "untrusted");
    assert.equal(latestActiveLabelActor(events.slice(0, 2), "agent:jules"), null);
  });

  it("rejects truncated or malformed GitHub changed-file lists", () => {
    assert.equal(changedFileListComplete(2, [{}, {}]), true);
    assert.equal(changedFileListComplete(3001, Array.from({ length: 3000 }, () => ({}))), false);
    assert.equal(changedFileListComplete(null, []), false);
  });

  it("classifies every documented Jules state without leaving terminal states running", () => {
    assert.equal(julesSessionDisposition("QUEUED", false), "running");
    assert.equal(julesSessionDisposition("AWAITING_PLAN_APPROVAL", false), "planning");
    assert.equal(julesSessionDisposition("AWAITING_USER_FEEDBACK", false), "needs-human");
    assert.equal(julesSessionDisposition("PAUSED", false), "needs-human");
    assert.equal(julesSessionDisposition("COMPLETED", false), "needs-human");
    assert.equal(julesSessionDisposition("COMPLETED", true), "pr-ready");
    assert.equal(julesSessionDisposition("FAILED", false), "failed");
    assert.equal(julesSessionDisposition("NEW_VENDOR_STATE", false), "needs-human");
  });

  it("counts only durable controller state toward the Jules concurrency ceiling", () => {
    assert.equal(trustedActiveMaintenanceCount([
      { state: { status: "running", sessionId: "one" } },
      { state: { status: "reviewing", sessionId: "two" } },
      { state: { status: "planning", sessionId: "three" } },
      { state: null },
      { state: { status: "running", sessionId: null } },
      { error: new Error("corrupt bot state") },
    ]), 4);
  });

  it("accepts only Jules-authored fast-forward head movement", () => {
    const next = "b".repeat(40);
    const base = {
      previousSha: SHA,
      currentSha: next,
      reason: `repair-requested:${SHA}`,
      expectedJulesUserId: 77,
      observedPusherId: 77,
      comparison: {
        status: "ahead",
        ahead_by: 1,
        merge_base_commit: { sha: SHA },
      },
      headCommit: { sha: next, author: { id: 77 }, committer: { id: 1 } },
    };
    assert.equal(isExpectedJulesHeadAdvance(base), true);
    assert.equal(isExpectedJulesHeadAdvance({ ...base, observedPusherId: null }), true);
    assert.equal(isExpectedJulesHeadAdvance({ ...base, reason: null }), true, "native Jules CI fixes are counted too");
    assert.equal(isExpectedJulesHeadAdvance({ ...base, reason: "unrelated-controller-error" }), false);
    assert.equal(isExpectedJulesHeadAdvance({ ...base, comparison: { ...base.comparison, status: "diverged" } }), false);
    assert.equal(isExpectedJulesHeadAdvance({ ...base, observedPusherId: 8 }), false);
    assert.equal(isExpectedJulesHeadAdvance({ ...base, headCommit: { ...base.headCommit, author: { id: 8 } } }), false);
  });
});

describe("repair findings", () => {
  it("keeps current-head immutable-author findings and enforces count and byte limits", () => {
    const comments = Array.from({ length: 4 }, (_, index) => ({
      id: index + 1,
      user: { id: index === 0 ? 8 : 7 },
      commit_id: index === 1 ? "b".repeat(40) : SHA,
      path: `src/${index}.ts`,
      line: index + 1,
      body: `Finding ${index}`,
    }));
    const result = verifiedBugbotFindings({ comments, botUserId: 7, headSha: SHA });
    assert.equal(result.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024);
    assert.ok(result.every((finding) => finding.id !== 1 && finding.id !== 2));

    const filteredWithResolved = verifiedBugbotFindings({
      comments,
      resolvedCommentIds: new Set([3]),
      botUserId: 7,
      headSha: SHA,
    });
    assert.equal(filteredWithResolved.length, 1);
    assert.equal(filteredWithResolved[0].id, 4);

    const comment = buildJulesRepairComment({ headSha: SHA, findings: result });
    assert.match(comment, /\n@Jules /);
    assert.match(comment, new RegExp(SHA));
    assert.doesNotMatch(comment, /```|\$\(|`/);
    assert.match(comment, new RegExp(repairMarker(SHA).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const oversized = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      user: { id: 7 },
      commit_id: SHA,
      path: `src/${index}.ts`,
      body: `Finding ${index}`,
    }));
    assert.throws(
      () => verifiedBugbotFindings({ comments: oversized, botUserId: 7, headSha: SHA }),
      /finding payload exceeds/,
    );
  });
});

describe("quota exhaustion", () => {
  it("escalates only after the same Jules 429 has lasted 24 hours", () => {
    const since = "quota-429:2026-08-24T00:00:00.000Z";
    assert.equal(quotaExhaustionExpired(since, Date.parse("2026-08-25T00:00:00.001Z")), true);
    assert.equal(quotaExhaustionExpired(since, Date.parse("2026-08-24T23:59:59.999Z")), false);
    assert.equal(quotaExhaustionExpired("another failure", Date.now()), false);
  });
});

describe("Jules API boundary", () => {
  it("builds a fork-main automatic-PR request with explicit plan approval", () => {
    assert.deepEqual(
      buildJulesSessionRequest({
        title: "opencodex-agent:issue-42",
        prompt: "Implement issue #42 under repository policy.",
        source: "sources/github/yansigit/opencodex",
        requirePlanApproval: true,
      }),
      {
        title: "opencodex-agent:issue-42",
        prompt: "Implement issue #42 under repository policy.",
        sourceContext: {
          source: "sources/github/yansigit/opencodex",
          githubRepoContext: { startingBranch: "dev" },
        },
        requirePlanApproval: true,
        automationMode: "AUTO_CREATE_PR",
      },
    );
  });

  it("passes a validated upstream sync branch to Jules", () => {
    assert.deepEqual(
      buildJulesSessionRequest({
        title: "opencodex-agent:sync-hotspot",
        prompt: "Resolve the hotspot.",
        source: "sources/github/yansigit/opencodex",
        startingBranch: "sync/upstream-v1.2.3-abcdef1234567",
        requirePlanApproval: false,
      }).sourceContext.githubRepoContext,
      { startingBranch: "sync/upstream-v1.2.3-abcdef1234567" },
    );
    assert.throws(
      () => buildJulesSessionRequest({
        title: "x",
        prompt: "x",
        source: "sources/repo",
        startingBranch: "feature/untrusted",
        requirePlanApproval: false,
      }),
      /starting branch/,
    );
  });

  it("selects only the exact connected GitHub repository source", () => {
    assert.equal(findGithubSource([
      { name: "sources/1", githubRepo: { owner: "other", repo: "opencodex" } },
      { name: "sources/2", githubRepo: { owner: "yansigit", repo: "opencodex" } },
    ], "yansigit", "opencodex"), "sources/2");
    assert.throws(() => findGithubSource([], "yansigit", "opencodex"), /connected Jules source/);
  });

  it("retries reads but never blindly retries a create", async () => {
    const calls = [];
    const responses = [
      new Response("busy", { status: 503, headers: { "retry-after": "0" } }),
      Response.json({ sessions: [] }),
      new Response("busy", { status: 503 }),
    ];
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responses.shift();
      },
      sleep: async () => {},
    });
    assert.deepEqual(await client.listSessions(), []);
    await assert.rejects(
      () => client.createSession({ title: "x", prompt: "x", sourceContext: { source: "s", githubRepoContext: { startingBranch: "dev" } }, requirePlanApproval: false, automationMode: "AUTO_CREATE_PR" }),
      /HTTP 503/,
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ options }) => options.headers["x-goog-api-key"] === "secret"));
  });

  it("honors an HTTP-date Retry-After on read-only retries", async () => {
    const waits = [];
    const retryAt = new Date(Date.now() + 2_000).toUTCString();
    const responses = [
      new Response("busy", { status: 429, headers: { "retry-after": retryAt } }),
      Response.json({ sessions: [] }),
    ];
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async () => responses.shift(),
      sleep: async ms => waits.push(ms),
    });
    assert.deepEqual(await client.listSessions(), []);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 1_000 && waits[0] <= 30_000);
  });

  it("fails closed without retrying terminal read or mutation statuses", async () => {
    for (const status of [401, 403, 404, 409]) {
      let calls = 0;
      const client = createJulesClient({
        apiKey: "secret",
        fetchImpl: async () => {
          calls += 1;
          return new Response("error", { status });
        },
        sleep: async () => {},
      });
      await assert.rejects(() => client.listSessions(), error => error.status === status);
      assert.equal(calls, 1);
    }

    for (const status of [409, 429, 503]) {
      let calls = 0;
      const client = createJulesClient({
        apiKey: "secret",
        fetchImpl: async () => {
          calls += 1;
          return new Response("error", { status });
        },
      });
      await assert.rejects(() => client.createSession({ title: "task" }), error => error.status === status);
      assert.equal(calls, 1);
    }
  });

  it("follows Jules pagination tokens", async () => {
    const urls = [];
    const responses = [
      Response.json({ sessions: [{ name: "sessions/1", id: "s1", title: "one" }], nextPageToken: "a b" }),
      Response.json({ sessions: [{ name: "sessions/2", id: "s2", title: "two" }] }),
    ];
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async (url) => {
        urls.push(url);
        return responses.shift();
      },
      sleep: async () => {},
    });
    assert.deepEqual((await client.listSessions()).map(session => session.id), ["s1", "s2"]);
    assert.match(urls[1], /pageToken=a%20b/);
  });

  it("recovers an uncertain create by exact deterministic title without duplicating", async () => {
    let calls = 0;
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async (_url, options) => {
        calls += 1;
        if (calls === 1) throw new DOMException("request timed out", "TimeoutError");
        assert.equal(options.method, "GET");
        if (calls === 2) return Response.json({ sessions: [{ id: "s1", name: "sessions/1", title: "opencodex-agent:issue-42", state: "QUEUED" }] });
        return Response.json({
          id: "s1",
          name: "sessions/1",
          title: "opencodex-agent:issue-42",
          sourceContext: { source: "s", githubRepoContext: { startingBranch: "dev" } },
        });
      },
      sleep: async () => {},
    });
    const session = await client.createSessionIdempotently({
      title: "opencodex-agent:issue-42",
      prompt: "x",
      sourceContext: { source: "s", githubRepoContext: { startingBranch: "dev" } },
      requirePlanApproval: false,
      automationMode: "AUTO_CREATE_PR",
    });
    assert.equal(session.id, "s1");
    assert.equal(calls, 3);
  });

  it("reconciles ambiguous POST 5xx and successful responses with invalid JSON", async () => {
    for (const first of [
      new Response("busy", { status: 503 }),
      new Response("not json", { status: 200 }),
    ]) {
      const responses = [
        first,
        Response.json({ sessions: [{ name: "sessions/1", id: "s1", title: "task" }] }),
        Response.json({
          name: "sessions/1",
          id: "s1",
          title: "task",
          sourceContext: { source: "sources/repo", githubRepoContext: { startingBranch: "dev" } },
        }),
      ];
      const client = createJulesClient({
        apiKey: "secret",
        fetchImpl: async () => responses.shift(),
        sleep: async () => {},
      });
      assert.equal((await client.createSessionIdempotently({
        title: "task",
        sourceContext: { source: "sources/repo", githubRepoContext: { startingBranch: "dev" } },
      })).name, "sessions/1");
    }
  });

  it("rejects an uncertain-create title match from another source", async () => {
    const responses = [
      new Response("busy", { status: 503 }),
      Response.json({ sessions: [{ name: "sessions/1", id: "s1", title: "task" }] }),
      Response.json({
        name: "sessions/1",
        id: "s1",
        title: "task",
        sourceContext: { source: "sources/other", githubRepoContext: { startingBranch: "dev" } },
      }),
    ];
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async () => responses.shift(),
      sleep: async () => {},
    });
    await assert.rejects(
      () => client.createSessionIdempotently({
        title: "task",
        sourceContext: { source: "sources/repo", githubRepoContext: { startingBranch: "dev" } },
      }),
      /source mismatch/,
    );
  });

  it("polls the resource-name tail rather than the opaque session id", async () => {
    const urls = [];
    const client = createJulesClient({
      apiKey: "secret",
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json({ name: "sessions/1234567", id: "abc123", title: "task" });
      },
    });
    await client.getSession("1234567");
    assert.equal(urls[0], "https://jules.googleapis.com/v1alpha/sessions/1234567");
    await assert.rejects(() => client.getSession("sessions/1234567"), /invalid Jules session resource id/);
  });

  it("validates that a session output names the live open fork-main PR", () => {
    const session = {
      id: "s1",
      title: "opencodex-agent:issue-42",
      outputs: [{ pullRequest: { url: "https://github.com/yansigit/opencodex/pull/77" } }],
    };
    const pr = { number: 77, state: "open", base: { ref: "dev", repo: { full_name: "yansigit/opencodex" } }, head: { sha: SHA } };
    const authoredPr = { ...pr, user: { id: 77 }, head: { ...pr.head, repo: { full_name: "yansigit/opencodex" } } };
    assert.deepEqual(validateSessionPullRequest({ session, pr: authoredPr, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), { number: 77, headSha: SHA });
    assert.throws(() => validateSessionPullRequest({ session, pr: { ...authoredPr, state: "closed", merged: true }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /must remain open/);
    assert.deepEqual(validateSessionPullRequest({ session, pr: { ...authoredPr, state: "closed", merged: true }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77, allowClosed: true }), { number: 77, headSha: SHA });
    assert.throws(() => validateSessionPullRequest({ session, pr: { ...authoredPr, user: { id: 8 } }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /author mismatch/);
    assert.throws(() => validateSessionPullRequest({ session, pr: { ...authoredPr, head: { ...authoredPr.head, repo: null } }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /head branch/);
    assert.throws(() => validateSessionPullRequest({ session, pr: { ...authoredPr, head: { ...authoredPr.head, repo: { full_name: "attacker/opencodex" } } }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /head must belong to this repository/);
    assert.throws(() => validateSessionPullRequest({ session, pr: { ...authoredPr, base: { ...authoredPr.base, ref: "main" } }, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /base dev/);
    assert.throws(() => validateSessionPullRequest({ session: { ...session, outputs: [{ pullRequest: { url: "https://example.com/yansigit/opencodex/pull/77" } }] }, pr: authoredPr, owner: "yansigit", repo: "opencodex", expectedAuthorId: 77 }), /GitHub URL/);
  });
});

describe("Jules credential pool", () => {
  const entries = [
    { id: "slow", apiKey: "key-slow", accountId: "account-slow", priority: 20 },
    { id: "fast", apiKey: "key-fast", accountId: "account-fast", priority: 1 },
  ];
  const session = { name: "sessions/1", id: "s1", title: "task" };

  it("parses a sorted JSON pool and keeps the old one-key input valid", () => {
    assert.deepEqual(parseJulesCredentialPool(JSON.stringify(entries)), [entries[1], entries[0]]);
    assert.deepEqual(parseJulesCredentialPool("legacy-secret"), [{
      id: "default",
      apiKey: "legacy-secret",
      accountId: "legacy",
      priority: 0,
    }]);
    assert.deepEqual(parseJulesCredentialPool({ apiKey: "legacy-secret" }), [{
      id: "default",
      apiKey: "legacy-secret",
      accountId: "legacy",
      priority: 0,
    }]);
  });

  it("auto-detects a JSON pool passed through the existing apiKey option", async () => {
    const client = createJulesClient({
      apiKey: JSON.stringify(entries),
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers["x-goog-api-key"], "key-fast");
        return Response.json(session);
      },
    });
    const result = await client.createSession({ title: "task" });
    assert.equal(result.credentialId, "fast");
    assert.equal(client.getState().selectedCredentialId, "fast");
  });

  it("registers every parsed key exactly once for masking, including legacy input", () => {
    const registered = [];
    createJulesClient({
      apiKey: JSON.stringify(entries),
      registerSecret: key => registered.push(key),
    });
    assert.deepEqual(registered, ["key-fast", "key-slow"]);

    const legacy = [];
    createJulesClient({ apiKey: "legacy-secret", registerSecret: key => legacy.push(key) });
    assert.deepEqual(legacy, ["legacy-secret"]);

    assert.throws(
      () => createJulesCredentialPoolClient({
        credentials: entries,
        registerSecret: key => { throw new Error(`mask failed for ${key}`); },
      }),
      error => error.message === "Jules secret registration failed" && !error.message.includes("key-"),
    );
  });

  it("rejects malformed, duplicate-id, and duplicate-account pools without echoing secrets", () => {
    const secret = "do-not-echo-this-key";
    const duplicateId = [
      { id: "one", apiKey: secret, accountId: "account-one", priority: 1 },
      { id: "one", apiKey: "other-key", accountId: "account-two", priority: 2 },
    ];
    const duplicateAccount = [
      { id: "one", apiKey: secret, accountId: "same-account", priority: 1 },
      { id: "two", apiKey: "other-key", accountId: "same-account", priority: 2 },
    ];
    for (const [input, pattern] of [
      [duplicateId, /duplicate credential id/],
      [duplicateAccount, /duplicate credential accountId/],
      [[{ id: "bad", apiKey: secret, accountId: "account", priority: "1" }], /malformed credential priority/],
      [[
        { id: "one", apiKey: secret, accountId: "account-one", priority: 1 },
        { id: "two", apiKey: "key-two", accountId: "account-two", priority: 2 },
        { id: "three", apiKey: "key-three", accountId: "account-three", priority: 3 },
        { id: "four", apiKey: "key-four", accountId: "account-four", priority: 4 },
      ], /maximum of 3 entries/],
      ["{not-json", /credential JSON is malformed/],
    ]) {
      assert.throws(() => parseJulesCredentialPool(input), error => {
        assert.match(error.message, pattern);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
  });

  it("never issues an alternate-account create after a session-create 429", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response("quota", { status: 429 });
      },
      sleep: async () => {},
    });
    await assert.rejects(() => client.createSession({ title: "task" }), error => error.status === 429);
    assert.equal(client.selectedCredentialId, "fast");
    assert.deepEqual(client.getState(), { selectedCredentialId: "fast", credentialCount: 2 });
    assert.deepEqual(client.state, client.getState());
    assert.deepEqual(calls.map(call => call.options.headers["x-goog-api-key"]), ["key-fast"]);
    assert.equal(JSON.stringify(client.getState()).includes("key-"), false);
  });

  it("strictly re-selects the persisted credential for account-bound operations", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (options.method === "GET") return Response.json(session);
        return Response.json({ accepted: true });
      },
    });
    assert.deepEqual(client.selectCredential("slow"), { selectedCredentialId: "slow", credentialCount: 2 });
    await client.getSession("1");
    await client.sendMessage("1", "continue");
    assert.ok(calls.every(call => call.options.headers["x-goog-api-key"] === "key-slow"));
    assert.throws(() => client.selectCredential("missing"), /unknown Jules credential id/);
    assert.throws(() => client.selectCredential(null), /unknown Jules credential id/);
    assert.equal(client.selectedCredentialId, "slow");
  });

  it("uses priority[0] by default and explicit selection for later create affinity", async () => {
    const keys = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (_url, options) => {
        keys.push(options.headers["x-goog-api-key"]);
        return Response.json({ ...session, id: `s${keys.length}`, name: `sessions/${keys.length}` });
      },
    });
    const first = await client.createSession({ title: "task-one" });
    assert.equal(first.credentialId, "fast");
    client.selectCredential("slow");
    const second = await client.createSession({ title: "task-two" });
    assert.equal(second.credentialId, "slow");
    assert.deepEqual(keys, ["key-fast", "key-slow"]);
  });

  it("resolves the repository source separately for each explicitly selected account", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (url, options) => {
        const key = options.headers["x-goog-api-key"];
        calls.push({ url, options, key });
        if (url.endsWith("/sources")) {
          return Response.json({
            sources: [{
              name: key === "key-fast" ? "sources/account-fast/repo" : "sources/account-slow/repo",
              githubRepo: { owner: "yansigit", repo: "opencodex" },
            }],
          });
        }
        const body = JSON.parse(options.body);
        assert.equal(
          body.sourceContext.source,
          key === "key-fast" ? "sources/account-fast/repo" : "sources/account-slow/repo",
        );
        return Response.json({ ...session, id: `s${calls.length}`, name: `sessions/${calls.length}`, sourceContext: body.sourceContext });
      },
      sleep: async () => {},
    });
    const payload = {
      title: "task",
      sourceContext: { source: "sources/stale", githubRepoContext: { startingBranch: "dev" } },
    };
    const first = await client.createRepoSessionIdempotently(payload, { owner: "yansigit", repo: "opencodex" });
    assert.equal(first.credentialId, "fast");
    client.selectCredential("slow");
    const second = await client.createRepoSessionIdempotently(payload, { owner: "yansigit", repo: "opencodex" });
    assert.equal(second.credentialId, "slow");
    assert.equal(payload.sourceContext.source, "sources/stale", "caller request is not mutated");
    assert.deepEqual(calls.map(call => [call.key, new URL(call.url).pathname]), [
      ["key-fast", "/v1alpha/sources"],
      ["key-fast", "/v1alpha/sessions"],
      ["key-slow", "/v1alpha/sources"],
      ["key-slow", "/v1alpha/sessions"],
    ]);
  });

  it("reconciles a create 429 only against the same account and returns its deterministic match", async () => {
    const calls = [];
    const source = "sources/account-fast/repo";
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (url, options) => {
        const key = options.headers["x-goog-api-key"];
        calls.push({ url, method: options.method, key });
        if (url.endsWith("/sources")) {
          return Response.json({ sources: [{ name: source, githubRepo: { owner: "yansigit", repo: "opencodex" } }] });
        }
        if (url.endsWith("/sessions") && options.method === "POST") {
          return new Response("quota", { status: 429 });
        }
        if (url.endsWith("/sessions")) {
          return Response.json({ sessions: [session] });
        }
        return Response.json({
          ...session,
          sourceContext: { source, githubRepoContext: { startingBranch: "dev" } },
        });
      },
      sleep: async () => {},
    });
    const result = await client.createRepoSessionIdempotently({
      title: "task",
      sourceContext: { githubRepoContext: { startingBranch: "dev" } },
    }, { owner: "yansigit", repo: "opencodex" });
    assert.equal(result.credentialId, "fast");
    assert.deepEqual(calls.map(call => [call.key, call.method, new URL(call.url).pathname]), [
      ["key-fast", "GET", "/v1alpha/sources"],
      ["key-fast", "POST", "/v1alpha/sessions"],
      ["key-fast", "GET", "/v1alpha/sessions"],
      ["key-fast", "GET", "/v1alpha/sessions/1"],
    ]);
  });

  it("fails closed when same-account reconciliation after create 429 finds no session", async () => {
    const keys = [];
    let call = 0;
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (_url, options) => {
        call += 1;
        keys.push(options.headers["x-goog-api-key"]);
        if (call === 1) {
          return Response.json({
            sources: [{
              name: "sources/account-fast/repo",
              githubRepo: { owner: "yansigit", repo: "opencodex" },
            }],
          });
        }
        if (call === 2) return new Response("quota", { status: 429 });
        return Response.json({ sessions: [] });
      },
      sleep: async () => {},
    });
    await assert.rejects(
      () => client.createRepoSessionIdempotently(
        { title: "task", sourceContext: { githubRepoContext: { startingBranch: "dev" } } },
        { owner: "yansigit", repo: "opencodex" },
      ),
      error => error.uncertain === true && !error.message.includes("key-fast") && !error.message.includes("key-slow"),
    );
    assert.deepEqual(keys, ["key-fast", "key-fast", "key-fast"]);
    assert.equal(client.selectedCredentialId, "fast");
  });

  it("does not fail over when account-specific source discovery fails", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (_url, options) => {
        calls.push(options.headers["x-goog-api-key"]);
        throw new Error("source read failed with key-fast and key-slow");
      },
    });
    await assert.rejects(
      () => client.createRepoSessionIdempotently(
        { title: "task", sourceContext: { githubRepoContext: { startingBranch: "dev" } } },
        { owner: "yansigit", repo: "opencodex" },
      ),
      error => {
        assert.equal(error.operation, "read");
        assert.equal(error.message.includes("key-fast"), false);
        assert.equal(error.message.includes("key-slow"), false);
        return true;
      },
    );
    assert.deepEqual(calls, ["key-fast"]);
    assert.equal(client.selectedCredentialId, "fast");
  });

  it("does not fail over network errors, 5xx, authorization failures, or non-create mutations", async () => {
    for (const failure of [
      { name: "network", run: async client => client.createSession({ title: "task" }), response: new Error("network key-fast") },
      { name: "5xx", run: async client => client.createSession({ title: "task" }), response: new Response("busy", { status: 503 }) },
      { name: "401", run: async client => client.createSession({ title: "task" }), response: new Response("unauthorized", { status: 401 }) },
      { name: "403", run: async client => client.createSession({ title: "task" }), response: new Response("forbidden", { status: 403 }) },
      { name: "sendMessage 429", run: async client => client.sendMessage("1", "continue"), response: new Response("quota", { status: 429 }) },
    ]) {
      let calls = 0;
      const client = createJulesCredentialPoolClient({
        credentials: entries,
        fetchImpl: async () => {
          calls += 1;
          if (failure.response instanceof Error) throw failure.response;
          return failure.response;
        },
      });
      await assert.rejects(failure.run(client), error => {
        assert.equal(error.message.includes("key-fast"), false, failure.name);
        return true;
      });
      assert.equal(calls, 1, failure.name);
      assert.equal(client.selectedCredentialId, "fast", failure.name);
    }
  });

  it("does not fail over read operations, including retried read 429s", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (_url, options) => {
        calls.push(options);
        return new Response("quota", { status: 429 });
      },
      sleep: async () => {},
    });
    await assert.rejects(() => client.getSession("1"), error => error.status === 429);
    assert.equal(calls.length, 4, "read retry policy remains local to the selected credential");
    assert.ok(calls.every(options => options.headers["x-goog-api-key"] === "key-fast"));
    assert.equal(client.selectedCredentialId, "fast");
  });

  it("preserves idempotent reconciliation and does not fail over an ambiguous create", async () => {
    const calls = [];
    const client = createJulesCredentialPoolClient({
      credentials: entries,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) return new Response("busy", { status: 503 });
        if (calls.length === 2) return Response.json({ sessions: [session] });
        return Response.json({ ...session, sourceContext: { source: "source", githubRepoContext: { startingBranch: "dev" } } });
      },
      sleep: async () => {},
    });
    const result = await client.createSessionIdempotently({
      title: "task",
      sourceContext: { source: "source", githubRepoContext: { startingBranch: "dev" } },
    });
    assert.equal(result.credentialId, "fast");
    assert.deepEqual(calls.map(call => call.options.method), ["POST", "GET", "GET"]);
    assert.ok(calls.every(call => call.options.headers["x-goog-api-key"] === "key-fast"));
  });

  it("records the selected credential id in state markers without accepting secrets", () => {
    const state = defaultAgentMaintenanceState({ taskId: "issue-1", taskKind: "implement", issueNumber: 1 });
    state.selectedCredentialId = "fast";
    assert.equal(parseAgentMaintenanceState(stateMarker(state)).selectedCredentialId, "fast");
    state.selectedCredentialId = "bad id";
    assert.throws(() => stateMarker(state), /selectedCredentialId/);
  });
});
