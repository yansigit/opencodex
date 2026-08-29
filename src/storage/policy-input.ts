import type { StorageCleanupPolicy } from "../types";

export const DEFAULT_ARCHIVED_BYTES_OVER = 5 * 1024 ** 3;
export const DEFAULT_REMOVE_OLDEST_PERCENT = 25;

export type PolicySchedule = StorageCleanupPolicy["schedule"];

/** Canonical defaults — enabled is always false. */
export function defaultStorageCleanupPolicy(): StorageCleanupPolicy {
  return {
    enabled: false,
    trigger: { archivedBytesOver: DEFAULT_ARCHIVED_BYTES_OVER },
    target: { removeOldestPercent: DEFAULT_REMOVE_OLDEST_PERCENT },
    schedule: "manual",
    mode: "quarantine",
  };
}

function isFiniteNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
}

function isFinitePositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Math.floor(n) === n;
}

/** True when target has exactly one of reduceToBytes / removeOldestPercent. */
export function isValidPolicyTarget(target: StorageCleanupPolicy["target"]): boolean {
  if (!target || typeof target !== "object") return false;
  const reduce = (target as { reduceToBytes?: unknown }).reduceToBytes;
  const percent = (target as { removeOldestPercent?: unknown }).removeOldestPercent;
  const hasReduce = reduce !== undefined;
  const hasPercent = percent !== undefined;
  if (hasReduce === hasPercent) return false;
  if (hasReduce) return isFiniteNonNegInt(reduce);
  return typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100;
}

/** Normalize persisted or partial policy input without ever enabling implicitly. */
export function normalizeStorageCleanupPolicy(raw: unknown): StorageCleanupPolicy {
  const base = defaultStorageCleanupPolicy();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  let enabled = o.enabled === true;

  let archivedBytesOver = base.trigger.archivedBytesOver;
  if (o.trigger && typeof o.trigger === "object" && !Array.isArray(o.trigger)) {
    const value = (o.trigger as { archivedBytesOver?: unknown }).archivedBytesOver;
    if (isFiniteNonNegInt(value)) archivedBytesOver = value;
  }

  let target: StorageCleanupPolicy["target"] = base.target;
  if (Object.hasOwn(o, "target")) {
    if (o.target && typeof o.target === "object" && !Array.isArray(o.target)) {
      const candidate = o.target as StorageCleanupPolicy["target"];
      if (isValidPolicyTarget(candidate)) {
        const reduce = (candidate as { reduceToBytes?: number }).reduceToBytes;
        const percent = (candidate as { removeOldestPercent?: number }).removeOldestPercent;
        target = reduce !== undefined
          ? { reduceToBytes: reduce }
          : { removeOldestPercent: Math.min(100, Math.max(1, Math.floor(percent!))) };
      } else {
        enabled = false;
      }
    } else {
      enabled = false;
    }
  }

  const schedule: PolicySchedule =
    o.schedule === "startup" || o.schedule === "daily" || o.schedule === "weekly" || o.schedule === "manual"
      ? o.schedule
      : base.schedule;
  const mode = o.mode === "permanent" ? "permanent" : "quarantine";

  let lastRun: StorageCleanupPolicy["lastRun"];
  if (o.lastRun && typeof o.lastRun === "object" && !Array.isArray(o.lastRun)) {
    const row = o.lastRun as Record<string, unknown>;
    if (isFinitePositiveInt(row.at) && isFiniteNonNegInt(row.freedBytes) && isFiniteNonNegInt(row.removed)) {
      lastRun = { at: row.at, freedBytes: row.freedBytes, removed: row.removed };
    }
  }

  const nextRun = o.nextRun === undefined || o.nextRun === null
    ? undefined
    : isFinitePositiveInt(o.nextRun) ? o.nextRun : undefined;

  return {
    enabled,
    trigger: { archivedBytesOver },
    target,
    schedule,
    mode,
    ...(lastRun ? { lastRun } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
  };
}

/** Validate a management PUT body and merge it over the latest policy. */
export function parseStorageCleanupPolicyInput(
  raw: unknown,
  previous?: StorageCleanupPolicy,
): { ok: true; policy: StorageCleanupPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const prev = previous ?? defaultStorageCleanupPolicy();

  if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (o.mode !== undefined && o.mode !== "quarantine" && o.mode !== "permanent") {
    return { ok: false, error: "mode must be quarantine or permanent" };
  }
  if (o.schedule !== undefined
    && o.schedule !== "startup"
    && o.schedule !== "daily"
    && o.schedule !== "weekly"
    && o.schedule !== "manual") {
    return { ok: false, error: "schedule must be startup, daily, weekly, or manual" };
  }

  const merged: Record<string, unknown> = {
    ...prev,
    ...o,
    trigger: o.trigger !== undefined ? o.trigger : prev.trigger,
    target: o.target !== undefined ? o.target : prev.target,
    lastRun: o.lastRun !== undefined ? o.lastRun : prev.lastRun,
    nextRun: o.nextRun !== undefined ? o.nextRun : prev.nextRun,
  };

  if (o.trigger !== undefined) {
    if (!o.trigger || typeof o.trigger !== "object" || Array.isArray(o.trigger)) {
      return { ok: false, error: "trigger must be an object" };
    }
    const bytes = (o.trigger as { archivedBytesOver?: unknown }).archivedBytesOver;
    if (!isFiniteNonNegInt(bytes)) {
      return { ok: false, error: "trigger.archivedBytesOver must be a non-negative integer" };
    }
  }
  if (o.target !== undefined && !isValidPolicyTarget(o.target as StorageCleanupPolicy["target"])) {
    return {
      ok: false,
      error: "target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)",
    };
  }

  const policy = normalizeStorageCleanupPolicy(merged);
  if ((policy.schedule === "daily" || policy.schedule === "weekly")
    && o.nextRun === undefined
    && (policy.nextRun === undefined || (o.schedule !== undefined && o.schedule !== prev.schedule))) {
    policy.nextRun = computeNextRun(policy.schedule, Date.now());
  }
  if ((policy.schedule === "manual" || policy.schedule === "startup") && o.nextRun === undefined) {
    delete policy.nextRun;
  }
  return { ok: true, policy };
}

/** Wall-clock next run for daily/weekly. Startup/manual → undefined. */
export function computeNextRun(schedule: PolicySchedule, now: number): number | undefined {
  if (schedule === "daily") return now + 24 * 60 * 60 * 1000;
  if (schedule === "weekly") return now + 7 * 24 * 60 * 60 * 1000;
  return undefined;
}
