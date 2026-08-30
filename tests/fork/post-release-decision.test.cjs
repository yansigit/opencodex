const test = require("node:test");
const assert = require("node:assert/strict");
const { decidePostRelease } = require("../../.github/scripts/fork-post-release-decision.cjs");

const base = {
  workflowName: "Release",
  workflowEvent: "workflow_dispatch",
  workflowBranch: "main",
  workflowPath: ".github/workflows/release.yml",
  repository: "yansigit/opencodex",
  expectedRepository: "yansigit/opencodex",
  expectedWorkflowPath: ".github/workflows/release.yml",
  releaseVersion: "2.36.0",
  publishedVersion: "2.36.0",
  tagSha: "main-sha",
  expectedSha: "main-sha",
  mainSha: "main-sha",
  devSha: "main-sha",
  nextVersion: "2.36.1",
  releaseRunStartedAt: "2026-08-28T19:00:00Z",
  releasePublishedAt: "2026-08-28T19:05:00Z",
};

test("published and tagged release with dev at main requests a bump", () => {
  assert.equal(decidePostRelease(base), "bump");
  assert.equal(decidePostRelease({ ...base, workflowEvent: "repository_dispatch" }), "bump");
});

test("requires the exact expected workflow path and a publication during the run", () => {
  assert.equal(decidePostRelease({ ...base, expectedWorkflowPath: ".github/workflows/other.yml" }), "skip");
  assert.equal(decidePostRelease({ ...base, releasePublishedAt: "2026-08-28T18:59:00Z" }), "skip");
});

test("dev ancestor of identical-tree main requests a bump", () => {
  assert.equal(decidePostRelease({ ...base, mainSha: "main-sha", devSha: "dev-sha", devIsAncestor: true, treesIdentical: true }), "bump");
});

test("main ancestor already carrying the exact successor is idempotent", () => {
  assert.equal(decidePostRelease({ ...base, devSha: "dev-sha", mainSha: "main-sha", mainIsAncestor: true, devVersion: "2.36.1" }), "noop");
});

test("main ancestor with newer dev work still carrying the released version requests a bump", () => {
  assert.equal(decidePostRelease({ ...base, devSha: "dev-sha", mainSha: "main-sha", mainIsAncestor: true, devVersion: "2.36.0" }), "bump");
});

test("missing or mismatched publication and tag fail closed", () => {
  for (const change of [
    { publishedVersion: undefined },
    { publishedVersion: "2.35.9" },
    { tagSha: undefined },
    { tagSha: "other-sha" },
    { repository: undefined },
    { workflowPath: undefined },
  ]) assert.equal(decidePostRelease({ ...base, ...change }), "skip");
});

test("wrong workflow identity and unexpected dev state fail closed", () => {
  for (const change of [
    { workflowName: "Cross-platform CI" },
    { workflowEvent: "push" },
    { workflowBranch: "dev" },
    { repository: "other/repo" },
    { workflowPath: ".github/workflows/other.yml" },
    { devSha: "other-sha" },
    { mainIsAncestor: true, devVersion: "2.35.9", devSha: "dev-sha" },
  ]) assert.equal(decidePostRelease({ ...base, ...change }), "skip");
});
