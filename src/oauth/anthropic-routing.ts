/**
 * Opt-in Anthropic OAuth account pool (#294).
 *
 * Default OFF. When enabled:
 * - Sticky session affinity across requests that share a session key
 * - 429 cools the failed account and fails over to another eligible account
 * - New sessions use `strategy` (default quota): lowest known fiveHour usage (#493),
 *   round-robin, or fill-first — affinity still wins for bound sessions
 *
 * Intentionally narrower than the Codex pool: no mid-session quota rotation,
 * soft-avoid ladders, or probe leases. Anthropic OAuth is ToS-sensitive.
 *
 * Affinity and cooldown delegate to `src/routing/account-pool/` (process-local).
 * 401/403 credential failures should set needsReauth on the store (existing OAuth path)
 * so the account is excluded from eligibility.
 */
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  pickRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import {
  ACCOUNT_POOL_MAX_FAILOVERS,
  affinitySizeForTests,
  bindSessionAffinity,
  buildSessionKeyFromParts,
  clearAccountPoolState,
  clearAffinityState,
  clearResolveState,
  clearSessionAffinityForAccount,
  getPoolCooldownRegistry,
  getSessionAffinity,
  isAccountPoolEligible,
  isRateLimitStickWait,
  normalizeAffinityComponent,
  recordPoolAccountCooldown,
  resolvePoolAccount,
  touchSessionAffinity,
  type AccountPoolPlugin,
} from "../routing/account-pool";

const PROVIDER = "anthropic";
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const DEFAULT_QUOTA_WINDOW: OcxAccountPoolQuotaWindow = "five-hour";
const VALID_QUOTA_WINDOWS = new Set<OcxAccountPoolQuotaWindow>(["five-hour", "weekly", "max-utilization"]);
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST = ACCOUNT_POOL_MAX_FAILOVERS;

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Usage window for quota-based scoring. Default "five-hour". */
  quotaWindow?: OcxAccountPoolQuotaWindow;
}

const anthropicPoolPlugin: AccountPoolPlugin = {
  poolKey: POOL_KEY_ANTHROPIC,
  sessionKeyFromRequest: buildSessionKeyFromParts,
  listEligibleAccountIds(now) {
    const set = getAccountSet(PROVIDER);
    if (!set) return [];
    return set.accounts
      .filter(account =>
        account.needsReauth !== true
        && isPoolCredentialUsable(account.id, now))
      .map(account => account.id);
  },
  usageScore(accountId) {
    return fiveHourScore(accountId);
  },
};

const TOKEN_SKEW_MS = 60_000;

export function anthropicAccountPoolConfig(config: OcxConfig): AnthropicAccountPoolConfig {
  const raw = config.anthropicAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isAnthropicAccountPoolEnabled(config: OcxConfig): boolean {
  return anthropicAccountPoolConfig(config).enabled === true;
}

export function anthropicAutoSwitchThreshold(config: OcxConfig): number {
  const value = anthropicAccountPoolConfig(config).autoSwitchThreshold;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolQuotaWindow(raw: unknown): OcxAccountPoolQuotaWindow | null {
  if (typeof raw === "string" && VALID_QUOTA_WINDOWS.has(raw as OcxAccountPoolQuotaWindow)) {
    return raw as OcxAccountPoolQuotaWindow;
  }
  return null;
}

export function normalizeAccountPoolQuotaWindow(raw: unknown): OcxAccountPoolQuotaWindow {
  return parseAccountPoolQuotaWindow(raw) ?? DEFAULT_QUOTA_WINDOW;
}

export function anthropicQuotaWindow(config: AnthropicAccountPoolConfig): OcxAccountPoolQuotaWindow {
  return normalizeAccountPoolQuotaWindow(config.quotaWindow);
}

export function getAnthropicAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: "retry-after" | "default" } | null {
  const entry = getPoolCooldownRegistry(POOL_KEY_ANTHROPIC).get(accountId, now);
  if (!entry) return null;
  const source = entry.source === "retry-after" ? "retry-after" : "default";
  return { cooldownUntil: entry.until, cooldownSource: source };
}

export function clearAnthropicAccountCooldown(accountId: string): boolean {
  const registry = getPoolCooldownRegistry(POOL_KEY_ANTHROPIC);
  const had = registry.get(accountId) !== null;
  registry.clear(accountId);
  return had;
}

export function sweepExpiredAnthropicRoutingHealth(now = Date.now()): number {
  return getPoolCooldownRegistry(POOL_KEY_ANTHROPIC).sweep(now);
}

/** Test / logout helper. */
export function clearAnthropicAccountPoolState(): void {
  clearAccountPoolState(POOL_KEY_ANTHROPIC);
  quorumCache = null;
}

export function anthropicSessionAffinitySizeForTests(): number {
  return affinitySizeForTests(POOL_KEY_ANTHROPIC);
}

function fiveHourKnown(accountId: string): boolean {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.fiveHourPercent;
  return typeof percent === "number" && Number.isFinite(percent);
}

function weeklyKnown(accountId: string): boolean {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.weeklyPercent;
  return typeof percent === "number" && Number.isFinite(percent);
}

function fiveHourScore(accountId: string): number {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.fiveHourPercent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : UNKNOWN_USAGE_SCORE;
}

function weeklyScore(accountId: string): number {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.weeklyPercent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : UNKNOWN_USAGE_SCORE;
}

function exhausted5h(accountId: string): boolean {
  return fiveHourKnown(accountId) && fiveHourScore(accountId) >= 100;
}

function hasKnownUsage(config: OcxConfig, accountId: string): boolean {
  switch (anthropicQuotaWindow(anthropicAccountPoolConfig(config))) {
    case "five-hour": return fiveHourKnown(accountId);
    case "weekly": return weeklyKnown(accountId);
    case "max-utilization": return fiveHourKnown(accountId) || weeklyKnown(accountId);
  }
}

function anthropicUsageScore(config: OcxConfig, accountId: string): number {
  switch (anthropicQuotaWindow(anthropicAccountPoolConfig(config))) {
    case "five-hour": return fiveHourScore(accountId);
    case "weekly": return weeklyScore(accountId);
    case "max-utilization": {
      const scores = [
        ...(fiveHourKnown(accountId) ? [fiveHourScore(accountId)] : []),
        ...(weeklyKnown(accountId) ? [weeklyScore(accountId)] : []),
      ];
      return scores.length > 0 ? Math.max(...scores) : UNKNOWN_USAGE_SCORE;
    }
  }
}

/** Background `local-cli` slots with expired access are not pool-eligible (identity adoption risk). */
function isPoolCredentialUsable(accountId: string, now: number): boolean {
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  if (canRefreshAnthropicPoolAccount(accountId)) return true;
  return cred.expires > now + TOKEN_SKEW_MS;
}

function isAnthropicAccountEligible(accountId: string, now: number): boolean {
  return isAccountPoolEligible(POOL_KEY_ANTHROPIC, accountId, now, {
    allowStickWait: isRateLimitStickWait(POOL_KEY_ANTHROPIC, accountId, now),
  });
}

export function getEligibleAnthropicAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && isAnthropicAccountEligible(account.id, now)
      && isPoolCredentialUsable(account.id, now))
    .map(account => account.id);
}

/**
 * How long a quorum answer may be reused before the store is consulted again.
 *
 * This predicate now runs on the INITIAL resolution of every Anthropic request, not just after a
 * 429, so an uncached implementation puts a synchronous file read in front of ordinary traffic:
 * `getAccountSet` goes through `loadAuthStore`, which has no cache of its own and chmods the
 * config dir, chmods the secret, reads the whole file and normalizes it on every call.
 *
 * Two seconds matches the generic module's `PRESENCE_CACHE_TTL_MS` for the same reason: short
 * enough that a login in another window is visible before the operator can switch back and send a
 * prompt, long enough that a burst of requests shares one read. The cache holds a BOOLEAN derived
 * from a count — never a credential, never an account id.
 *
 * Staleness is bounded by consequence, not only by the TTL. Explicit invalidation covers the
 * roster mutations this module can see (rotation, pool-state reset, affinity clear on account
 * removal, manual selection), but not one it cannot: a 401 elsewhere flagging an account
 * `needsReauth` drops the real quorum to one while a cached `true` survives for up to 2s.
 *
 * That window is harmless in both directions, which is why it is left rather than plumbed
 * through the store. A stale `true` only lets the caller ASK for an alternate;
 * `pickAlternateAnthropicAccount` re-reads the roster through `getEligibleAnthropicAccounts`,
 * skips the reauth-flagged account and returns `null`, so the 429 surfaces exactly as it would
 * have. A stale `false` costs one un-rotated 429 and self-corrects on the next read. Neither
 * can dispatch on an unusable credential, which is the only outcome worth adding a store hook
 * to prevent.
 */
const QUORUM_CACHE_TTL_MS = 2_000;

let quorumCache: { value: boolean; readAt: number } | null = null;

/**
 * Whether a 429 has somewhere to go: two or more accounts that could serve traffic if asked.
 *
 * Reactive failover is a safety net, not a routing policy. It runs only AFTER upstream refused,
 * it cannot spread load across a healthy session, and it cannot fire at all unless the operator
 * deliberately logged in twice. So it activates on presence, exactly like an `apiKeyPool` of two
 * keys does in `providers/key-failover.ts` -- and unlike the PROACTIVE pool (affinity,
 * quota-ranked new-session picks, `autoSwitchThreshold`, `strategy`), which changes which
 * account serves a healthy request and therefore stays behind `anthropicAccountPool.enabled`.
 *
 * Cooldowns are deliberately ignored here. They are transient and per-request, while this
 * answers the durable question "did the operator store a second account". Counting a cooled
 * account as absent would switch the feature off for the length of the cooldown -- precisely
 * when it is needed.
 *
 * `isPoolCredentialUsable` is still applied, so the fail-closed background `local-cli` rule
 * holds: an expired background slot is not a quorum and cannot be adopted.
 */
export function hasAnthropicFailoverQuorum(now = Date.now()): boolean {
  // Monotonic guard: a caller-supplied `now` that predates the cached read (tests pass explicit
  // clocks) must not be served from a future entry.
  if (quorumCache && now >= quorumCache.readAt && now - quorumCache.readAt < QUORUM_CACHE_TTL_MS) {
    return quorumCache.value;
  }
  const set = getAccountSet(PROVIDER);
  let value = false;
  if (set) {
    let usable = 0;
    for (const account of set.accounts) {
      if (account.needsReauth === true) continue;
      if (!isPoolCredentialUsable(account.id, now)) continue;
      if (++usable >= 2) { value = true; break; }
    }
  }
  quorumCache = { value, readAt: now };
  return value;
}

/** Test seam and manual-recovery hook: force the next quorum question to re-read the store. */
export function forgetAnthropicFailoverQuorum(): void {
  quorumCache = null;
}

/** Earliest remaining cooldown among cooled Anthropic accounts, for client Retry-After. */
export function getAnthropicPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getAnthropicAccountHealthSnapshot(account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
}

interface ScoredAccount {
  accountId: string;
  hasKnownUsage: boolean;
  score: number;
  fiveHourTieBreak: number;
  knownFirst: boolean;
}

function compareScoredAccounts(a: ScoredAccount, b: ScoredAccount): number {
  if (a.knownFirst && b.knownFirst && a.hasKnownUsage !== b.hasKnownUsage) {
    return a.hasKnownUsage ? -1 : 1;
  }
  return a.score - b.score || a.fiveHourTieBreak - b.fiveHourTieBreak;
}

function pickLowestUsage(config: OcxConfig, excludeId: string | undefined, now: number): string | null {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  const unfiltered = getEligibleAnthropicAccounts(now).filter(id => id !== excludeId);
  const available = window === "weekly" ? unfiltered.filter(id => !exhausted5h(id)) : unfiltered;
  const eligible = available.length > 0 ? available : unfiltered;
  if (eligible.length === 0) return null;
  const scored: ScoredAccount[] = eligible.map(accountId => ({
    accountId,
    hasKnownUsage: hasKnownUsage(config, accountId),
    score: anthropicUsageScore(config, accountId),
    fiveHourTieBreak: window === "five-hour" ? 0 : fiveHourScore(accountId),
    knownFirst: window !== "five-hour",
  }));
  let best = scored[0]!;
  for (let i = 1; i < scored.length; i++) {
    const candidate = scored[i]!;
    if (compareScoredAccounts(candidate, best) < 0) best = candidate;
  }
  return best.accountId;
}

/** Next eligible Anthropic account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAnthropicAccount(
  config: OcxConfig,
  afterId: string,
  eligible: string[],
): string | null {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  const available = window === "weekly" ? eligible.filter(id => !exhausted5h(id)) : eligible;
  const candidates = available.length > 0 ? available : eligible;
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((a, b) => a.localeCompare(b));
  const set = getAccountSet(PROVIDER);
  const stableAll = set
    ? [...set.accounts.map(a => a.id)].sort((a, b) => a.localeCompare(b))
    : ordered;
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id)) return id;
    }
    return ordered[0] ?? null;
  }
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!candidates.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(config, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickAlternateAnthropicAccount(
  config: OcxConfig,
  excludeId: string,
  now: number,
): string | null {
  const strategy = anthropicPoolStrategy(config);
  const eligible = getEligibleAnthropicAccounts(now).filter(id => id !== excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_ANTHROPIC, eligible, stickyLimitForPool(config));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAnthropicAccount(config, excludeId, eligible);
  }
  return pickLowestUsage(config, excludeId, now);
}

export type AnthropicAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface AnthropicAccountSelection {
  accountId: string | null;
  reason: AnthropicAccountSelectionReason;
}

function stickyLimitForPool(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(anthropicAccountPoolConfig(config).stickyLimit);
}

function anthropicPoolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(anthropicAccountPoolConfig(config).strategy);
}

function isActiveUnderFillFirstThreshold(config: OcxConfig, accountId: string): boolean {
  const threshold = anthropicAutoSwitchThreshold(config);
  if (threshold <= 0) return true;
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  if (window === "weekly" && exhausted5h(accountId)) return false;
  if (!hasKnownUsage(config, accountId)) return true;
  return anthropicUsageScore(config, accountId) < threshold;
}

function pickFillFirstAnthropicAccount(config: OcxConfig, now: number): string | null {
  const eligible = getEligibleAnthropicAccounts(now);
  if (eligible.length === 0) return null;

  const set = getAccountSet(PROVIDER);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isActiveUnderFillFirstThreshold(config, active)) {
    return active;
  }

  if (!active || !set) {
    const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id)) return id;
    }
    return ordered[0] ?? null;
  }

  return pickNextFillFirstAnthropicAccount(config, active, eligible);
}

function resolveAnthropicFillFirst(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  set: NonNullable<ReturnType<typeof getAccountSet>>,
  now: number,
): AnthropicAccountSelection {
  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = getSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
    if (affined) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (
        stillThere
        && isAnthropicAccountEligible(affined.accountId, now)
        && isPoolCredentialUsable(affined.accountId, now)
      ) {
        touchSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
        return { accountId: affined.accountId, reason: "affinity" };
      }
      clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, affined.accountId);
    }
  }

  if (!key) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && isAnthropicAccountEligible(set.activeAccountId, now)
      && isPoolCredentialUsable(set.activeAccountId, now);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const picked = pickFillFirstAnthropicAccount(config, now);
  if (!picked) {
    const anyCooled = set.accounts.some(a => !isAnthropicAccountEligible(a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key && normalizeAffinityComponent(picked)) {
    bindSessionAffinity(POOL_KEY_ANTHROPIC, key, picked, now);
  }
  return { accountId: picked, reason: "fill-first" };
}

function resolveAnthropicQuota(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  set: NonNullable<ReturnType<typeof getAccountSet>>,
  now: number,
): AnthropicAccountSelection {
  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = getSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
    if (affined) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (
        stillThere
        && isAnthropicAccountEligible(affined.accountId, now)
        && isPoolCredentialUsable(affined.accountId, now)
      ) {
        touchSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
        return { accountId: affined.accountId, reason: "affinity" };
      }
      clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, affined.accountId);
    }
  }

  const threshold = anthropicAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && isAnthropicAccountEligible(set.activeAccountId, now)
    && isPoolCredentialUsable(set.activeAccountId, now);
  let accountId: string | null = null;
  let reason: AnthropicAccountSelectionReason = "none";

  if (threshold > 0) {
    const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
    if (activeOk
      && !(window === "weekly" && exhausted5h(set.activeAccountId))
      && (!hasKnownUsage(config, set.activeAccountId)
        || anthropicUsageScore(config, set.activeAccountId) < threshold)) {
      accountId = set.activeAccountId;
      reason = "active";
    } else {
      const picked = pickLowestUsage(config, undefined, now);
      if (picked) {
        accountId = picked;
        reason = activeOk && picked === set.activeAccountId ? "active" : "lowest-usage";
      } else if (activeOk) {
        accountId = set.activeAccountId;
        reason = "active";
      }
    }
  } else if (activeOk) {
    accountId = set.activeAccountId;
    reason = "active";
  } else {
    const picked = pickLowestUsage(config, set.activeAccountId, now);
    if (picked) {
      accountId = picked;
      reason = "only-eligible";
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(a => !isAnthropicAccountEligible(a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }
  if (key && normalizeAffinityComponent(accountId)) {
    bindSessionAffinity(POOL_KEY_ANTHROPIC, key, accountId, now);
  }
  return { accountId, reason };
}

/**
 * Resolve which Anthropic OAuth account should serve this session.
 * When the pool is disabled, always returns the store's active account.
 */
export function resolveAnthropicAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): AnthropicAccountSelection {
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isAnthropicAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const strategy = anthropicPoolStrategy(config);
  if (strategy === "fill-first") {
    return resolveAnthropicFillFirst(sessionKey, config, set, now);
  }
  if (strategy === "quota") {
    return resolveAnthropicQuota(sessionKey, config, set, now);
  }

  const kernelResult = resolvePoolAccount(
    anthropicPoolPlugin,
    sessionKey ?? null,
    {
      strategy: "round-robin",
      enabled: true,
      activeAccountId: set.activeAccountId,
      stickyLimit: stickyLimitForPool(config),
      autoSwitchThreshold: anthropicAutoSwitchThreshold(config),
    },
    now,
  );

  return {
    accountId: kernelResult.accountId,
    reason: kernelResult.reason as AnthropicAccountSelectionReason,
  };
}

export function bindAnthropicSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  bindSessionAffinity(POOL_KEY_ANTHROPIC, sessionKey, accountId, now);
}

export function clearAnthropicSessionAffinityForAccount(accountId: string): void {
  clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, accountId);
  // The roster just lost or changed a member. This is the account-removal path, so the next
  // activation question must re-read rather than answer from a count taken while the account
  // was still present -- otherwise a delete leaves a stale quorum for the length of the TTL.
  quorumCache = null;
}

/**
 * Record a 429 for `failedAccountId`, cool it, clear its affinity, and pick a failover
 * account. Does NOT promote the store active account — caller should promote only after a
 * successful retry (or token resolve).
 */
export function rotateAnthropicAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  // Presence enables reactive recovery only when the operator has not made a choice. An explicit
  // false is authoritative: the second credential may belong to a different billing, retention,
  // or policy domain, so a 429 does not grant permission to replay the request under it.
  const configured = config.anthropicAccountPool?.enabled;
  if (configured === false) return null;
  if (configured !== true && !hasAnthropicFailoverQuorum(now)) return null;

  recordPoolAccountCooldown(
    POOL_KEY_ANTHROPIC,
    failedAccountId,
    "rate_limit",
    retryAfterHeader,
    now,
  );
  clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTHROPIC, failedAccountId);
  // A rotation means the roster in use just changed; do not answer the next activation question
  // from a count read taken before the failure.
  quorumCache = null;

  // The pool's strategy is a PROACTIVE policy. When enabled is absent, presence-defaulted
  // recovery must not silently reactivate round-robin/fill-first merely because dormant values
  // remain in config. The quota picker is the neutral recovery policy used by the default.
  const next = configured === true
    ? pickAlternateAnthropicAccount(config, failedAccountId, now)
    : pickLowestUsage(config, failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    bindSessionAffinity(POOL_KEY_ANTHROPIC, affinityKey, next, now);
  }
  console.warn(
    `[anthropic-pool] 429 on ${formatAnthropicAccountOrdinal(failedAccountId)}; failing over to ${formatAnthropicAccountOrdinal(next)}`,
  );
  return next;
}

/** Promote dashboard active account after a validated failover target is usable. */
export function promoteAnthropicActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best-effort */ });
}

/**
 * Manual selection resets session affinity and seeds the RR ring so the next
 * unbound new session honors the operator-chosen account (Codex parity).
 */
export function resetAnthropicRoutingForManualSelection(accountId: string): void {
  clearAffinityState(POOL_KEY_ANTHROPIC);
  clearResolveState(POOL_KEY_ANTHROPIC);
  seedPoolRotationAccount(POOL_KEY_ANTHROPIC, accountId);
  // A manual account selection is an operator statement about the roster; do not answer the
  // next activation question from a count read before it.
  quorumCache = null;
}

/**
 * Resolve a bearer for pool traffic without adopting a newer global Claude CLI
 * credential into a background multiauth `local-cli` slot (same fail-closed rule
 * as quota probes).
 */
export async function getAnthropicPoolAccessToken(accountId: string): Promise<string> {
  const stored = getAccountCredential(PROVIDER, accountId);
  if (!stored) {
    const { OAuthLoginRequiredError } = await import("./index");
    throw new OAuthLoginRequiredError(PROVIDER);
  }
  if (stored.expires > Date.now() + TOKEN_SKEW_MS) return stored.access;
  if (!canRefreshAnthropicPoolAccount(accountId)) {
    throw new Error("background local-cli token expired; refuse CLI-adopting refresh for pool");
  }
  const { getValidAccessTokenForAccount } = await import("./index");
  return getValidAccessTokenForAccount(PROVIDER, accountId);
}

/**
 * Whether the pool may refresh this account's token. Background `local-cli` slots must not
 * adopt the global Claude CLI credential (same fail-closed rule as quota probes).
 */
export function canRefreshAnthropicPoolAccount(accountId: string): boolean {
  const set = getAccountSet(PROVIDER);
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  return set?.activeAccountId === accountId;
}

export function formatAnthropicAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatAnthropicProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatAnthropicAccountOrdinal(accountId)}`;
}

/**
 * Build a sticky session key from Claude/Responses headers.
 * Prefer true session/thread ids; do not use Desktop shared cache-cohort prompt_cache_key
 * alone (those collide across conversations).
 */
export function anthropicSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  /** When true, prompt_cache_key is a shared Desktop cohort — ignore it for affinity. */
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  return buildSessionKeyFromParts(input);
}
