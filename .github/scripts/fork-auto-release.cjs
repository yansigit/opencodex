"use strict";

const { spawnSync } = require("node:child_process");

const FULL_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = "@yansigit/opencodex";

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredSha(value, name) {
  requiredString(value, name);
  if (!FULL_SHA.test(value)) {
    throw new TypeError(`${name} must be a full 40-character commit SHA`);
  }
  return value;
}

function skipsAutoRelease(rawCommitMessage) {
  const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
    input: rawCommitMessage,
    encoding: "utf8",
  });
  if (parsed.error || parsed.status !== 0) {
    throw new Error(parsed.error?.message || parsed.stderr.trim() || "git trailer parsing failed");
  }
  return parsed.stdout.split(/\r?\n/).includes("Auto-Release: skip");
}

/**
 * Decide whether a successful main-branch CI completion may dispatch release.yml.
 *
 * The function is centralized so publish eligibility can be tested without
 * GitHub or npm credentials; Git remains the authority for trailer parsing.
 */
function decideForkAutoRelease({
  eventName,
  workflowName,
  conclusion,
  headBranch,
  headSha,
  liveMainSha,
  packageName,
  packageVersion,
  rawCommitMessage,
  versionOnNpm,
  workflowEvent,
  workflowPath,
  workflowRepository,
  repository,
}) {
  requiredString(eventName, "eventName");
  requiredString(workflowName, "workflowName");
  requiredString(conclusion, "conclusion");
  requiredString(headBranch, "headBranch");
  requiredSha(headSha, "headSha");
  requiredSha(liveMainSha, "liveMainSha");
  requiredString(packageName, "packageName");
  requiredString(packageVersion, "packageVersion");
  requiredString(rawCommitMessage, "rawCommitMessage");
  if (!rawCommitMessage.trim()) {
    throw new TypeError("rawCommitMessage must be a non-empty string");
  }

  if (!SEMVER.test(packageVersion)) {
    throw new TypeError("packageVersion must be valid semver");
  }
  if (versionOnNpm !== undefined && versionOnNpm !== null && typeof versionOnNpm !== "string") {
    throw new TypeError("versionOnNpm must be a string when provided");
  }

  if (eventName !== "workflow_run") {
    return { action: "skip", reason: `event must be workflow_run; got ${eventName}.` };
  }
  if (workflowName !== "Build release candidate") {
    return { action: "skip", reason: `triggering workflow must be Build release candidate (from Cross-platform CI); got ${workflowName}.` };
  }
  requiredString(workflowEvent, "workflowEvent");
  requiredString(workflowPath, "workflowPath");
  requiredString(workflowRepository, "workflowRepository");
  requiredString(repository, "repository");
  if (workflowEvent !== "workflow_run" || workflowPath !== ".github/workflows/release-candidate.yml") {
    return { action: "skip", reason: "candidate run provenance is not the trusted workflow_run release-candidate workflow." };
  }
  if (workflowRepository !== repository) {
    return { action: "skip", reason: `candidate run repository must match ${repository}; got ${workflowRepository}.` };
  }
  if (conclusion !== "success") {
    return { action: "skip", reason: `CI conclusion must be success; got ${conclusion}.` };
  }
  if (headBranch !== "main") {
    return { action: "skip", reason: `CI head branch must be main; got ${headBranch}.` };
  }
  if (headSha !== liveMainSha) {
    return {
      action: "skip",
      reason: `live main moved after CI; audited ${headSha}, current ${liveMainSha}.`,
    };
  }
  if (packageName !== PACKAGE_NAME) {
    return {
      action: "skip",
      reason: `package must be ${PACKAGE_NAME}; got ${packageName}.`,
    };
  }
  if (packageVersion.includes("-")) {
    return {
      action: "skip",
      reason: `package version must be stable semver; got ${packageVersion}.`,
    };
  }
  if (skipsAutoRelease(rawCommitMessage)) {
    return {
      action: "skip",
      reason: "commit trailer requested skipping automatic release.",
    };
  }
  if (versionOnNpm) {
    return {
      action: "skip",
      reason: `${PACKAGE_NAME}@${packageVersion} is already published on npm.`,
    };
  }

  return { action: "dispatch" };
}

function decideFromEnv(env = process.env) {
  const input = {
    eventName: env.EVENT_NAME,
    workflowName: env.WORKFLOW_NAME,
    conclusion: env.CONCLUSION,
    headBranch: env.HEAD_BRANCH,
    headSha: env.HEAD_SHA,
    liveMainSha: env.LIVE_MAIN_SHA,
    packageName: env.PACKAGE_NAME,
    packageVersion: env.PACKAGE_VERSION,
    rawCommitMessage: env.RAW_COMMIT_MESSAGE,
    workflowEvent: env.WORKFLOW_EVENT,
    workflowPath: env.WORKFLOW_PATH,
    workflowRepository: env.WORKFLOW_REPOSITORY,
    repository: env.GITHUB_REPOSITORY,
  };
  if (Object.prototype.hasOwnProperty.call(env, "VERSION_ON_NPM")) {
    input.versionOnNpm = env.VERSION_ON_NPM;
  }
  return decideForkAutoRelease(input);
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(decideFromEnv()));
}

module.exports = {
  decideForkAutoRelease,
  decideFromEnv,
};
