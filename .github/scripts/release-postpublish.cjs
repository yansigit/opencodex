"use strict";

const SHA_RE = /^[0-9a-f]{40}$/i;

function decideReleasePostpublish({
  expectedSha,
  npmExists,
  npmGitHead,
  tagSha,
  releaseExists,
  dryRun,
}) {
  if (!SHA_RE.test(String(expectedSha || ""))) {
    throw new Error("expected release SHA must be a full commit SHA");
  }
  if (npmExists && !SHA_RE.test(String(npmGitHead || ""))) {
    throw new Error("published npm version has no trustworthy gitHead");
  }
  if (npmExists && String(npmGitHead).toLowerCase() !== String(expectedSha).toLowerCase()) {
    throw new Error("published npm version belongs to a different commit");
  }
  if (tagSha && !SHA_RE.test(String(tagSha))) {
    throw new Error("release tag did not resolve to a commit");
  }
  if (tagSha && String(tagSha).toLowerCase() !== String(expectedSha).toLowerCase()) {
    throw new Error("release tag belongs to a different commit");
  }
  if (releaseExists && !tagSha) {
    throw new Error("GitHub Release exists without its verified tag");
  }

  if (dryRun) {
    return {
      action: "dry-run",
      publish: false,
      createTag: false,
      createRelease: false,
    };
  }

  if (!npmExists && (tagSha || releaseExists)) {
    throw new Error("Git metadata already exists before npm publication");
  }

  return {
    action: npmExists ? "resume" : "publish",
    publish: !npmExists,
    createTag: !tagSha,
    createRelease: !releaseExists,
  };
}

module.exports = { decideReleasePostpublish };
