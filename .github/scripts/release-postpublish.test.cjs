"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { decideReleasePostpublish } = require("./release-postpublish.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function decide(overrides = {}) {
  return decideReleasePostpublish({
    expectedSha: SHA,
    npmExists: false,
    npmGitHead: "",
    tagSha: "",
    releaseExists: false,
    dryRun: false,
    ...overrides,
  });
}

describe("release post-publish recovery", () => {
  it("starts a new release only when all public metadata is absent", () => {
    assert.deepEqual(decide(), {
      action: "publish",
      publish: true,
      createTag: true,
      createRelease: true,
    });
  });

  it("resumes an npm-success/tag-failure run at the exact package gitHead", () => {
    assert.deepEqual(decide({ npmExists: true, npmGitHead: SHA }), {
      action: "resume",
      publish: false,
      createTag: true,
      createRelease: true,
    });
  });

  it("makes a completed release idempotent", () => {
    assert.deepEqual(decide({
      npmExists: true,
      npmGitHead: SHA,
      tagSha: SHA,
      releaseExists: true,
    }), {
      action: "resume",
      publish: false,
      createTag: false,
      createRelease: false,
    });
  });

  it("fails closed on mismatched or incomplete provenance", () => {
    assert.throws(() => decide({ expectedSha: "short" }), /full commit SHA/);
    assert.throws(() => decide({ npmExists: true, npmGitHead: OTHER_SHA }), /different commit/);
    assert.throws(() => decide({ npmExists: true, npmGitHead: "" }), /trustworthy gitHead/);
    assert.throws(() => decide({ tagSha: OTHER_SHA }), /different commit/);
    assert.throws(() => decide({ releaseExists: true }), /without its verified tag/);
    assert.throws(() => decide({ tagSha: SHA }), /before npm publication/);
  });
});
