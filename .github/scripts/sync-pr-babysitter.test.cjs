"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  PROGRESS_MARKER,
  buildProgressComment,
  latestChecks,
  summarizeChecks,
} = require("./sync-pr-babysitter.cjs");

const workflow = fs.readFileSync(
  path.join(__dirname, "../workflows/sync-pr-babysitter.yml"),
  "utf8",
);

describe("sync PR babysitter", () => {
  it("reconciles PR updates and completed checks", () => {
    assert.match(workflow, /^  pull_request_target:/m);
    assert.match(workflow, /^  check_run:/m);
    assert.match(workflow, /^  status:/m);
    assert.match(workflow, /actions\.createWorkflowDispatch/);
    assert.match(workflow, /workflow_id: "enforce-pr-target\.yml"/);
    assert.match(workflow, /sync-pr-babysitter\.cjs/);
    assert.match(workflow, /cursor-sync-progress/);
  });

  it("observes agent-owned branches without updating them", () => {
    assert.doesNotMatch(workflow, /contents:\s*write/);
    assert.doesNotMatch(workflow, /git\s+(?:push|merge|checkout)/);
    assert.doesNotMatch(workflow, /Auto-rebase stale/);
  });

  it("uses the newest result for duplicate check names", () => {
    const checks = latestChecks([
      { id: 2, name: "ci", status: "completed", conclusion: "failure" },
      { id: 3, name: "hygiene", status: "completed", conclusion: "success" },
      { id: 4, name: "ci", status: "completed", conclusion: "success" },
    ]);
    assert.deepEqual(checks.map(check => [check.name, check.id]), [["ci", 4], ["hygiene", 3]]);
  });

  it("reports failed and pending checks without treating skipped as failures", () => {
    const summary = summarizeChecks([
      { id: 1, name: "ci", status: "completed", conclusion: "failure" },
      { id: 2, name: "test 1/4", status: "in_progress", conclusion: null },
      { id: 3, name: "windows", status: "completed", conclusion: "skipped" },
    ]);
    assert.deepEqual(summary.failed.map(check => check.name), ["ci"]);
    assert.deepEqual(summary.pending.map(check => check.name), ["test 1/4"]);
    assert.deepEqual(summary.successful.map(check => check.name), ["windows"]);
  });

  it("builds one exact-head progress comment with mergeability and Cursor status", () => {
    const sha = "a".repeat(40);
    const body = buildProgressComment({
      headSha: sha,
      mergeable: false,
      mergeableState: "dirty",
      checkRuns: [
        {
          id: 1,
          name: "ci",
          status: "completed",
          conclusion: "failure",
          details_url: "https://github.com/yansigit/opencodex/actions/runs/1",
        },
        { id: 2, name: "Cursor Bugbot", status: "in_progress", conclusion: null },
      ],
    });
    assert.equal(body.includes(PROGRESS_MARKER), true);
    assert.match(body, new RegExp("Head: `" + sha + "`"));
    assert.match(body, /DIRTY \/ not mergeable/);
    assert.match(body, /`ci` — failure/);
    assert.match(body, /Cursor Bugbot: `Cursor Bugbot` — in_progress/);
    assert.match(body, /never updates or merges the branch/);
  });
});
