import { createHash } from "node:crypto";
import { baselineFeatures, decisionHash, decisionsForRelease, loadRegistry, registryHash } from "./preservation";
import type { CommandRunner, OverlapCandidate, PreservationReport } from "./types";

type Change = { path: string; previousPath?: string; status: string };

async function runOk(runner: CommandRunner, args: readonly string[]): Promise<string> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function treeIdentity(runner: CommandRunner, commit: string, path: string): Promise<string> {
  const result = await runner(["ls-tree", commit, "--", path]);
  if (result.exitCode !== 0) return "";
  const line = result.stdout.split("\n").find(value => value.endsWith(`\t${path}`));
  return line?.split("\t", 1)[0] ?? "";
}

async function blobId(runner: CommandRunner, commit: string, path: string): Promise<string> {
  return (await treeIdentity(runner, commit, path)).match(/^[0-9]+\s+\w+\s+(\S+)$/)?.[1] ?? "";
}

function parseChanges(output: string): Change[] {
  const changes: Change[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [status = "", first = "", second] = line.split("\t");
    if (status.startsWith("R") || status.startsWith("C")) {
      if (first && second) changes.push({ status, previousPath: first, path: second });
    } else if (first) {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

function logicalOverlap(left: Change, right: Change): boolean {
  const leftPaths = new Set([left.path, left.previousPath].filter(Boolean));
  return [right.path, right.previousPath].some(path => path && leftPaths.has(path));
}

async function diffChanges(runner: CommandRunner, from: string, to: string): Promise<Change[]> {
  return parseChanges(await runOk(runner, [
    "diff", "--find-renames", "--find-copies", "--name-status", "--diff-filter=ACDMRT",
    from, to, "--",
  ]));
}

function candidateKey(candidate: Pick<OverlapCandidate, "path" | "classification">): string {
  return `${candidate.path}\0${candidate.classification}`;
}

export async function analyzeOverlap(options: {
  runner: CommandRunner;
  base: string;
  fork: string;
  upstream: string;
  merge: string;
  dev: string;
  tag: string;
}): Promise<PreservationReport> {
  const { runner, base, fork, upstream, merge, dev, tag } = options;
  const bases = (await runOk(runner, ["merge-base", "--all", fork, upstream]))
    .split(/\r?\n/).filter(Boolean);
  if (bases.length !== 1 || bases[0] !== base) {
    throw new Error(`unique merge-base required: expected ${base}, got ${bases.join(",") || "none"}`);
  }

  const registry = loadRegistry();
  const releaseDecisions = decisionsForRelease(registry, tag);
  const forkChanges = await diffChanges(runner, base, fork);
  const upstreamChanges = await diffChanges(runner, base, upstream);
  const mergeChanges = await diffChanges(runner, base, merge);
  const candidates = new Map<string, OverlapCandidate>();

  const add = async (path: string, classification: string, renameFrom?: string) => {
    const decision = releaseDecisions[path]?.disposition;
    const candidate: OverlapCandidate = {
      path,
      baseBlob: await blobId(runner, base, renameFrom ?? path),
      forkBlob: await blobId(runner, fork, path),
      upstreamBlob: await blobId(runner, upstream, path),
      mergeBlob: await blobId(runner, merge, path),
      classification,
      ...(renameFrom ? { renameFrom } : {}),
      ...(decision ? { decision } : {}),
    };
    candidates.set(candidateKey(candidate), candidate);
  };

  for (const forkChange of forkChanges) {
    for (const upstreamChange of upstreamChanges) {
      if (logicalOverlap(forkChange, upstreamChange)) {
        await add(forkChange.path, "overlapping-logical-path", forkChange.previousPath);
        break;
      }
    }

    const forkBlob = await blobId(runner, fork, forkChange.path);
    const upstreamBlob = await blobId(runner, upstream, forkChange.path);
    const mergeBlob = await blobId(runner, merge, forkChange.path);
    if (forkBlob && !mergeBlob) {
      const mergeRename = mergeChanges.find(change => change.previousPath === forkChange.path);
      await add(
        mergeRename?.path ?? forkChange.path,
        mergeRename ? "fork-path-renamed-in-result" : "fork-path-deleted-in-result",
        forkChange.path,
      );
    } else if (forkBlob !== mergeBlob && mergeBlob === upstreamBlob) {
      await add(forkChange.path, "exact-upstream-blob", forkChange.previousPath);
    }
  }

  const protectedPaths = new Set(
    Object.values(baselineFeatures(registry)).flatMap(feature => feature.integrationPaths),
  );
  for (const path of protectedPaths) {
    if (await treeIdentity(runner, dev, path) !== await treeIdentity(runner, merge, path)) {
      await add(path, "preservation-registry-path-changed");
    }
  }

  const ordered = [...candidates.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || a.classification.localeCompare(b.classification));
  const decisions = Object.fromEntries(
    Object.entries(releaseDecisions).map(([path, decision]) => [path, decision.disposition]),
  );
  const status = ordered.every(candidate => candidate.decision) ? "passed" : "decision-required";
  const report: PreservationReport = {
    shas: { base, fork, upstream, merge, dev, tag },
    candidates: ordered,
    decisions,
    registryHash: registryHash(),
    decisionHash: decisionHash(registry, tag),
    status,
  };
  return report;
}

export function preservationReportHash(report: PreservationReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}
