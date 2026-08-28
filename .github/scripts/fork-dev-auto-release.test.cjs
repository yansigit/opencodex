"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  computeBaseVersion,
  decideForkDevAutoRelease,
} = require("./fork-dev-auto-release.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function candidate(overrides = {}) {
  return {
    eventName: "workflow_run",
    workflowName: "Cross-platform CI",
    conclusion: "success",
    headBranch: "dev",
    headSha: SHA,
    liveDevSha: SHA,
    packageName: "@yansigit/opencodex",
    packageVersion: "2.33.1",
    latestVersionOnNpm: "2.33.1",
    runNumber: "42",
    now: new Date("2026-08-27T12:00:00Z"),
    ...overrides,
  };
}

describe("computeBaseVersion", () => {
  it("bumps patch when package.json version matches npm latest", () => {
    assert.equal(computeBaseVersion("2.33.1", "2.33.1"), "2.33.2");
  });

  it("keeps package.json version when it is already ahead of npm latest", () => {
    assert.equal(computeBaseVersion("2.34.0", "2.33.1"), "2.34.0");
    assert.equal(computeBaseVersion("3.0.0", "2.33.1"), "3.0.0");
    assert.equal(computeBaseVersion("2.33.2", "2.33.1"), "2.33.2");
  });

  it("bumps patch of npm latest when package.json trails npm latest", () => {
    assert.equal(computeBaseVersion("2.32.0", "2.33.1"), "2.33.2");
  });

  it("uses package.json version when npm latest is not available or unparseable", () => {
    assert.equal(computeBaseVersion("2.33.1"), "2.33.1");
    assert.equal(computeBaseVersion("2.33.1", ""), "2.33.1");
    assert.equal(computeBaseVersion("2.33.1", "invalid"), "2.33.1");
  });

  it("throws when package.json version is invalid semver", () => {
    assert.throws(() => computeBaseVersion("invalid"), /must be valid semver/);
  });
});

describe("fork dev auto-release decision", () => {
  it("dispatches with computed dev version from green dev CI", () => {
    const result = decideForkDevAutoRelease(candidate());
    assert.deepEqual(result, {
      action: "dispatch",
      version: "2.33.2-dev.20260827.42",
    });
  });

  it("uses package version if ahead of npm latest", () => {
    const result = decideForkDevAutoRelease(candidate({ packageVersion: "2.34.0" }));
    assert.deepEqual(result, {
      action: "dispatch",
      version: "2.34.0-dev.20260827.42",
    });
  });

  for (const [name, overrides, reason] of [
    ["skips non-workflow_run events", { eventName: "push" }, "workflow_run"],
    ["skips another triggering workflow", { workflowName: "Release" }, "Cross-platform CI"],
    ["skips unsuccessful CI", { conclusion: "failure" }, "success"],
    ["skips non-dev branches", { headBranch: "main" }, "dev"],
    ["skips a moved dev branch", { liveDevSha: OTHER_SHA }, "live dev"],
    ["skips another package", { packageName: "opencodex" }, "@yansigit/opencodex"],
    ["skips if commit already has a dev release tag", { existingCommitDevTag: "v2.33.2-dev.20260827.1" }, "already released"],
  ]) {
    it(name, () => {
      const result = decideForkDevAutoRelease(candidate(overrides));
      assert.equal(result.action, "skip");
      assert.match(result.reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }

  it("rejects an empty SHA as malformed input", () => {
    assert.throws(
      () => decideForkDevAutoRelease(candidate({ headSha: "" })),
      /headSha must be a non-empty string/,
    );
  });

  it("rejects a missing package name as malformed input", () => {
    assert.throws(
      () => decideForkDevAutoRelease(candidate({ packageName: undefined })),
      /packageName must be a non-empty string/,
    );
  });
});

describe("fork dev auto-release env CLI", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const script = join(__dirname, "fork-dev-auto-release.cjs");

  function runCli(env) {
    return spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("prints dispatch JSON from env vars without a node heredoc", () => {
    const result = runCli({
      EVENT_NAME: "workflow_run",
      WORKFLOW_NAME: "Cross-platform CI",
      CONCLUSION: "success",
      HEAD_BRANCH: "dev",
      HEAD_SHA: SHA,
      LIVE_DEV_SHA: SHA,
      PACKAGE_NAME: "@yansigit/opencodex",
      PACKAGE_VERSION: "2.33.1",
      NPM_LATEST_VERSION: "2.33.1",
      RUN_NUMBER: "10",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "dispatch");
    assert.match(parsed.version, /^2\.33\.2-dev\.[0-9]{8}\.10$/);
  });

  it("skips when commit is already released as a dev tag", () => {
    const result = runCli({
      EVENT_NAME: "workflow_run",
      WORKFLOW_NAME: "Cross-platform CI",
      CONCLUSION: "success",
      HEAD_BRANCH: "dev",
      HEAD_SHA: SHA,
      LIVE_DEV_SHA: SHA,
      PACKAGE_NAME: "@yansigit/opencodex",
      PACKAGE_VERSION: "2.33.1",
      EXISTING_COMMIT_DEV_TAG: "v2.33.2-dev.20260827.1",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "skip");
    assert.match(parsed.reason, /already released/);
  });
});
