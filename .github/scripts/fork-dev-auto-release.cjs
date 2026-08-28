"use strict";

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

function parseSemver(v) {
  const match = SEMVER.exec(v);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function computeBaseVersion(packageVersion, latestVersionOnNpm) {
  const pkgParsed = parseSemver(packageVersion);
  if (!pkgParsed) {
    throw new TypeError(`packageVersion must be valid semver; got ${packageVersion}`);
  }

  if (!latestVersionOnNpm) {
    return `${pkgParsed.major}.${pkgParsed.minor}.${pkgParsed.patch}`;
  }

  const npmParsed = parseSemver(latestVersionOnNpm);
  if (!npmParsed) {
    return `${pkgParsed.major}.${pkgParsed.minor}.${pkgParsed.patch}`;
  }

  const diffMajor = pkgParsed.major - npmParsed.major;
  const diffMinor = pkgParsed.minor - npmParsed.minor;
  const diffPatch = pkgParsed.patch - npmParsed.patch;

  if (diffMajor > 0 || (diffMajor === 0 && diffMinor > 0) || (diffMajor === 0 && diffMinor === 0 && diffPatch > 0)) {
    return `${pkgParsed.major}.${pkgParsed.minor}.${pkgParsed.patch}`;
  }

  return `${npmParsed.major}.${npmParsed.minor}.${npmParsed.patch + 1}`;
}

function formatDate(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function decideForkDevAutoRelease({
  eventName,
  workflowName,
  conclusion,
  headBranch,
  headSha,
  liveDevSha,
  packageName,
  packageVersion,
  latestVersionOnNpm,
  existingCommitDevTag,
  runNumber,
  now,
}) {
  requiredString(eventName, "eventName");
  requiredString(workflowName, "workflowName");
  requiredString(conclusion, "conclusion");
  requiredString(headBranch, "headBranch");
  requiredSha(headSha, "headSha");
  requiredSha(liveDevSha, "liveDevSha");
  requiredString(packageName, "packageName");
  requiredString(packageVersion, "packageVersion");

  if (!SEMVER.test(packageVersion)) {
    throw new TypeError("packageVersion must be valid semver");
  }

  if (eventName !== "workflow_run") {
    return { action: "skip", reason: `event must be workflow_run; got ${eventName}.` };
  }
  if (workflowName !== "Cross-platform CI") {
    return { action: "skip", reason: `triggering workflow must be Cross-platform CI; got ${workflowName}.` };
  }
  if (conclusion !== "success") {
    return { action: "skip", reason: `CI conclusion must be success; got ${conclusion}.` };
  }
  if (headBranch !== "dev") {
    return { action: "skip", reason: `CI head branch must be dev; got ${headBranch}.` };
  }
  if (headSha !== liveDevSha) {
    return {
      action: "skip",
      reason: `live dev moved after CI; audited ${headSha}, current ${liveDevSha}.`,
    };
  }
  if (packageName !== PACKAGE_NAME) {
    return {
      action: "skip",
      reason: `package must be ${PACKAGE_NAME}; got ${packageName}.`,
    };
  }
  if (existingCommitDevTag) {
    return {
      action: "skip",
      reason: `commit ${headSha} is already released as ${existingCommitDevTag}.`,
    };
  }

  const base = computeBaseVersion(packageVersion, latestVersionOnNpm);
  const dateStr = formatDate(now);
  const runNum = runNumber || "1";
  const version = `${base}-dev.${dateStr}.${runNum}`;

  return {
    action: "dispatch",
    version,
  };
}

function decideFromEnv(env = process.env) {
  return decideForkDevAutoRelease({
    eventName: env.EVENT_NAME,
    workflowName: env.WORKFLOW_NAME,
    conclusion: env.CONCLUSION,
    headBranch: env.HEAD_BRANCH,
    headSha: env.HEAD_SHA,
    liveDevSha: env.LIVE_DEV_SHA,
    packageName: env.PACKAGE_NAME,
    packageVersion: env.PACKAGE_VERSION,
    latestVersionOnNpm: env.NPM_LATEST_VERSION || undefined,
    existingCommitDevTag: env.EXISTING_COMMIT_DEV_TAG || undefined,
    runNumber: env.RUN_NUMBER,
  });
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(decideFromEnv()));
}

module.exports = {
  computeBaseVersion,
  decideForkDevAutoRelease,
  decideFromEnv,
};

