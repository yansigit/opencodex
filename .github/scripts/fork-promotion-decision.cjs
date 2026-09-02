const { readFileSync } = require("node:fs");
const { isDeepStrictEqual } = require("node:util");

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function parseStableVersion(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts;
}

function packageWithoutVersion(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const version = value.version;
    delete value.version;
    return { value, version };
  } catch {
    return null;
  }
}

function isVersionOnlyStableSuccessor({ changedFiles, basePackage, headPackage }) {
  if (!Array.isArray(changedFiles) || changedFiles.length !== 1 || changedFiles[0] !== "package.json") return false;

  const base = packageWithoutVersion(basePackage);
  const head = packageWithoutVersion(headPackage);
  if (!base || !head || !isDeepStrictEqual(base.value, head.value)) return false;

  const baseVersion = parseStableVersion(base.version);
  const headVersion = parseStableVersion(head.version);
  if (!baseVersion || !headVersion) return false;

  const [baseMajor, baseMinor, basePatch] = baseVersion;
  const [headMajor, headMinor, headPatch] = headVersion;
  return headMajor === baseMajor && headMinor === baseMinor && headPatch === basePatch + 1;
}

function decidePromotion(state) {
  return isVersionOnlyStableSuccessor(state) ? "wait" : "promote";
}

if (require.main === module) {
  const [changedFilesPath, basePackagePath, headPackagePath] = process.argv.slice(2);
  if (!changedFilesPath || !basePackagePath || !headPackagePath) {
    console.error("usage: fork-promotion-decision.cjs <nul-changed-files> <base-package.json> <head-package.json>");
    process.exit(1);
  }

  const changedFiles = readFileSync(changedFilesPath)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const basePackage = readFileSync(basePackagePath, "utf8");
  const headPackage = readFileSync(headPackagePath, "utf8");
  process.stdout.write(decidePromotion({ changedFiles, basePackage, headPackage }));
}

module.exports = { decidePromotion, isVersionOnlyStableSuccessor };
