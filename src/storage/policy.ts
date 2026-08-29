/**
 * Phase 3 opt-in auto-cleanup policy (issue #42).
 *
 * Default OFF — never enabled implicitly. Selects oldest archived sessions via
 * Phase 2 helpers and runs `executeArchivedCleanup` in quarantine/permanent mode.
 * On `codex_busy`, defers (updates `nextRun`) without mutating archives.
 *
 * Privacy: logs never include host paths, digests of file contents, or secrets.
 */
import { resolveCodexHomeDir } from "../codex/home";
import { loadConfig, mutatePersistedConfig } from "../config";
import type { StorageCleanupPolicy } from "../types";
import {
  computePreviewDigest,
  executeArchivedCleanup,
  filterCandidatesExcludingPinned,
  listArchivedCandidates,
  previewExactArchivedCleanup,
  selectOldestPercentSkippingPendingRestore,
  selectReduceToBytesSkippingPendingRestore,
  type CleanupMode,
  type CleanupResult,
  type ExecuteCleanupOptions,
} from "./cleanup";
import {
  computeNextRun,
  normalizeStorageCleanupPolicy,
} from "./policy-input";
export {
  computeNextRun,
  defaultStorageCleanupPolicy,
  isValidPolicyTarget,
  normalizeStorageCleanupPolicy,
  parseStorageCleanupPolicyInput,
  DEFAULT_ARCHIVED_BYTES_OVER,
  DEFAULT_REMOVE_OLDEST_PERCENT,
  type PolicySchedule,
} from "./policy-input";

export const BUSY_DEFER_MS = 15 * 60 * 1000;

/** Optional sink so background policy writes stay synced with the live server config. */
let livePolicySink: ((policy: StorageCleanupPolicy) => void) | undefined;

export function setStorageCleanupPolicyLiveSink(
  sink: ((policy: StorageCleanupPolicy) => void) | null,
): void {
  livePolicySink = sink ?? undefined;
}

function adoptStorageCleanupPolicy(policy: StorageCleanupPolicy): void {
  livePolicySink?.(policy);
}

export type PolicyRunReason = "startup" | "schedule" | "manual";
export type PolicyMetadataPersistenceError = "missing" | "invalid" | "conflict" | "write_failed";

export type PolicySkipReason =
  | "disabled"
  | "not_due"
  | "under_threshold"
  | "nothing_selected";

export interface PolicyRunResult {
  ok: boolean;
  skipped?: PolicySkipReason;
  deferred?: "codex_busy";
  error?: CleanupResult["error"];
  mode?: CleanupMode;
  freedBytes?: number;
  removed?: number;
  trashDir?: string;
  metadataPersistenceError?: PolicyMetadataPersistenceError;
  policy: StorageCleanupPolicy;
}

export interface PolicyRunDeps {
  now?: number;
  reason: PolicyRunReason;
  codexHome?: string;
  /** Bypass due-window checks (tests / explicit force). Still respects enabled. */
  force?: boolean;
  loadPolicy?: () => StorageCleanupPolicy;
  savePolicy?: (policy: StorageCleanupPolicy) => void;
  execute?: (options: ExecuteCleanupOptions) => CleanupResult;
  busyTimeoutMs?: number;
  /**
   * Test-only: block after the start-of-job policy load so a concurrent PUT can
   * land before completion merges run metadata.
   */
  holdAfterLoadMs?: number;
  /** Test-only synchronization seam; omitted in production. */
  onPolicyLoaded?: () => void;
}

export function readStorageCleanupPolicyFromConfig(): StorageCleanupPolicy {
  return normalizeStorageCleanupPolicy(loadConfig().storageCleanupPolicy);
}

export function writeStorageCleanupPolicyToConfig(policy: StorageCleanupPolicy): StorageCleanupPolicy {
  const normalized = normalizeStorageCleanupPolicy(policy);
  const outcome = mutatePersistedConfig(fresh => {
    const changed = JSON.stringify(fresh.storageCleanupPolicy) !== JSON.stringify(normalized);
    fresh.storageCleanupPolicy = normalized;
    return { changed, value: structuredClone(normalized) };
  });
  if (outcome.status === "unavailable") throw new Error(`storage cleanup policy persistence unavailable: ${outcome.reason}`);
  adoptStorageCleanupPolicy(outcome.value);
  return outcome.value;
}

export function isPolicyDue(
  policy: StorageCleanupPolicy,
  now: number,
  reason: PolicyRunReason,
): boolean {
  if (!policy.enabled) return false;
  if (reason === "manual") return true;
  if (policy.schedule === "manual") return false;
  if (policy.schedule === "startup") {
    if (reason === "startup") return true;
    // Honor deferred nextRun (e.g. codex_busy at launch) on later scheduler ticks.
    return reason === "schedule"
      && policy.nextRun !== undefined
      && now >= policy.nextRun;
  }
  // daily / weekly: due when nextRun unset or elapsed
  if (policy.nextRun === undefined) return true;
  return now >= policy.nextRun;
}

/** Oldest-first until archived total would drop to `reduceToBytes`. */
export function selectReduceToBytes(
  candidates: ReturnType<typeof listArchivedCandidates>,
  reduceToBytes: number,
): ReturnType<typeof listArchivedCandidates> {
  if (!Number.isFinite(reduceToBytes) || reduceToBytes < 0) return [];
  const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= reduceToBytes) return [];
  const need = total - reduceToBytes;
  const out: typeof candidates = [];
  let freed = 0;
  for (const c of candidates) {
    out.push(c);
    freed += c.bytes;
    if (freed >= need) break;
  }
  return out;
}

/**
 * Minimal percent in 1..100 such that `selectOldestPercent` returns at least `n` of `m`.
 * Returns 0 when n<=0, 100 when n>=m.
 */
export function percentForAtLeastCount(totalCount: number, selectedCount: number): number {
  if (selectedCount <= 0 || totalCount <= 0) return 0;
  if (selectedCount >= totalCount) return 100;
  for (let pct = 1; pct <= 100; pct++) {
    const got = Math.max(1, Math.floor((totalCount * pct) / 100));
    if (got >= selectedCount) return pct;
  }
  return 100;
}

export interface PolicySelection {
  archivedBytes: number;
  percent: number;
  count: number;
  bytes: number;
  digest: string;
  /** Present when selection is an exact candidate list (reduceToBytes). */
  candidateRelPaths?: string[];
}

/** Build a Phase-2-compatible preview for the active policy target. */
export function selectPolicyPreview(
  policy: StorageCleanupPolicy,
  codexHome: string = resolveCodexHomeDir(),
): PolicySelection {
  const all = listArchivedCandidates(codexHome);
  const archivedBytes = all.reduce((sum, c) => sum + c.bytes, 0);

  const reduceTo = (policy.target as { reduceToBytes?: number }).reduceToBytes;
  const removePct = (policy.target as { removeOldestPercent?: number }).removeOldestPercent;

  if (reduceTo !== undefined) {
    // Exact candidate set — do not approximate via percent (would over-delete).
    const desired = selectReduceToBytesSkippingPendingRestore(all, reduceTo, codexHome);
    const preview = previewExactArchivedCleanup(desired, codexHome);
    return {
      archivedBytes,
      percent: 0,
      count: preview.count,
      bytes: preview.bytes,
      digest: preview.digest,
      candidateRelPaths: preview.candidates.map(c => c.relPath),
    };
  }

  // Reuse the already-listed candidates — avoid a second archive directory walk.
  const percent = Math.min(100, Math.max(0, Math.floor(removePct ?? 0)));
  const selected = selectOldestPercentSkippingPendingRestore(
    filterCandidatesExcludingPinned(all, codexHome),
    percent,
    codexHome,
  );
  return {
    archivedBytes,
    percent,
    count: selected.length,
    bytes: selected.reduce((sum, c) => sum + c.bytes, 0),
    digest: computePreviewDigest(selected, percent),
  };
}

function advanceNextRun(policy: StorageCleanupPolicy, now: number): StorageCleanupPolicy {
  const next = { ...policy };
  const nextRun = computeNextRun(policy.schedule, now);
  if (nextRun === undefined) delete next.nextRun;
  else next.nextRun = nextRun;
  return next;
}

function deferBusy(policy: StorageCleanupPolicy, now: number): StorageCleanupPolicy {
  return { ...policy, nextRun: now + BUSY_DEFER_MS };
}

export type PolicyRunMetadataPatch = {
  now: number;
  /** Advance nextRun from the *latest* schedule, or defer on codex_busy. */
  nextRun: "advance" | "defer_busy";
  lastRun?: StorageCleanupPolicy["lastRun"];
};

/** Apply only run-owned fields while preserving the supplied policy settings. */
function applyPolicyRunMetadata(
  policy: StorageCleanupPolicy,
  patch: PolicyRunMetadataPatch,
): StorageCleanupPolicy {
  let next =
    patch.nextRun === "defer_busy"
      ? deferBusy(policy, patch.now)
      : advanceNextRun(policy, patch.now);
  if (patch.lastRun) {
    next = { ...next, lastRun: patch.lastRun };
  }
  return next;
}

/**
 * Reload the latest persisted policy and write only run-owned metadata
 * (`lastRun` / `nextRun`). Preserves concurrent edits to enabled, trigger,
 * target, schedule, and mode that landed while a long run was in flight.
 */
export function commitPolicyRunMetadata(
  load: () => StorageCleanupPolicy,
  save: (policy: StorageCleanupPolicy) => void,
  patch: PolicyRunMetadataPatch,
): StorageCleanupPolicy {
  const latest = normalizeStorageCleanupPolicy(load());
  const next = applyPolicyRunMetadata(latest, patch);
  save(next);
  return next;
}

type PolicyRunMetadataCommit = {
  policy: StorageCleanupPolicy;
  persistenceError?: PolicyMetadataPersistenceError;
};

/** Attach the durable metadata outcome without replacing cleanup status or metrics. */
function withMetadataCommit(
  result: Omit<PolicyRunResult, "policy" | "metadataPersistenceError">,
  committed: PolicyRunMetadataCommit,
): PolicyRunResult {
  return {
    ...result,
    policy: committed.policy,
    ...(committed.persistenceError ? { metadataPersistenceError: committed.persistenceError } : {}),
  };
}

/** Recompute run-owned metadata from the latest config inside the mutation lock. */
function commitPolicyRunMetadataToConfig(
  patch: PolicyRunMetadataPatch,
  fallbackPolicy: StorageCleanupPolicy,
): PolicyRunMetadataCommit {
  const unavailable = (reason: PolicyMetadataPersistenceError): PolicyRunMetadataCommit => {
    console.warn(`[storage-policy] metadata_persist_failed reason=${reason}`);
    return {
      policy: applyPolicyRunMetadata(fallbackPolicy, patch),
      persistenceError: reason,
    };
  };
  try {
    const outcome = mutatePersistedConfig(config => {
      const before = JSON.stringify(config.storageCleanupPolicy);
      const next = applyPolicyRunMetadata(
        normalizeStorageCleanupPolicy(config.storageCleanupPolicy),
        patch,
      );
      config.storageCleanupPolicy = next;
      return { changed: JSON.stringify(next) !== before, value: structuredClone(next) };
    });
    if (outcome.status === "unavailable") return unavailable(outcome.reason);
    adoptStorageCleanupPolicy(outcome.value);
    return { policy: outcome.value };
  } catch {
    return unavailable("write_failed");
  }
}

function logPolicyEvent(message: string): void {
  console.log(`[storage-policy] ${message}`);
}

/**
 * Evaluate and optionally execute the storage cleanup policy.
 * Disabled / under-threshold / not-due paths never call execute.
 */
export function runStorageCleanupPolicy(deps: PolicyRunDeps): PolicyRunResult {
  const now = deps.now ?? Date.now();
  const load = deps.loadPolicy ?? readStorageCleanupPolicyFromConfig;
  const execute = deps.execute ?? executeArchivedCleanup;
  const policy = normalizeStorageCleanupPolicy(load());
  // Injected stores retain the existing load/save contract. The production path
  // recomputes metadata from the latest persisted policy inside the config lock.
  const commitMetadata = deps.savePolicy !== undefined
    ? (patch: PolicyRunMetadataPatch): PolicyRunMetadataCommit => ({
        policy: commitPolicyRunMetadata(load, deps.savePolicy!, patch),
      })
    : (patch: PolicyRunMetadataPatch) => commitPolicyRunMetadataToConfig(patch, policy);
  deps.onPolicyLoaded?.();

  if (typeof deps.holdAfterLoadMs === "number" && Number.isFinite(deps.holdAfterLoadMs) && deps.holdAfterLoadMs > 0) {
    Bun.sleepSync(Math.floor(deps.holdAfterLoadMs));
  }

  if (!policy.enabled) {
    return { ok: true, skipped: "disabled", policy };
  }

  if (!deps.force && !isPolicyDue(policy, now, deps.reason)) {
    return { ok: true, skipped: "not_due", policy };
  }

  const selection = selectPolicyPreview(policy, deps.codexHome);
  if (selection.archivedBytes <= policy.trigger.archivedBytesOver) {
    const committed = commitMetadata({ now, nextRun: "advance" });
    logPolicyEvent("skip under_threshold");
    return withMetadataCommit({ ok: true, skipped: "under_threshold" }, committed);
  }

  if (selection.count === 0) {
    const committed = commitMetadata({ now, nextRun: "advance" });
    logPolicyEvent("skip nothing_selected");
    return withMetadataCommit({ ok: true, skipped: "nothing_selected" }, committed);
  }

  const result = execute({
    percent: selection.percent,
    mode: policy.mode,
    digest: selection.digest,
    ...(selection.candidateRelPaths ? { candidateRelPaths: selection.candidateRelPaths } : {}),
    ...(deps.codexHome ? { codexHome: deps.codexHome } : {}),
    ...(deps.busyTimeoutMs !== undefined ? { busyTimeoutMs: deps.busyTimeoutMs } : {}),
    now,
  });

  if (!result.ok && result.error === "codex_busy") {
    const committed = commitMetadata({ now, nextRun: "defer_busy" });
    logPolicyEvent("defer codex_busy");
    return withMetadataCommit({
      ok: false,
      deferred: "codex_busy",
      error: "codex_busy",
    }, committed);
  }

  if (!result.ok) {
    // Non-busy failure: still advance schedule so we do not tight-loop.
    const committed = commitMetadata({ now, nextRun: "advance" });
    logPolicyEvent(`fail ${result.error ?? "cleanup_failed"}`);
    return withMetadataCommit({
      ok: false,
      error: result.error,
      mode: result.mode,
      ...(result.trashDir ? { trashDir: result.trashDir } : {}),
    }, committed);
  }

  const committed = commitMetadata({
    now,
    nextRun: "advance",
    lastRun: {
      at: now,
      freedBytes: result.bytes,
      removed: result.count,
    },
  });
  logPolicyEvent(
    `ok mode=${result.mode} removed=${result.count} freedBytes=${result.bytes}`,
  );
  return withMetadataCommit({
    ok: true,
    mode: result.mode,
    freedBytes: result.bytes,
    removed: result.count,
    ...(result.trashDir ? { trashDir: result.trashDir } : {}),
  }, committed);
}

/** Startup / schedule tick entry — swallows unexpected errors. */
export function maybeRunDueStorageCleanupPolicy(
  reason: PolicyRunReason,
  deps?: Omit<PolicyRunDeps, "reason">,
): PolicyRunResult | null {
  try {
    return runStorageCleanupPolicy({ ...deps, reason });
  } catch {
    logPolicyEvent("error evaluation_failed");
    return null;
  }
}
