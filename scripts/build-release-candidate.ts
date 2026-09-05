#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commandInvocation } from "../src/lib/win-exec";
import {
  encodeReleaseCandidateManifest,
  RELEASE_CANDIDATE_INPUTS,
  sha256File,
  sha512IntegrityFile,
  verifyReleaseCandidateManifest,
  type ReleaseCandidateManifest,
} from "./release-candidate";

export interface BuildReleaseCandidateOptions {
  root: string;
  outputDirectory: string;
  repository: string;
  expectedSha: string;
  workflow: string;
  runId: string;
  runAttempt: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(command: string[], cwd: string): Promise<CommandResult> {
  const [program, ...args] = command;
  const invocation = commandInvocation(program ?? "", args);
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function capture(command: string[], cwd: string): Promise<string> {
  const result = await run(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`);
  }
  return result.stdout;
}

function parsePackOutput(stdout: string): { filename: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value) || value.length !== 1) throw new Error("npm pack must produce exactly one package");
  const record = value[0];
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("npm pack result is malformed");
  const filename = (record as Record<string, unknown>).filename;
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("/") || filename.includes("\\") || !filename.endsWith(".tgz")) {
    throw new Error("npm pack returned an unsafe package filename");
  }
  return { filename };
}

function requiredString(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

/** Build exactly one tarball and atomically expose it with its canonical manifest. */
export async function buildReleaseCandidate(options: BuildReleaseCandidateOptions): Promise<ReleaseCandidateManifest> {
  const root = resolve(options.root);
  const outputDirectory = resolve(options.outputDirectory);
  if (existsSync(outputDirectory)) throw new Error("release candidate output already exists");

  const expectedSha = requiredString(options.expectedSha, "expected SHA");
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("expected SHA must be a lowercase full Git SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new Error("repository must be owner/repository");
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(options.runId)) throw new Error("run ID must be canonical decimal digits");
  if (!Number.isSafeInteger(options.runAttempt) || options.runAttempt < 1) throw new Error("run attempt must be a positive safe integer");
  const actualSha = await capture(["git", "rev-parse", "HEAD"], root);
  if (actualSha !== expectedSha) throw new Error(`checked-out commit mismatch: expected ${expectedSha}, got ${actualSha}`);
  const worktreeStatus = await capture(["git", "status", "--porcelain", "--untracked-files=all"], root);
  if (worktreeStatus !== "") throw new Error("release candidate checkout contains tracked or untracked changes");
  const treeSha = await capture(["git", "rev-parse", "HEAD^{tree}"], root);

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error("package.json must contain string name and version fields");
  }

  const inputs = RELEASE_CANDIDATE_INPUTS.map((path) => {
    const absolutePath = join(root, ...path.split("/"));
    if (!statSync(absolutePath).isFile()) throw new Error(`release input is not a file: ${path}`);
    return { path, sha256: sha256File(absolutePath) };
  });

  mkdirSync(dirname(outputDirectory), { recursive: true });
  const stagingDirectory = `${outputDirectory}.tmp-${randomUUID()}`;
  mkdirSync(stagingDirectory, { recursive: false });
  try {
    // This is the sole package assembly. Publishing consumes this tarball; it must never repack.
    const packOutput = await capture(["npm", "pack", "--silent", "--json", "--pack-destination", stagingDirectory], root);
    const packed = parsePackOutput(packOutput);
    const packagePath = join(stagingDirectory, packed.filename);
    const packageStat = statSync(packagePath);
    if (!packageStat.isFile() || packageStat.size <= 0) throw new Error("npm pack did not create a non-empty tarball");

    const manifest: ReleaseCandidateManifest = {
      schemaVersion: 1,
      source: {
        repository: requiredString(options.repository, "repository"),
        commitSha: actualSha,
        treeSha,
      },
      package: {
        name: packageJson.name,
        version: packageJson.version,
        filename: packed.filename,
        sha256: sha256File(packagePath),
        integritySha512: sha512IntegrityFile(packagePath),
        sizeBytes: packageStat.size,
      },
      inputs,
      builder: {
        bunVersion: Bun.version,
        workflow: requiredString(options.workflow, "workflow"),
        runId: requiredString(options.runId, "run ID"),
        runAttempt: options.runAttempt,
      },
    };
    const manifestPath = join(stagingDirectory, "release-candidate.json");
    writeFileSync(manifestPath, encodeReleaseCandidateManifest(manifest), { encoding: "utf8", flag: "wx" });
    verifyReleaseCandidateManifest(readFileSync(manifestPath), {
      repository: options.repository,
      commitSha: expectedSha,
      treeSha,
      packagePath,
      inputRoot: root,
    });
    renameSync(stagingDirectory, outputDirectory);
    return manifest;
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function usage(): never {
  console.error("Usage: bun scripts/build-release-candidate.ts --sha <40-hex> --repository <owner/repo> --output <directory> [--workflow name] [--run-id digits] [--run-attempt number]");
  process.exit(2);
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const allowedFlags = new Set(["--sha", "--repository", "--output", "--workflow", "--run-id", "--run-attempt"]);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowedFlags.has(flag) || !value || values.has(flag)) usage();
    values.set(flag, value);
  }
  const expectedSha = values.get("--sha");
  const repository = values.get("--repository");
  const outputDirectory = values.get("--output");
  if (!expectedSha || !repository || !outputDirectory) usage();
  const runAttempt = Number(values.get("--run-attempt") ?? "1");
  const manifest = await buildReleaseCandidate({
    root: resolve(import.meta.dir, ".."),
    outputDirectory,
    repository,
    expectedSha,
    workflow: values.get("--workflow") ?? "local-release-candidate",
    runId: values.get("--run-id") ?? "0",
    runAttempt,
  });
  console.log(`built ${manifest.package.filename} (${manifest.package.sha256})`);
}

if (import.meta.main) await main();
