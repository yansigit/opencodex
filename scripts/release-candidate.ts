#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const RELEASE_CANDIDATE_INPUTS = [
  "bun.lock",
  "gui/bun.lock",
  "gui/package.json",
  "package.json",
] as const;
const MAX_HASHED_FILE_BYTES = 512 * 1024 * 1024;

export interface ReleaseCandidateManifest {
  schemaVersion: 1;
  source: {
    repository: string;
    commitSha: string;
    treeSha: string;
  };
  package: {
    name: string;
    version: string;
    filename: string;
    sha256: string;
    integritySha512: string;
    sizeBytes: number;
  };
  inputs: Array<{
    path: string;
    sha256: string;
  }>;
  builder: {
    bunVersion: string;
    workflow: string;
    runId: string;
    runAttempt: number;
  };
}

export interface CandidateExpectations {
  repository?: string;
  commitSha?: string;
  treeSha?: string;
  packagePath?: string;
  inputRoot?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785-style key ordering for the JSON value types used by this manifest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical JSON accepts safe integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("canonical JSON accepts only plain JSON objects");

  return `{${Object.keys(value).sort().map((key) => {
    const entry = value[key];
    if (entry === undefined) throw new Error(`undefined value at key ${key}`);
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}

export function encodeReleaseCandidateManifest(manifest: ReleaseCandidateManifest): string {
  assertReleaseCandidateManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function sha256File(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error("refusing to hash a non-regular file");
  if (stat.size > MAX_HASHED_FILE_BYTES) throw new Error(`refusing to hash a file larger than ${MAX_HASHED_FILE_BYTES} bytes`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha512IntegrityFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`refusing to hash a non-regular file: ${path}`);
  if (stat.size > MAX_HASHED_FILE_BYTES) throw new Error(`refusing to hash a file larger than ${MAX_HASHED_FILE_BYTES} bytes`);
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty, trimmed printable string`);
  }
}

export function assertReleaseCandidateManifest(value: unknown): asserts value is ReleaseCandidateManifest {
  if (!isPlainObject(value)) throw new Error("release candidate manifest must be an object");
  exactKeys(value, ["schemaVersion", "source", "package", "inputs", "builder"], "manifest");
  if (value.schemaVersion !== 1) throw new Error("unsupported release candidate schemaVersion");

  if (!isPlainObject(value.source)) throw new Error("source must be an object");
  exactKeys(value.source, ["repository", "commitSha", "treeSha"], "source");
  nonEmptyString(value.source.repository, "source.repository");
  nonEmptyString(value.source.commitSha, "source.commitSha");
  nonEmptyString(value.source.treeSha, "source.treeSha");
  if (!REPOSITORY.test(value.source.repository)) throw new Error("source.repository must be owner/repository");
  if (!GIT_SHA.test(value.source.commitSha)) throw new Error("source.commitSha must be a lowercase full Git SHA");
  if (!GIT_SHA.test(value.source.treeSha)) throw new Error("source.treeSha must be a lowercase full Git SHA");

  if (!isPlainObject(value.package)) throw new Error("package must be an object");
  exactKeys(value.package, ["name", "version", "filename", "sha256", "integritySha512", "sizeBytes"], "package");
  nonEmptyString(value.package.name, "package.name");
  nonEmptyString(value.package.version, "package.version");
  nonEmptyString(value.package.filename, "package.filename");
  nonEmptyString(value.package.sha256, "package.sha256");
  nonEmptyString(value.package.integritySha512, "package.integritySha512");
  if (!PACKAGE_NAME.test(value.package.name)) throw new Error("package.name is invalid");
  if (!VERSION.test(value.package.version)) throw new Error("package.version must be SemVer");
  if (basename(value.package.filename) !== value.package.filename || value.package.filename.includes("\\") || !value.package.filename.endsWith(".tgz")) {
    throw new Error("package.filename must be a basename ending in .tgz");
  }
  if (!SHA256.test(value.package.sha256)) throw new Error("package.sha256 must be lowercase SHA-256");
  if (!SHA512_INTEGRITY.test(value.package.integritySha512)) {
    throw new Error("package.integritySha512 must be an npm-style SHA-512 integrity value");
  }
  if (!Number.isSafeInteger(value.package.sizeBytes) || value.package.sizeBytes <= 0) {
    throw new Error("package.sizeBytes must be a positive safe integer");
  }

  if (!Array.isArray(value.inputs) || value.inputs.length !== RELEASE_CANDIDATE_INPUTS.length) {
    throw new Error(`inputs must contain exactly: ${RELEASE_CANDIDATE_INPUTS.join(", ")}`);
  }
  let previousPath = "";
  for (const [index, input] of value.inputs.entries()) {
    if (!isPlainObject(input)) throw new Error(`inputs[${index}] must be an object`);
    exactKeys(input, ["path", "sha256"], `inputs[${index}]`);
    nonEmptyString(input.path, `inputs[${index}].path`);
    nonEmptyString(input.sha256, `inputs[${index}].sha256`);
    if (input.path.startsWith("/") || input.path.includes("\\") || input.path.split("/").some(part => part === "" || part === "." || part === "..")) {
      throw new Error(`inputs[${index}].path must be a normalized relative POSIX path`);
    }
    if (!SHA256.test(input.sha256)) throw new Error(`inputs[${index}].sha256 must be lowercase SHA-256`);
    if (input.path <= previousPath) throw new Error("inputs must be unique and sorted by path");
    if (input.path !== RELEASE_CANDIDATE_INPUTS[index]) {
      throw new Error(`inputs must contain exactly: ${RELEASE_CANDIDATE_INPUTS.join(", ")}`);
    }
    previousPath = input.path;
  }

  if (!isPlainObject(value.builder)) throw new Error("builder must be an object");
  exactKeys(value.builder, ["bunVersion", "workflow", "runId", "runAttempt"], "builder");
  nonEmptyString(value.builder.bunVersion, "builder.bunVersion");
  nonEmptyString(value.builder.workflow, "builder.workflow");
  nonEmptyString(value.builder.runId, "builder.runId");
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.builder.runId)) throw new Error("builder.runId must be canonical decimal digits");
  if (!Number.isSafeInteger(value.builder.runAttempt) || value.builder.runAttempt < 1) {
    throw new Error("builder.runAttempt must be a positive safe integer");
  }
}

export function parseReleaseCandidateManifest(bytes: string | Uint8Array): ReleaseCandidateManifest {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`release candidate manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertReleaseCandidateManifest(value);
  if (text !== encodeReleaseCandidateManifest(value)) {
    throw new Error("release candidate manifest is not in canonical JSON form");
  }
  return value;
}

export function verifyReleaseCandidateManifest(
  bytes: string | Uint8Array,
  expectations: CandidateExpectations = {},
): ReleaseCandidateManifest {
  const manifest = parseReleaseCandidateManifest(bytes);
  if (expectations.repository !== undefined && manifest.source.repository !== expectations.repository) {
    throw new Error(`repository mismatch: expected ${expectations.repository}, got ${manifest.source.repository}`);
  }
  if (expectations.commitSha !== undefined && manifest.source.commitSha !== expectations.commitSha) {
    throw new Error(`commit SHA mismatch: expected ${expectations.commitSha}, got ${manifest.source.commitSha}`);
  }
  if (expectations.treeSha !== undefined && manifest.source.treeSha !== expectations.treeSha) {
    throw new Error(`tree SHA mismatch: expected ${expectations.treeSha}, got ${manifest.source.treeSha}`);
  }
  if (expectations.packagePath !== undefined) {
    const stat = statSync(expectations.packagePath);
    if (!stat.isFile() || stat.size !== manifest.package.sizeBytes) throw new Error("candidate package size does not match manifest");
    if (basename(expectations.packagePath) !== manifest.package.filename) throw new Error("candidate package filename does not match manifest");
    if (sha256File(expectations.packagePath) !== manifest.package.sha256) throw new Error("candidate package digest does not match manifest");
    if (sha512IntegrityFile(expectations.packagePath) !== manifest.package.integritySha512) {
      throw new Error("candidate package integrity does not match manifest");
    }
  }
  if (expectations.inputRoot !== undefined) {
    for (const input of manifest.inputs) {
      const path = join(expectations.inputRoot, ...input.path.split("/"));
      if (sha256File(path) !== input.sha256) throw new Error(`input digest does not match manifest: ${input.path}`);
    }
  }
  return manifest;
}

function usage(): never {
  console.error("Usage: bun scripts/release-candidate.ts verify <manifest> <package> [--repository owner/repo] [--sha 40-hex] [--tree 40-hex] [--input-root path]");
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, manifestPath, packagePath, ...args] = process.argv.slice(2);
  if (command !== "verify" || !manifestPath || !packagePath) usage();
  const options: CandidateExpectations = { packagePath };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) usage();
    if (flag === "--repository") options.repository = value;
    else if (flag === "--sha") options.commitSha = value;
    else if (flag === "--tree") options.treeSha = value;
    else if (flag === "--input-root") options.inputRoot = value;
    else usage();
  }
  const manifest = verifyReleaseCandidateManifest(readFileSync(manifestPath), options);
  console.log(`${manifest.package.filename} verified at ${manifest.source.commitSha}`);
}

if (import.meta.main) await main();
