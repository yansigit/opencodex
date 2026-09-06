/**
 * Read-time resolution of the optional quotaResetNotify config section.
 *
 * Cached, because loadConfig is a readFileSync plus a full configSchema.safeParse with no
 * memoization and the enable check runs once per pooled response — a config parse per request
 * for a feature nobody enabled.
 *
 * Keyed on the config file's filesystem identity, NOT on captureConfigGeneration. The generation
 * counter only advances when state-store reconciliation runs
 * (src/lib/state-store-sweeper.ts:149, reached from reconcileLiveStateStores on
 * account/provider changes), so editing quotaResetNotify alone would never bump it and the
 * cached answer would stay stale until an unrelated account edit happened to occur. A short
 * TTL bounds the stat call so the hot path does not stat on every single write.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { getConfigDir } from "../config/paths";
import type { QuotaResetKind } from "./reset-detector";

export type ResolvedQuotaResetNotify = {
  readonly enabled: boolean;
  readonly kinds: ReadonlySet<QuotaResetKind>;
  /** 0 means passive-only: observe live refreshes, never poll. */
  readonly pollMs: number;
  readonly webhookUrl?: string;
  readonly allowPrivateNetwork: boolean;
  readonly timeoutMs: number;
  readonly command?: readonly string[];
};

const ALL_KINDS: ReadonlySet<QuotaResetKind> = new Set(["scheduled", "surprise"]);
const DEFAULT_POLL_SECONDS = 900;
/**
 * Matches MIN_INTERVAL_MS in ./reset-poller. The two floors must move together: the resolver's
 * value now reaches setInterval, so a lower floor here would be silently overridden by the
 * poller and an accepted config value would not be the cadence that runs.
 */
const MIN_POLL_SECONDS = 600;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

const DISABLED: ResolvedQuotaResetNotify = Object.freeze({
  enabled: false,
  kinds: ALL_KINDS,
  pollMs: 0,
  allowPrivateNetwork: false,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

type RawNotify = {
  enabled?: unknown;
  kinds?: unknown;
  pollSeconds?: unknown;
  webhookUrl?: unknown;
  allowPrivateNetwork?: unknown;
  timeoutMs?: unknown;
  command?: unknown;
};

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function nonBlankStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return out.length > 0 ? out : undefined;
}

export function resolveQuotaResetNotify(raw: unknown): ResolvedQuotaResetNotify {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DISABLED;
  const value = raw as RawNotify;

  const webhookUrl = typeof value.webhookUrl === "string" && value.webhookUrl.trim() !== ""
    ? value.webhookUrl.trim()
    : undefined;
  const command = nonBlankStrings(value.command);

  // An "enabled" subsystem with nowhere to send is a misconfiguration. Reporting it as off
  // keeps the default-OFF guarantee honest: no sink means no timer and no observation.
  const enabled = value.enabled === true && (webhookUrl !== undefined || command !== undefined);
  if (!enabled) return DISABLED;

  const requestedKinds = Array.isArray(value.kinds)
    ? value.kinds.filter((kind): kind is QuotaResetKind => kind === "scheduled" || kind === "surprise")
    : [];
  const kinds: ReadonlySet<QuotaResetKind> = requestedKinds.length > 0
    ? new Set(requestedKinds)
    : ALL_KINDS;

  const pollSeconds = value.pollSeconds === 0
    ? 0
    : positiveInt(value.pollSeconds, DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, 24 * 60 * 60);

  return Object.freeze({
    enabled: true,
    kinds,
    pollMs: pollSeconds * 1_000,
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    allowPrivateNetwork: value.allowPrivateNetwork === true,
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS),
    ...(command !== undefined ? { command } : {}),
  });
}

/** Bounds how often the hot path stats the config file. */
const STAT_TTL_MS = 5_000;

type Cached = {
  checkedAt: number;
  signature: string;
  resolved: ResolvedQuotaResetNotify;
};

let cached: Cached | null = null;

/**
 * Filesystem identity of the config file.
 *
 * `mtimeMs:size` is not sufficient: an atomic same-size replacement can preserve both, and
 * coarse timestamp filesystems can do the same for an in-place rewrite. Device/inode catches
 * replacement while the content digest is the final authority for same-inode rewrites even
 * when their timestamps are restored or rounded. This runs only once per stat TTL, not per
 * quota observation.
 */
function configSignature(): string {
  try {
    const path = join(getConfigDir(), "config.json");
    const bytes = readFileSync(path);
    const stat = statSync(path, { bigint: true });
    const digest = createHash("sha256").update(bytes).digest("hex");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, digest].join(":");
  } catch {
    return "absent";
  }
}

export function currentQuotaResetNotify(): ResolvedQuotaResetNotify {
  const now = Date.now();
  if (cached && now - cached.checkedAt < STAT_TTL_MS) return cached.resolved;

  const signature = configSignature();
  if (cached && cached.signature === signature) {
    cached.checkedAt = now;
    return cached.resolved;
  }

  let resolved = DISABLED;
  try {
    resolved = resolveQuotaResetNotify(
      (loadConfig() as { quotaResetNotify?: unknown }).quotaResetNotify,
    );
  } catch {
    // An unreadable config must not enable a notifier, and must not throw on a quota write.
  }
  cached = { checkedAt: now, signature, resolved };
  return resolved;
}

export function isQuotaResetNotificationEnabled(): boolean {
  return currentQuotaResetNotify().enabled;
}

export function resolveQuotaResetPollMs(): number {
  return currentQuotaResetNotify().pollMs;
}

export function resetQuotaResetNotifyCacheForTests(): void {
  cached = null;
}
