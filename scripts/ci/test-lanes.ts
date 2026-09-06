import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SERIAL_TEST_FILES = [
  // This is the single source of truth for tests that must not share a parallel
  // worker pool. The normal CI serial job and scripts/test.ts full-suite planner
  // both consume it, so promotion/nightly runs cannot silently lose quarantine.
  "tests/adapters/google/aistudio-native-webkit.test.ts",
  "tests/adapters/anthropic/anthropic-image-normalize.test.ts",
  "tests/claude-integration/claude-native-passthrough.test.ts",
  "tests/claude-integration/claude-management-api.test.ts",
  "tests/codex-integration/codex-app-server-processes.test.ts",
  // Spawns multiple real `ocx start` children. Under the general Windows pool,
  // four Bun test processes can starve a healthy child past its readiness
  // watchdog even though it is still alive. Keep the end-to-end assertions;
  // isolate their process scheduling from unrelated shard load.
  "tests/codex-integration/codex-composed-acceptance.test.ts",
  // Exercises repeated catalog convergence against a synthetic Codex runtime.
  // On a fully loaded macOS promotion runner its 30s featured-model deadline
  // expired, while the same exact commit passed in the isolated dev push.
  "tests/codex-integration/codex-convergence-account-selectors.test.ts",
  // Proves production write-lock contention through many real Bun children.
  // Run it after the general pool so unrelated process pressure cannot consume
  // the bounded child startup budgets or let a holder expire before a contender.
  "tests/codex-integration/codex-inject-write-lock.test.ts",
  "tests/codex-integration/codex-journal.test.ts",
  "tests/codex-integration/codex-prompt-route.test.ts",
  "tests/codex-integration/codex-shim.test.ts",
  "tests/codex-integration/codex-transition-state-race.test.ts",
  "tests/config/config-save-boundary.test.ts",
  "tests/providers/cursor/cursor-images.test.ts",
  "tests/providers/cursor/cursor-native-exec-shell.test.ts",
  "tests/codex-integration/issue-452-empty-503.test.ts",
  "tests/providers/kiro/kiro-images.test.ts",
  "tests/codex-integration/native-main-owner-lifetime.test.ts",
  "tests/adapters/openai/openai-provider-option-e2e.test.ts",
  "tests/cli/ocx-launcher-runtime.test.ts",
  // Starts nested Bun and git processes from three disposable repositories. On a
  // loaded macOS full-suite pool the first child remained blocked until the
  // 15-minute suite watchdog, while this file completes in under a second alone.
  "tests/ci-workflows/privacy-scan.test.ts",
  "tests/ci-workflows/release-helper.test.ts",
  // Uses real worker inactivity periods to classify periodic activity. On the
  // loaded promotion pool, scheduler stalls crossed its bounded observation
  // window and changed the expected blocked/inconclusive outcome.
  "tests/lab/lab-fabric-task.test.ts",
  "tests/usage/request-decompress.test.ts",
  // Drives a sustained real-time debounce to prove writes cannot be starved.
  // Keep its 60s product invariant, but remove unrelated suite contention.
  "tests/usage/quota-reset-seen-store.test.ts",
  "tests/responses/responses-stateless-dangling-call-repair.test.ts",
  "tests/server/server-auth.test.ts",
  // Relays a real 50 MiB WebSocket frame to prove the production ceiling. On a
  // loaded macOS pool this exhausted its 15s internal deadline while the same
  // runner completed it in ~5.6s without contention.
  "tests/server/server-live.test.ts",
  "tests/server/server-search.test.ts",
  "tests/service/shutdown-launcher.test.ts",
  "tests/storage/storage-policy-job-responsive.test.ts",
  "tests/storage/storage-restore-job-responsive.test.ts",
  // Waits for a real background policy worker to settle and prove process
  // cleanup. Parallel macOS pressure can starve that worker past its 20s guard.
  "tests/storage/storage-worker-lifecycle.test.ts",
  "tests/ci-workflows/test-runner.test.ts",
  "tests/update/update-stop-first.test.ts",
  // These suites share the interval-based overlay reconciler singleton and
  // OPENCODEX_HOME. Parallel files can stop or reset the process-wide poller
  // while a sibling is waiting for an observation, so isolate the whole family.
  "tests/usage/user-cost-overlay-coderabbit-regressions.test.ts",
  "tests/usage/user-cost-overlay-live-reconcile.test.ts",
  "tests/usage/user-cost-overlay-provider-delete.test.ts",
  // Proves a deliberately stalled response body is cut off inside a one-second
  // contract. Isolate it so unrelated macOS workers cannot consume that budget.
  "tests/web-search/web-search-timeout-contract.test.ts",
  // Builds and parses 500,001 JSONL entries to prove the entry cap. It reached
  // the 30s test budget under pool contention and completes in ~5s in isolation.
  "tests/usage/usage-log.test.ts",
] as const;

export const DEDICATED_TEST_FILES = [
  "tests/storage/api-storage-policy-already-running.test.ts",
  "tests/storage/api-storage-policy-mutation-busy.test.ts",
  "tests/storage/api-storage-policy-put-race.test.ts",
  "tests/storage/api-storage-policy-run.test.ts",
  "tests/storage/api-storage-policy.test.ts",
  "tests/storage/api-storage.test.ts",
  "tests/server/api-usage.test.ts",
] as const;
export const STORAGE_TEST_FILES = DEDICATED_TEST_FILES.slice(0, 6);
export const API_TEST_FILES = ["tests/server/api-usage.test.ts"] as const;

const laneNames = ["general", "serial", "dedicated", "dedicated-storage", "dedicated-api"] as const;
export type TestLane = (typeof laneNames)[number];

type DirectoryReader = (directory: string) => Dirent[];

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function discoverTestFiles(
  root = process.cwd(),
  readDirectory: DirectoryReader = directory => readdirSync(directory, { withFileTypes: true }),
): string[] {
  const testsRoot = resolve(root, "tests");
  const files: string[] = [];
  const visit = (directory: string, required = false): void => {
    let entries: Dirent[];
    try {
      entries = readDirectory(directory);
    } catch (error) {
      // Tests may create and remove scratch directories beneath tests/ while
      // another shard inventories the suite. A vanished descendant is not a
      // test file; the required tests root itself must still fail loudly.
      if (!required && isMissingDirectory(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/[._](?:test|spec)\.(?:c|m)?(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(testsRoot, true);
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
  const serialByBasename = new Map(
    serial.map(path => [path.slice(path.lastIndexOf("/") + 1), path]),
  );
  for (const path of normalized) {
    const serialPath = serialByBasename.get(path.slice(path.lastIndexOf("/") + 1));
    if (serialPath && path !== serialPath) {
      throw new Error(`lane manifest path collides with serial basename: ${path} and ${serialPath}`);
    }
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
