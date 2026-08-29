import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SERIAL_TEST_FILES = [
  "tests/codex-shim.test.ts",
  "tests/cursor-native-exec-shell.test.ts",
  "tests/issue-452-empty-503.test.ts",
  "tests/openai-provider-option-e2e.test.ts",
  "tests/release-helper.test.ts",
  "tests/update-stop-first.test.ts",
] as const;

export const DEDICATED_TEST_FILES = [
  "tests/api-storage-policy-already-running.test.ts",
  "tests/api-storage-policy-mutation-busy.test.ts",
  "tests/api-storage-policy-put-race.test.ts",
  "tests/api-storage-policy-run.test.ts",
  "tests/api-storage-policy.test.ts",
  "tests/api-storage.test.ts",
  "tests/api-usage.test.ts",
] as const;
export const STORAGE_TEST_FILES = DEDICATED_TEST_FILES.slice(0, 6);
export const API_TEST_FILES = ["tests/api-usage.test.ts"] as const;

const laneNames = ["general", "serial", "dedicated", "dedicated-storage", "dedicated-api"] as const;
export type TestLane = (typeof laneNames)[number];

export function discoverTestFiles(root = process.cwd()): string[] {
  const testsRoot = resolve(root, "tests");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/[._](?:test|spec)\.(?:c|m)?(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(testsRoot);
  return files.sort();
}

export function validateLaneManifest(inventory: string[]): {
  general: string[];
  serial: string[];
  dedicated: string[];
} {
  const normalized = [...inventory].sort();
  if (new Set(normalized).size !== normalized.length) throw new Error("lane manifest contains duplicate paths");
  for (const path of normalized) {
    if (!path.startsWith("tests/") || path.includes("..")) {
      throw new Error(`lane manifest contains path outside tests: ${path}`);
    }
  }
  const serial = [...SERIAL_TEST_FILES];
  const dedicated = [...DEDICATED_TEST_FILES];
  const reserved = new Set([...serial, ...dedicated]);
  if (reserved.size !== serial.length + dedicated.length) {
    throw new Error("lane manifest serial and dedicated lanes overlap");
  }
  for (const path of reserved) {
    if (!normalized.includes(path)) throw new Error(`lane manifest path is missing: ${path}`);
  }
  return {
    general: normalized.filter(path => !reserved.has(path)),
    serial,
    dedicated,
  };
}

export function laneFiles(lane: TestLane, root = process.cwd()): string[] {
  const lanes = validateLaneManifest(discoverTestFiles(root));
  if (lane === "dedicated-storage") return [...STORAGE_TEST_FILES];
  if (lane === "dedicated-api") return [...API_TEST_FILES];
  return lanes[lane];
}

export function allocateFilesByTiming(files: string[], shardCount: number, durations = new Map<string, number>()): string[][] {
  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  const loads = Array.from({ length: shardCount }, () => 0);
  const measured = [...durations.values()].filter(duration => duration > 0);
  const fallbackDuration = measured.length === 0
    ? 1
    : measured.reduce((total, duration) => total + duration, 0) / measured.length;
  for (const file of [...files].sort((left, right) =>
    (durations.get(right) ?? 0) - (durations.get(left) ?? 0) || left.localeCompare(right))) {
    const target = loads.reduce((best, load, index) => load < loads[best]! ? index : best, 0);
    shards[target]!.push(file);
    loads[target] += durations.get(file) || fallbackDuration;
  }
  return shards;
}

interface TimingLike { files?: Record<string, unknown> }

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--lane") {
    const lane = args[1] as TestLane;
    if (!laneNames.includes(lane)) throw new Error(`unknown lane: ${args[1]}`);
    const timingFlag = args.indexOf("--timings");
    const timingPath = timingFlag === -1 ? undefined : args[timingFlag + 1];
    const files = laneFiles(lane);
    if (args.includes("--shard")) {
      const spec = args[args.indexOf("--shard") + 1] ?? "";
      const [index, count] = spec.split("/").map(Number);
      if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) throw new Error("invalid shard");
      let value: unknown;
      try { value = timingPath ? JSON.parse(readFileSync(timingPath, "utf8")) : undefined; } catch { value = undefined; }
      const durations = new Map<string, number>();
      if (value && typeof value === "object" && (value as TimingLike).files
        && typeof (value as TimingLike).files === "object") {
        for (const [path, durationMs] of Object.entries((value as TimingLike).files!)) {
          if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
            durations.set(path, durationMs);
          }
        }
      }
      for (const path of allocateFilesByTiming(files, count, durations)[index - 1]!) console.log(path);
    } else for (const path of files) console.log(path);
  } else {
    throw new Error("usage: --lane general|serial|dedicated|dedicated-storage|dedicated-api");
  }
}
