const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function decidePostRelease(state) {
  if (
    state.workflowName !== "Release" ||
    !["workflow_dispatch", "repository_dispatch"].includes(state.workflowEvent) ||
    state.workflowBranch !== "main" ||
    state.repository !== state.expectedRepository ||
    state.workflowPath !== state.expectedWorkflowPath ||
    !STABLE_VERSION.test(state.releaseVersion) ||
    state.publishedVersion !== state.releaseVersion ||
    !validTimestamp(state.releaseRunStartedAt) ||
    !validTimestamp(state.releasePublishedAt) ||
    Date.parse(state.releasePublishedAt) < Date.parse(state.releaseRunStartedAt) ||
    state.tagSha !== state.expectedSha ||
    state.mainSha !== state.expectedSha
  ) return "skip";

  if (state.devSha === state.mainSha) return "bump";
  if (state.devIsAncestor && state.treesIdentical) return "bump";
  if (state.mainIsAncestor && state.devVersion === state.releaseVersion) return "bump";
  if (state.mainIsAncestor && state.devVersion === state.nextVersion) return "noop";
  return "skip";
}

module.exports = { decidePostRelease };
