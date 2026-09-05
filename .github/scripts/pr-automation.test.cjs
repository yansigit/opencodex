"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  AUTOMATION_COMMENT_MARKER,
  approvalEvidence,
  botMergeEvidence,
  buildAutomationComment,
  classifyPullRequest,
  exactHeadGate,
  isMissingPullRequestError,
  REQUIRED_CHECKS,
  summarizeAgedHolds,
  workflowRunRetryDisposition,
} = require("./pr-automation.cjs");

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function pr(overrides = {}) {
  return {
    state: "open",
    draft: false,
    title: "fix: useful change",
    body: "A substantial change with verification details.",
    base: { ref: "dev", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } },
    head: { ref: "fix/useful-change", sha: SHA, repo: { full_name: "yansigit/opencodex" } },
    labels: [],
    user: { login: "contributor", id: 10 },
    ...overrides,
  };
}

describe("classifyPullRequest", () => {
  const cases = [
    ["same-repo human", {}, "same-repo-human", "same-repo-human"],
    ["fork", { head: { ref: "fix/fork", sha: SHA, repo: { full_name: "someone/opencodex" } } }, "fork", "fork-head"],
    ["draft", { draft: true }, "draft", "draft"],
    ["hold", { labels: [{ name: "automation:hold" }] }, "hold", "automation-hold"],
    ["stacked", { base: { ref: "parent-branch", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } }, basePullRequest: { state: "open" } }, "stacked", "stacked"],
    ["promotion", { base: { ref: "main", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } }, head: { ref: "dev", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, title: "promote: dev to main" }, "promotion", "promotion"],
    ["deterministic sync", { head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, body: "<!-- opencodex-fork-sync -->\nGenerated sync." }, "deterministic-sync", "deterministic-sync"],
    ["draft generated sync", { draft: true, head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, body: "<!-- opencodex-fork-sync -->\nGenerated sync." }, "draft", "draft"],
    ["agent-resolved sync", { head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, agentResolved: true }, "agent-resolved-sync", "agent-resolved-sync"],
    ["Jules active", { julesState: "IN_PROGRESS" }, "jules-active", "jules-active"],
    ["Jules terminal", { julesState: "FAILED" }, "jules-terminal", "jules-terminal"],
    ["closed", { state: "closed" }, "hold", "closed"],
    ["deleted head", { head: { ref: "fix/gone", sha: SHA, repo: null } }, "hold", "deleted-head"],
    ["retargeted", { base: { ref: "release", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } } }, "hold", "retargeted"],
  ];

  for (const [name, overrides, expectedClass, expectedReason] of cases) {
    it(`classifies ${name}`, () => {
      const result = classifyPullRequest({ pr: pr(overrides), repository: "yansigit/opencodex" });
      assert.equal(result.class, expectedClass);
      assert.equal(result.reason, expectedReason);
    });
  }

  it("never marks an immutable sync candidate eligible for update-branch", () => {
    const result = classifyPullRequest({
      pr: pr({
        head: { ref: "sync/upstream-v2.36.1-abcdef123456-0123456789ab", sha: SHA, repo: { full_name: "yansigit/opencodex" } },
        body: "<!-- opencodex-fork-sync -->\nGenerated sync.",
      }),
      repository: "yansigit/opencodex",
    });
    assert.equal(result.class, "deterministic-sync");
    assert.equal(result.eligibleForUpdate, false);
  });
});

describe("workflowRunRetryDisposition", () => {
  function run(overrides = {}) {
    return {
      id: 123,
      name: "Cross-platform CI",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      run_attempt: 1,
      head_sha: SHA,
      repository: { full_name: "yansigit/opencodex" },
      head_repository: { full_name: "yansigit/opencodex" },
      pull_requests: [{ number: 42 }],
      ...overrides,
    };
  }
  function retry(overrides = {}, prOverrides = {}) {
    return workflowRunRetryDisposition({
      run: run(overrides),
      pr: { number: 42, ...pr(prOverrides) },
      repository: "yansigit/opencodex",
    });
  }

  it("reruns the first failed attempt for each allowlisted workflow", () => {
    assert.equal(retry().action, "rerun");
    assert.equal(retry({ name: "React Doctor", path: ".github/workflows/react-doctor.yml" }).action, "rerun");
    assert.equal(retry({ name: "Service lifecycle", path: ".github/workflows/service-lifecycle.yml" }).action, "rerun");
  });

  it("never retries policy workflows or mismatched workflow paths", () => {
    assert.equal(retry({ name: "PR hygiene", path: ".github/workflows/pr-hygiene.yml" }).action, "ignore");
    assert.equal(retry({ path: ".github/workflows/untrusted.yml" }).action, "ignore");
  });

  it("stops after one retry and ignores non-PR or non-failure conclusions", () => {
    assert.equal(retry({ run_attempt: 2 }).reason, "retry-already-used");
    assert.equal(retry({ event: "push" }).reason, "run-not-failed-pr");
    assert.equal(retry({ conclusion: "cancelled" }).reason, "run-not-failed-pr");
  });

  it("requires a trusted same-repository exact-head PR", () => {
    assert.equal(retry({ head_repository: { full_name: "someone/opencodex" } }).reason, "untrusted-repository");
    assert.equal(retry({ head_sha: OTHER_SHA }).reason, "pull-request-not-exact-head");
    assert.equal(retry({ pull_requests: [{ number: 41 }, { number: 42 }] }).reason, "pull-request-ambiguous");
    assert.equal(retry({}, { draft: true }).reason, "pull-request-not-exact-head");
  });

  it("allows an exact-head PR resolved from a run whose association list is empty", () => {
    assert.equal(retry({ pull_requests: [] }).action, "rerun");
  });

  it("accepts only dev PRs and the canonical dev-to-main promotion", () => {
    assert.equal(retry({}, { base: { ref: "release", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } } }).reason, "unsupported-target");
    assert.equal(retry({}, {
      title: "promote: dev to main",
      base: { ref: "main", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } },
      head: { ref: "dev", sha: SHA, repo: { full_name: "yansigit/opencodex" } },
    }).action, "rerun");
  });
});

describe("isMissingPullRequestError", () => {
  it("recognizes only GitHub's missing-resource status", () => {
    assert.equal(isMissingPullRequestError({ status: 404 }), true);
    assert.equal(isMissingPullRequestError({ status: "404" }), true);
    assert.equal(isMissingPullRequestError({ status: 403 }), false);
    assert.equal(isMissingPullRequestError(new Error("not found")), false);
  });
});

function passingGateInput(overrides = {}) {
  return {
    liveHeadSha: SHA,
    headSha: SHA,
    baseRef: "dev",
    baseSha: BASE_SHA,
    mergeable: true,
    mergeableState: "clean",
    baseAncestry: true,
    currentBaseSha: BASE_SHA,
    expectedBaseSha: BASE_SHA,
    changedFiles: [{ filename: "src/feature.ts" }],
    changedFilesCount: 1,
    changedFilesComplete: true,
    requiredChecks: ["ci", "hygiene", "enforce-target", "mergeable"],
    expectedAppIds: { ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 },
    checkRuns: [
      { id: 1, name: "ci", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
      { id: 2, name: "hygiene", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
      { id: 3, name: "enforce-target", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
      { id: 4, name: "mergeable", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
    ],
    ...overrides,
  };
}

function passingGate(overrides = {}) {
  return exactHeadGate(passingGateInput(overrides));
}

describe("exactHeadGate", () => {
  it("treats mergeable as a required App-bound check", () => {
    assert.deepEqual(REQUIRED_CHECKS, ["ci", "hygiene", "enforce-target", "mergeable"]);
    const result = passingGate({
      requiredChecks: [...REQUIRED_CHECKS],
      expectedAppIds: { ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 },
      checkRuns: [
        ...passingGateInput().checkRuns,
        { id: 4, name: "mergeable", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
      ],
    });
    assert.equal(result.ok, true);
  });
  it("accepts complete exact-head evidence", () => {
    const result = passingGate();
    assert.equal(result.ok, true);
    assert.equal(result.safeForAutomation, true);
    assert.deepEqual(result.failures, []);
  });

  it("rejects a contradictory complete file-count claim", () => {
    const result = passingGate({ changedFilesComplete: true, changedFilesCount: 2 });
    assert.equal(result.failures.includes("changed-files-incomplete"), true);
  });

  it("requires explicit complete pagination and valid filenames", () => {
    assert.equal(passingGate({ changedFilesComplete: false }).failures.includes("changed-files-incomplete"), true);
    assert.equal(passingGate({ changedFiles: [{}], changedFilesCount: 1 }).failures.includes("changed-files-incomplete"), true);
    assert.equal(passingGate({ changedFiles: ["src/feature.ts"], changedFilesCount: 1 }).failures.includes("changed-files-incomplete"), true);
  });

  it("requires matching valid live and expected base SHAs", () => {
    assert.equal(passingGate({ currentBaseSha: BASE_SHA, expectedBaseSha: OTHER_SHA }).failures.includes("base-mismatch"), true);
    assert.equal(passingGate({ expectedBaseSha: "not-a-sha" }).failures.includes("base-sha-invalid"), true);
  });

  it("requires the fixed baseline checks and valid expected App IDs", () => {
    assert.equal(passingGate({ requiredChecks: ["ci"] }).failures.includes("required-checks-invalid"), true);
    assert.equal(passingGate({ requiredChecks: ["ci", "hygiene", "enforce-target", "unknown"] }).failures.includes("required-checks-invalid"), true);
    assert.equal(passingGate({ expectedAppIds: { ci: "not-an-app" } }).failures.includes("app-id-invalid"), true);
    assert.equal(passingGate({ expectedAppIds: { ci: 15368 }, expectedAppId: 15368 }).failures.includes("app-id-invalid"), true);
  });

  const failures = [
    ["live head mismatch", { headSha: OTHER_SHA }, "head-mismatch"],
    ["incomplete file pagination", { changedFilesCount: 2 }, "changed-files-incomplete"],
    ["merge conflict", { mergeable: false, mergeableState: "dirty" }, "not-mergeable"],
    ["base ancestry missing", { baseAncestry: false }, "base-not-ancestor"],
    ["stale check", { checkRuns: [{ id: 9, name: "ci", head_sha: OTHER_SHA, status: "completed", conclusion: "success", app: { id: 15368 } }] }, "check-not-exact-head"],
    ["spoofed app", { checkRuns: [{ id: 9, name: "ci", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 999 } }] }, "check-wrong-app"],
  ];
  for (const [name, overrides, expectedFailure] of failures) {
    it(`rejects ${name}`, () => {
      const result = passingGate(overrides);
      assert.equal(result.ok, false);
      assert.equal(result.failures.includes(expectedFailure), true);
    });
  }

  it("detects sensitive renames through previous_filename", () => {
    const result = passingGate({
      changedFiles: [{ filename: "docs/auth.md", previous_filename: ".github/workflows/old.yml" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.sensitive, true);
    assert.equal(result.safeForAutomation, false);
    assert.deepEqual(result.sensitivePaths, ["docs/auth.md", ".github/workflows/old.yml"]);
  });
});

describe("approvalEvidence", () => {
  it("accepts the latest maintainer label event bound to the live head", () => {
    const result = approvalEvidence({
      liveHeadSha: SHA,
      labels: ["automerge-approved"],
      maintainerLogins: ["owner"],
      labelEvents: [
        { id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: SHA },
      ],
      approvalRecord: { headSha: SHA, actor: "owner", labeledEventId: 1 },
    });
    assert.equal(result.approved, true);
    assert.equal(result.actor, "owner");
    assert.equal(result.eventId, 1);
  });

  const cases = [
    ["non-maintainer", [{ id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "contributor" }, head_sha: SHA }]],
    ["stale head", [{ id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: OTHER_SHA }]],
    ["later removal", [
      { id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: SHA },
      { id: 2, event: "unlabeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: SHA },
    ]],
  ];
  for (const [name, events] of cases) {
    it(`rejects ${name}`, () => {
      assert.equal(approvalEvidence({ liveHeadSha: SHA, labels: ["automerge-approved"], maintainerLogins: ["owner"], labelEvents: events }).approved, false);
    });
  }

  it("rejects approval when the live label snapshot is unavailable", () => {
    assert.equal(approvalEvidence({
      liveHeadSha: SHA,
      maintainerLogins: ["owner"],
      labelEvents: [{ id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: SHA }],
    }).approved, false);
  });

  it("rejects label evidence without the persisted trusted approval record", () => {
    assert.equal(approvalEvidence({
      liveHeadSha: SHA,
      labels: ["automerge-approved"],
      maintainerLogins: ["owner"],
      labelEvents: [{ id: 1, event: "labeled", label: { name: "automerge-approved" }, actor: { login: "owner" }, head_sha: SHA }],
    }).approved, false);
  });
});

describe("botMergeEvidence", () => {
  it("accepts deterministic sync only with trusted exact-head Bugbot evidence", () => {
    const result = botMergeEvidence({
      pr: pr({
        head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } },
        body: "<!-- opencodex-fork-sync -->",
      }),
      provenance: {
        trusted: true,
        authenticated: true,
        kind: "deterministic-sync",
        producerIdentity: "fork-upstream-sync",
      },
      expectedTrustedProducerIdentity: "fork-upstream-sync",
      liveHeadSha: SHA,
      expectedBugbotAppId: 777,
      currentBaseSha: BASE_SHA,
      expectedBaseSha: BASE_SHA,
      mergeable: true,
      mergeableState: "clean",
      baseAncestry: true,
      changedFilesComplete: true,
      changedFilesCount: 1,
      requiredChecks: ["ci", "hygiene", "enforce-target", "mergeable"],
      expectedAppIds: { ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 },
      changedFiles: [{ filename: "src/feature.ts" }],
      checkRuns: [
        { id: 1, name: "ci", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 2, name: "hygiene", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 3, name: "enforce-target", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 4, name: "mergeable", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 8, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } },
      ],
    });
    assert.equal(result.ready, true);
    assert.equal(result.source, "autonomous-sync");
  });

  it("rejects deterministic sync with sensitive paths or agent resolution", () => {
    const base = {
      pr: pr({ head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, body: "<!-- opencodex-fork-sync -->" }),
      provenance: {
        trusted: true,
        authenticated: true,
        kind: "deterministic-sync",
        producerIdentity: "fork-upstream-sync",
      }, expectedTrustedProducerIdentity: "fork-upstream-sync", liveHeadSha: SHA, expectedBugbotAppId: 777,
      currentBaseSha: BASE_SHA, expectedBaseSha: BASE_SHA, mergeable: true, mergeableState: "clean", baseAncestry: true,
      changedFilesComplete: true, changedFilesCount: 1, requiredChecks: ["ci", "hygiene", "enforce-target", "mergeable"],
      expectedAppIds: { ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 },
      checkRuns: [
        { id: 1, name: "ci", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 2, name: "hygiene", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 3, name: "enforce-target", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 4, name: "mergeable", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 8, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } },
      ],
    };
    assert.equal(botMergeEvidence({ ...base, changedFiles: [{ filename: ".github/workflows/ci.yml" }] }).ready, false);
    assert.equal(botMergeEvidence({ ...base, changedFiles: [{ filename: "src/feature.ts" }], agentResolved: true }).ready, false);
  });

  it("recomputes the exact-head gate instead of trusting an injected passing gate", () => {
    const result = botMergeEvidence({
      pr: pr({
        head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } },
        body: "<!-- opencodex-fork-sync -->",
      }),
      provenance: { trusted: true, authenticated: true, kind: "deterministic-sync", producerIdentity: "fork-upstream-sync" },
      expectedTrustedProducerIdentity: "fork-upstream-sync",
      liveHeadSha: SHA,
      expectedBugbotAppId: 777,
      headGate: { ok: true, safeForAutomation: true, failures: [] },
      checkRuns: [{ id: 8, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } }],
      changedFiles: [{ filename: "src/feature.ts" }],
    });
    assert.equal(result.ready, false);
  });

  it("cannot let Jules evidence bypass the universal exact-head gate", () => {
    const result = botMergeEvidence({
      pr: pr({
        user: { id: 900 },
        labels: ["autonomous-fix"],
      }),
      headCommit: { sha: SHA, author: { id: 900 }, committer: { id: 900 } },
      expectedJulesUserId: 900,
      authorizedSessionId: "session-1",
      sessionId: "session-1",
      expectedBugbotAppId: 777,
      headGate: passingGate({ baseAncestry: false }),
      checkRuns: [
        { id: 1, name: "ci", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 2, name: "hygiene", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 3, name: "enforce-target", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 15368 } },
        { id: 4, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } },
      ],
    });
    assert.equal(result.ready, false);
  });

  it("requires the completed Jules classification lane", () => {
    const valid = {
      pr: pr({ user: { id: 900 }, labels: ["autonomous-fix"], julesState: "COMPLETED" }),
      headCommit: { sha: SHA, author: { id: 900 }, committer: { id: 900 } },
      expectedJulesUserId: 900,
      authorizedSessionId: "session-1",
      sessionId: "session-1",
      expectedBugbotAppId: 777,
      ...passingGateInput(),
      checkRuns: [
        ...passingGateInput().checkRuns,
        { id: 4, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } },
      ],
    };
    assert.equal(botMergeEvidence(valid).ready, true);
    const cases = [
      ["draft", { draft: true }],
      ["hold", { labels: ["autonomous-fix", "automation:hold"] }],
      ["fork", { head: { ref: "fix/jules", sha: SHA, repo: { full_name: "someone/opencodex" } } }],
      ["stacked", { base: { ref: "parent", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } }, basePullRequest: { state: "open" } }],
      ["promotion", { base: { ref: "main", sha: BASE_SHA, repo: { full_name: "yansigit/opencodex" } }, head: { ref: "dev", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, title: "promote: dev to main" }],
      ["active session", { julesState: "IN_PROGRESS" }],
    ];
    for (const [name, overrides] of cases) {
      assert.equal(botMergeEvidence({ ...valid, pr: pr({ ...overrides, user: { id: 900 }, labels: ["autonomous-fix", ...(overrides.labels || [])] }) }).ready, false, name);
    }
  });

  it("never authorizes a stacked Jules PR when the base ref is still dev", () => {
    const valid = {
      pr: pr({ user: { id: 900 }, labels: ["autonomous-fix"], julesState: "COMPLETED", openParentPullRequest: true }),
      headCommit: { sha: SHA, author: { id: 900 }, committer: { id: 900 } },
      expectedJulesUserId: 900,
      authorizedSessionId: "session-1",
      sessionId: "session-1",
      expectedBugbotAppId: 777,
      ...passingGateInput(),
      checkRuns: [
        ...passingGateInput().checkRuns,
        { id: 4, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } },
      ],
    };
    const classification = classifyPullRequest({ pr: valid.pr, repository: "yansigit/opencodex" });
    assert.equal(classification.class, "stacked");
    assert.equal(botMergeEvidence(valid).ready, false);
  });

  it("rejects a bare trusted provenance boolean", () => {
    const result = botMergeEvidence({
      pr: pr({ head: { ref: "sync/upstream-v2.36.1-abcdef1", sha: SHA, repo: { full_name: "yansigit/opencodex" } }, body: "<!-- opencodex-fork-sync -->" }),
      trustedProvenance: true,
      liveHeadSha: SHA,
      expectedBugbotAppId: 777,
      currentBaseSha: BASE_SHA,
      expectedBaseSha: BASE_SHA,
      mergeable: true,
      mergeableState: "clean",
      baseAncestry: true,
      changedFilesComplete: true,
      changedFilesCount: 1,
      requiredChecks: ["ci", "hygiene", "enforce-target", "mergeable"],
      expectedAppIds: { ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 },
      checkRuns: [{ id: 8, name: "Cursor Bugbot", head_sha: SHA, status: "completed", conclusion: "success", app: { id: 777 } }],
      changedFiles: [{ filename: "src/feature.ts" }],
    });
    assert.equal(result.ready, false);
  });
});

describe("automation hold aging", () => {
  it("summarizes holds older than 24 hours without removing them", () => {
    const aged = summarizeAgedHolds([
      { number: 12, title: "old", labels: ["automation:hold"], holdSince: "2026-08-26T00:00:00.000Z" },
      { number: 13, title: "new", labels: ["automation:hold"], holdSince: "2026-08-28T00:00:00.000Z" },
    ], "2026-08-28T12:00:00.000Z");
    assert.deepEqual(aged, [{ number: 12, title: "old", ageHours: 60 }]);
  });
});

describe("buildAutomationComment", () => {
  it("builds one deterministic bot-owned comment", () => {
    const input = {
      classification: { class: "deterministic-sync", reason: "deterministic-sync" },
      headSha: SHA,
      baseSha: BASE_SHA,
      action: "updated",
      exactHeadGate: { ok: true, safeForAutomation: true, failures: [], sensitive: false },
      approvalEvidence: { approved: false, reason: "not-required" },
      botMergeEvidence: { ready: true, source: "autonomous-sync" },
    };
    const first = buildAutomationComment(input);
    assert.equal(first, buildAutomationComment(input));
    assert.match(first, new RegExp(`^${AUTOMATION_COMMENT_MARKER}`));
    assert.match(first, /deterministic-sync/);
    assert.match(first, new RegExp(SHA));
    assert.match(first, /autonomous-sync/);
  });
});
