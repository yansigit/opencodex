/**
 * Regression: cleanup and restore must not mutate CODEX_HOME concurrently.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { drainAndShutdown } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { endStorageMutation, getActiveStorageMutation, tryBeginStorageMutation } from "../src/storage/storage-mutation-coordinator";
import {
  resetArchivedCleanupJobForTests,
  setArchivedCleanupJobTestHooks,
} from "../src/storage/cleanup-job";
import {
  requestStorageCleanupPolicyRun,
  resetStorageCleanupPolicyJobForTests,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";
import {
  resetRestoreTrashJobForTestsAsync,
  runRestoreTrashEntryJob,
  setRestoreTrashJobTestHooks,
} from "../src/storage/restore-job";
import {
  resetStorageMutationCoordinatorForTests,
} from "../src/storage/storage-mutation-coordinator";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
} from "../src/storage/worker-lifecycle";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function seedArchivedPair(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), "o".repeat(100));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), "n".repeat(200));
  utimesSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), new Date("2026-06-01"), new Date("2026-06-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES
    ('told','archived_sessions/rollout-old.jsonl',1),
    ('tnew','archived_sessions/rollout-new.jsonl',1)
  `);
  db.close();
}

function threadCount(codexHome: string): number {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  const row = db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  db.close();
  return row.c;
}

function trashStageCount(codexHome: string): number {
  const trashRoot = join(codexHome, ".trash");
  if (!existsSync(trashRoot)) return 0;
  return readdirSync(trashRoot).filter(name => !name.startsWith(".")).length;
}

async function previewDigest(serverUrl: string, percent: number): Promise<{ digest: string; count: number }> {
  const res = await fetch(new URL("/api/storage/cleanup/preview", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { digest: body.digest, count: body.count };
}

async function enablePolicyAndRun(serverUrl: string): Promise<{ startedAt: number }> {
  await fetch(new URL("/api/storage/cleanup-policy", serverUrl), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      trigger: { archivedBytesOver: 50 },
      target: { removeOldestPercent: 50 },
      schedule: "manual",
      mode: "quarantine",
    }),
  });
  const run = await fetch(new URL("/api/storage/cleanup-policy/run", serverUrl), { method: "POST" });
  expect(run.status).toBe(200);
  const body = await run.json();
  expect(body.started).toBe(true);
  return { startedAt: body.job.startedAt as number };
}

async function waitForPolicyJob(
  serverUrl: string,
  startedAt: number,
  timeoutMs = 20_000,
): Promise<{ job: { lastOutcome?: { ok?: boolean; error?: string; removed?: number } } }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(new URL("/api/storage/cleanup-policy", serverUrl));
    const body = await res.json() as {
      job: {
        status: string;
        startedAt?: number;
        lastOutcome?: { ok?: boolean; error?: string; removed?: number };
      };
    };
    if (body.job.status === "idle" && body.job.lastOutcome && body.job.startedAt === startedAt) {
      return body;
    }
    await Bun.sleep(50);
  }
  throw new Error("policy job did not finish");
}

/** Windows can keep SQLite/job handles briefly after stop; retry only transient cleanup codes. */
function removeTree(path: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(code)) throw error;
      lastError = error;
      Bun.sleepSync(50);
    }
  }
  throw lastError;
}

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  // Join leftover Workers before allocating homes / mutating OPENCODEX_HOME —
  // same order as installPolicyApiHarness (startServer also arms the unref'd
  // policy scheduler; bare server.stop does not clear it).
  stopStorageCleanupScheduler();
  cancelQueuedStorageWorkerSpawns();
  await resetRestoreTrashJobForTestsAsync();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  // Clear shared coordination only after workers have joined — same ordering
  // as resetRestoreTrashJobForTestsAsync / policy-job's mutation-slot finally.
  resetArchivedCleanupJobForTests();
  resetStorageMutationCoordinatorForTests();
  isolatedCodexHome = installIsolatedCodexHome("ocx-storage-mutation-race-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-storage-mutation-race-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  stopStorageCleanupScheduler();
});

afterEach(async () => {
  stopStorageCleanupScheduler();
  cancelQueuedStorageWorkerSpawns();
  await resetRestoreTrashJobForTestsAsync();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  resetArchivedCleanupJobForTests();
  resetStorageMutationCoordinatorForTests();
  setRestoreTrashJobTestHooks(null);
  setArchivedCleanupJobTestHooks(null);
  setStorageCleanupPolicyJobTestHooks(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTree(testDir);
  testDir = "";
});

async function stopRaceServer(server: ReturnType<typeof startServer>): Promise<void> {
  // Joins storage Workers + clears the scheduler; Bun.serve.stop alone does not.
  await drainAndShutdown(server, 5_000);
}

function acquiredSignal(): { promise: Promise<void>; notify: () => void; release: () => void; releasePromise: Promise<void> } {
  let notify!: () => void;
  let release!: () => void;
  const promise = new Promise<void>(resolve => { notify = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  return { promise, notify, release, releasePromise };
}

describe("storage mutation coordinator", () => {
  test("reset while policy waits cannot release a newer mutation lease", async () => {
    const home = join(testDir, "reset-while-waiting-home");
    let releaseWait!: () => void;
    const waitForRelease = new Promise<void>(resolve => { releaseWait = resolve; });
    let policyLoaded = false;
    setStorageCleanupPolicyJobTestHooks({
      runInProcess: true,
      onAcquired: () => undefined,
      onPolicyLoaded: () => { policyLoaded = true; },
      waitForRelease,
    });

    const started = requestStorageCleanupPolicyRun({ reason: "manual", force: true, codexHome: home });
    expect(started.accepted).toBe(true);

    // The hook runs synchronously before the await, so the policy job now owns
    // the old lease while its continuation is parked at the test boundary.
    await Promise.resolve();
    expect(getActiveStorageMutation(home)?.kind).toBe("policy");

    resetStorageCleanupPolicyJobForTests();
    const newer = tryBeginStorageMutation("cleanup", home);
    try {
      expect(newer.acquired).toBe(true);

      releaseWait();
      await Bun.sleep(0);
      expect(policyLoaded).toBe(false);
      expect(getActiveStorageMutation(home)?.kind).toBe("cleanup");
    } finally {
      releaseWait();
      if (newer.acquired) newer.lease.release();
    }
  }, { timeout: 5_000 });

  test("cleanup restore and policy retain their exact mutation lease through worker join", () => {
    const home = join(testDir, "exact-lease-home");
    const owner = tryBeginStorageMutation("cleanup", home);
    expect(owner.acquired).toBe(true);
    endStorageMutation(join(testDir, "different-home"));
    expect(getActiveStorageMutation(home)?.kind).toBe("cleanup");
    if (owner.acquired) owner.lease.release();
    expect(getActiveStorageMutation(home)).toBeNull();
  });
  test("policy run is rejected while restore holds the shared mutation slot", async () => {
    const home = isolatedCodexHome!.path;
    const acquired = acquiredSignal();
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;

      setRestoreTrashJobTestHooks({ blockMs: 10, runInProcess: true, onAcquired: acquired.notify, waitForRelease: acquired.releasePromise });
      const restorePromise = runRestoreTrashEntryJob(trashId, { codexHome: home });
      await acquired.promise;

      const { startedAt } = await enablePolicyAndRun(server.url);
      const done = await waitForPolicyJob(server.url, startedAt);
      expect(done.job.lastOutcome?.ok).toBe(false);
      expect(done.job.lastOutcome?.error).toBe("storage_mutation_busy");
      acquired.release();

      const restoreResult = await restorePromise;
      expect(restoreResult.ok).toBe(true);
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 30_000 });

  test("policy run is rejected while manual cleanup holds the shared mutation slot", async () => {
    const home = isolatedCodexHome!.path;
    const acquired = acquiredSignal();
    setArchivedCleanupJobTestHooks({ blockMs: 10, onAcquired: acquired.notify, waitForRelease: acquired.releasePromise });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupPromise = fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      await acquired.promise;

      const { startedAt } = await enablePolicyAndRun(server.url);
      const done = await waitForPolicyJob(server.url, startedAt);
      expect(done.job.lastOutcome?.ok).toBe(false);
      expect(done.job.lastOutcome?.error).toBe("storage_mutation_busy");
      acquired.release();

      const cleanupRes = await cleanupPromise;
      expect(cleanupRes.status).toBe(200);
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 30_000 });

  test("manual cleanup and restore are rejected while policy job holds the shared mutation slot", async () => {
    const home = isolatedCodexHome!.path;
    const acquired = acquiredSignal();
    setStorageCleanupPolicyJobTestHooks({ blockMs: 10, onAcquired: acquired.notify, waitForRelease: acquired.releasePromise });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const { startedAt } = await enablePolicyAndRun(server.url);
      await acquired.promise;

      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(409);
      expect((await cleanupRes.json()).error).toBe("storage_mutation_busy");

      const restoreRes = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ".trash/missing" }),
      });
      expect(restoreRes.status).toBe(409);
      expect((await restoreRes.json()).error).toBe("storage_mutation_busy");
      acquired.release();

      // Drain the blocked policy job before stop/teardown — leaving it mid-block leaves
      // Windows holding OPENCODEX_HOME (SQLite/job handles) and afterEach rmSync fails EBUSY.
      await waitForPolicyJob(server.url, startedAt);
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 30_000 });

  test("cleanup quarantine and permanent are rejected while restore holds slot after file moves", async () => {
    const home = isolatedCodexHome!.path;
    const holdMs = 100;
    setRestoreTrashJobTestHooks({
      restoreTest: { holdAfterFileMovesMs: holdMs },
    });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;
      const trashStage = join(home, trashId);
      expect(existsSync(trashStage)).toBe(true);

      const remainingPreview = await previewDigest(server.url, 50);
      expect(remainingPreview.count).toBe(1);

      const restorePromise = fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });

      const restoredPath = join(home, "archived_sessions", "rollout-old.jsonl");
      const movedDeadline = Date.now() + 8000;
      while (!existsSync(restoredPath) && Date.now() < movedDeadline) await Bun.sleep(1);
      expect(existsSync(restoredPath)).toBe(true);
      expect(existsSync(join(trashStage, "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(trashStage, "restore-pending.json"))).toBe(true);

      const quarantineDuring = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: 50,
          mode: "quarantine",
          digest: remainingPreview.digest,
        }),
      });
      expect(quarantineDuring.status).toBe(409);
      expect((await quarantineDuring.json()).error).toBe("storage_mutation_busy");
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(trashStageCount(home)).toBe(1);

      const previewPermanent = await previewDigest(server.url, 100);
      const permanentDuring = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: 100,
          mode: "permanent",
          digest: previewPermanent.digest,
        }),
      });
      expect(permanentDuring.status).toBe(409);
      expect((await permanentDuring.json()).error).toBe("storage_mutation_busy");

      const restoreRes = await restorePromise;
      expect(restoreRes.status).toBe(200);
      const restored = await restoreRes.json();
      expect(restored.ok).toBe(true);
      expect(existsSync(restoredPath)).toBe(true);
      expect(threadCount(home)).toBe(2);
      expect(readFileSync(restoredPath, "utf8")).toBe("o".repeat(100));
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 45_000 });

  test("restore is rejected while cleanup holds the shared mutation slot", async () => {
    const home = isolatedCodexHome!.path;
    const acquired = acquiredSignal();
    setArchivedCleanupJobTestHooks({ blockMs: 10, onAcquired: acquired.notify, waitForRelease: acquired.releasePromise });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupPromise = fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });

      await acquired.promise;

      const restoreAttempt = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ".trash/never" }),
      });
      expect(restoreAttempt.status).toBe(409);
      expect((await restoreAttempt.json()).error).toBe("storage_mutation_busy");
      acquired.release();
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(trashStageCount(home)).toBe(0);

      const cleanupRes = await cleanupPromise;
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      expect(cleanup.ok).toBe(true);
      expect(cleanup.trashDir).toMatch(/^\.trash\//);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(threadCount(home)).toBe(1);
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 30_000 });

  test("second restore while first is in flight returns storage_mutation_busy", async () => {
    const home = isolatedCodexHome!.path;
    const acquired = acquiredSignal();
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;

      setRestoreTrashJobTestHooks({ blockMs: 10, runInProcess: true, onAcquired: acquired.notify, waitForRelease: acquired.releasePromise });
      const first = fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });
      await acquired.promise;
      const second = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });
      expect(second.status).toBe(409);
      expect((await second.json()).error).toBe("storage_mutation_busy");
      acquired.release();

      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      await stopRaceServer(server);
    }
  }, { timeout: 30_000 });
});
