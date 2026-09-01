"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildSyncRepairIssue,
  syncCiRepairDisposition,
  syncFreshnessDisposition,
  syncRepairMarker,
} = require("./pr-automation-sync-supervisor.cjs");

const HEAD = "a".repeat(40);
const RELEASE = "b".repeat(40);
const REPOSITORY = "yansigit/opencodex";

function syncPr(overrides = {}) {
  return {
    number: 184,
    state: "open",
    body: "<!-- opencodex-fork-sync -->\nGenerated sync.",
    base: { ref: "dev", repo: { full_name: REPOSITORY } },
    head: { ref: "sync/upstream-v2.39.0-abcdef1", sha: HEAD, repo: { full_name: REPOSITORY } },
    user: { id: 41898282, type: "Bot", login: "github-actions[bot]" },
    ...overrides,
  };
}

function ci(conclusion, overrides = {}) {
  return {
    id: 900,
    name: "ci",
    head_sha: HEAD,
    status: "completed",
    conclusion,
    app: { id: 15368 },
    ...overrides,
  };
}

describe("syncCiRepairDisposition", () => {
  it("routes a trusted exact-head CI failure to repair", () => {
    assert.deepEqual(syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci("failure")], repository: REPOSITORY,
    }), {
      action: "repair",
      reason: "ci-failure",
      branch: "sync/upstream-v2.39.0-abcdef1",
      checkRunId: 900,
      headSha: HEAD,
    });
  });

  it("waits for pending CI and accepts successful CI", () => {
    assert.equal(syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci(null, { status: "in_progress" })], repository: REPOSITORY,
    }).action, "wait");
    assert.equal(syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci("success")], repository: REPOSITORY,
    }).action, "healthy");
  });

  it("rejects spoofed, stale, forked, and malformed sync inputs", () => {
    const cases = [
      syncPr({ user: { id: 10, type: "User" } }),
      syncPr({ body: "looks like a sync" }),
      syncPr({ head: { ref: "sync/upstream-v2.39.0-abcdef1", sha: HEAD, repo: { full_name: "attacker/opencodex" } } }),
      syncPr({ head: { ref: "feature/not-sync", sha: HEAD, repo: { full_name: REPOSITORY } } }),
    ];
    for (const pr of cases) {
      assert.equal(syncCiRepairDisposition({ pr, checkRuns: [ci("failure")], repository: REPOSITORY }).action, "ignore");
    }
    assert.equal(syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci("failure", { head_sha: RELEASE })], repository: REPOSITORY,
    }).action, "wait");
    assert.equal(syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci("failure", { app: { id: 1 } })], repository: REPOSITORY,
    }).action, "wait");
  });
});

describe("sync repair issue", () => {
  it("is deterministic, deduplicated by PR and exact head, and Jules-routable", () => {
    const disposition = syncCiRepairDisposition({
      pr: syncPr(), checkRuns: [ci("timed_out")], repository: REPOSITORY,
    });
    const issue = buildSyncRepairIssue({ pr: syncPr(), disposition });
    assert.equal(issue.marker, syncRepairMarker(184, HEAD));
    assert.match(issue.title, /^\[agent:sync\]/);
    assert.match(issue.body, /Sync branch: sync\/upstream-v2\.39\.0-abcdef1/);
    assert.match(issue.body, /Do not weaken required checks/);
  });
});

describe("syncFreshnessDisposition", () => {
  it("dispatches when the stable release is behind and no run is active or cooling down", () => {
    assert.equal(syncFreshnessDisposition({
      latestReleaseSha: RELEASE,
      vendorMainSha: HEAD,
      workflowRuns: [{ status: "completed", updated_at: "2026-09-01T00:00:00Z" }],
      now: Date.parse("2026-09-01T02:00:00Z"),
    }).action, "dispatch");
  });

  it("does not duplicate current, active, or recently completed sync work", () => {
    assert.equal(syncFreshnessDisposition({ latestReleaseSha: RELEASE, vendorMainSha: RELEASE }).action, "current");
    assert.equal(syncFreshnessDisposition({
      latestReleaseSha: RELEASE, vendorMainSha: HEAD, workflowRuns: [{ status: "queued" }],
    }).reason, "sync-active");
    assert.equal(syncFreshnessDisposition({
      latestReleaseSha: RELEASE,
      vendorMainSha: HEAD,
      workflowRuns: [{ status: "completed", updated_at: "2026-09-01T01:30:00Z" }],
      now: Date.parse("2026-09-01T02:00:00Z"),
    }).reason, "retry-cooldown");
  });

  it("fails closed when release provenance is malformed", () => {
    assert.equal(syncFreshnessDisposition({ latestReleaseSha: "main", vendorMainSha: HEAD }).action, "error");
  });
});
