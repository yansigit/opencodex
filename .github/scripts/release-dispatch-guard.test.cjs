"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateReleaseDispatch } = require("./release-dispatch-guard.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const CLIENT_PAYLOAD = {
  version: "2.40.0",
  tag: "latest",
  expected_sha: SHA,
  candidate_run_id: "123",
  candidate_artifact_id: "456",
};

function validate(overrides = {}) {
  return validateReleaseDispatch({
    eventName: "workflow_dispatch",
    eventAction: "",
    ref: "refs/heads/main",
    expectedSha: SHA,
    actualSha: SHA,
    candidateRunId: "123",
    candidateArtifactId: "456",
    clientPayload: CLIENT_PAYLOAD,
    ...overrides,
  });
}

describe("release dispatch guard", () => {
  it("accepts an exact audited SHA on main", () => {
    assert.equal(validate(), null);
  });

  it("accepts an exact audited SHA on preview", () => {
    assert.equal(
      validate({ ref: "refs/heads/preview" }),
      null,
    );
  });

  it("accepts an exact audited SHA on dev", () => {
    assert.equal(
      validate({ ref: "refs/heads/dev" }),
      null,
    );
  });

  it("accepts the audited repository dispatch on main", () => {
    assert.equal(validate({
      eventName: "repository_dispatch",
      eventAction: "fork-auto-release",
    }), null);
  });

  it("rejects other events and repository dispatch actions", () => {
    assert.match(
      validate({ eventName: "push" }),
      /must be triggered by workflow_dispatch or the audited repository_dispatch/,
    );
    assert.match(
      validate({ eventName: "repository_dispatch", eventAction: "other" }),
      /Unsupported release repository_dispatch action/,
    );
    assert.match(
      validate({ eventName: "repository_dispatch", eventAction: "fork-auto-release", ref: "refs/heads/dev" }),
      /Automatic stable releases must run from main/,
    );
  });

  it("rejects release dispatches from unapproved refs", () => {
    assert.match(
      validate({ ref: "refs/heads/feature" }),
      /must run from main, preview, or dev/,
    );
  });

  it("requires expected-sha", () => {
    assert.match(
      validate({ expectedSha: "" }),
      /expected-sha is required/,
    );
  });

  it("requires a full 40-character commit SHA", () => {
    assert.match(
      validate({ expectedSha: "0123456" }),
      /full 40-character commit SHA/,
    );
  });

  it("rejects when the selected ref moved after audit", () => {
    assert.match(
      validate({ actualSha: OTHER_SHA }),
      /branch moved after the release audit/,
    );
  });

  it("requires canonical candidate run and artifact IDs", () => {
    assert.match(validate({ candidateRunId: "" }), /candidate-run-id/);
    assert.match(validate({ candidateArtifactId: "01" }), /candidate-artifact-id/);
  });

  it("keeps candidate IDs optional only for transitional manual dispatches", () => {
    assert.equal(validate({ candidateRunId: "", candidateArtifactId: "" }), null);
    assert.match(validate({ candidateRunId: "123", candidateArtifactId: "" }), /candidate-artifact-id/);
  });

  it("rejects extended, mismatched, prerelease, or non-latest automatic payloads", () => {
    assert.match(validate({ eventName: "repository_dispatch", eventAction: "fork-auto-release", clientPayload: { ...CLIENT_PAYLOAD, extra: true } }), /payload/);
    assert.match(validate({ eventName: "repository_dispatch", eventAction: "fork-auto-release", clientPayload: { ...CLIENT_PAYLOAD, version: "2.40.0-preview.1" } }), /stable SemVer/);
    assert.match(validate({ eventName: "repository_dispatch", eventAction: "fork-auto-release", clientPayload: { ...CLIENT_PAYLOAD, tag: "preview" } }), /latest dist-tag/);
    assert.match(validate({ eventName: "repository_dispatch", eventAction: "fork-auto-release", clientPayload: { ...CLIENT_PAYLOAD, candidate_run_id: "999" } }), /normalized dispatch inputs/);
  });
});
