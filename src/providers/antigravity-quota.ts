import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { antigravityHostCandidates, isAntigravityHttpsHost } from "../adapters/google-antigravity-hosts";
import { readProviderQuotaJsonForTests } from "./quota";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota";

const LIVE_QUOTA_PATH = "/v1internal:retrieveUserQuota";
const LIVE_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";

type FetchImpl = typeof fetch;

export interface AntigravityLiveQuotaArgs {
  accessToken: string;
  projectId: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

interface QuotaCandidate {
  record: Record<string, unknown>;
  path: string[];
}

export type AntigravityLiveQuotaSource =
  | "google-antigravity:retrieveUserQuota"
  | "google-antigravity:retrieveUserQuotaSummary";

interface HostQuotaCandidate {
  quota: ProviderQuota;
  source: AntigravityLiveQuotaSource;
  retryForCompleteness: boolean;
}

const liveQuotaSources = new WeakMap<ProviderQuota, AntigravityLiveQuotaSource>();

export function antigravityLiveQuotaSource(quota: ProviderQuota): AntigravityLiveQuotaSource {
  return liveQuotaSources.get(quota) ?? "google-antigravity:retrieveUserQuota";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

function resetAt(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function remainingPercent(record: Record<string, unknown>): number | undefined {
  const target = asRecord(record.remaining) ?? record;
  const fraction = finiteNumber(target.remainingFraction);
  if (fraction !== undefined) return normalizePercent(fraction * 100);
  const percentage = finiteNumber(
    target.remainingPercentage
      ?? target.remainingPercent
      ?? target.remaining_percent,
  );
  if (percentage !== undefined) return normalizePercent(percentage);
  return undefined;
}

function usedPercent(record: Record<string, unknown>): number | undefined {
  const remaining = remainingPercent(record);
  return remaining === undefined ? undefined : normalizePercent(100 - remaining);
}

function recordResetAt(record: Record<string, unknown>): number | undefined {
  return resetAt(record.resetTime ?? record.resetAt ?? record.resetsAt ?? record.reset_time ?? record.nextReset);
}

function collectCandidates(value: unknown, path: string[] = [], output: QuotaCandidate[] = []): QuotaCandidate[] {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectCandidates(item, [...path, String(index)], output);
    return output;
  }
  const record = asRecord(value);
  if (!record) return output;
  output.push({ record, path });
  for (const [key, child] of Object.entries(record)) {
    if (child && typeof child === "object") collectCandidates(child, [...path, key], output);
  }
  return output;
}

function candidateModelName(record: Record<string, unknown>): string {
  const explicit = record.modelId
    ?? record.model_id
    ?? record.modelName
    ?? record.model
    ?? record.name
    ?? record.displayName
    ?? record.modelFamily
    ?? record.model_family;
  return typeof explicit === "string" ? explicit.toLowerCase() : "";
}

function parseGeminiWindow(payload: unknown): ProviderQuotaWindow | undefined {
  for (const candidate of collectCandidates(payload)) {
    if (!candidateModelName(candidate.record).includes("gemini")) continue;
    const percent = usedPercent(candidate.record);
    if (percent === undefined) continue;
    const reset = recordResetAt(candidate.record);
    return {
      label: "Gem",
      percent,
      ...(reset !== undefined ? { resetAt: reset } : {}),
    };
  }
  return undefined;
}

function isWeeklyPath(path: string[]): boolean {
  const leaf = path.at(-1);
  return typeof leaf === "string" && /weekly|week|seven[_-]?day/i.test(leaf);
}

function parseWeeklyWindow(payload: unknown): { percent: number; resetAt?: number } | undefined {
  const candidates = collectCandidates(payload);
  for (const candidate of candidates) {
    if (!isWeeklyPath(candidate.path)) continue;
    const percent = usedPercent(candidate.record);
    if (percent === undefined) continue;
    const reset = recordResetAt(candidate.record);
    return { percent, ...(reset !== undefined ? { resetAt: reset } : {}) };
  }
  return undefined;
}

function summaryFamily(group: Record<string, unknown>): "Gem" | "Cla" | undefined {
  const name = `${typeof group.displayName === "string" ? group.displayName : ""} ${
    typeof group.description === "string" ? group.description : ""
  }`.toLowerCase();
  if (name.includes("gemini")) return "Gem";
  if (name.includes("claude") || name.includes("3p") || name.includes("gpt")) return "Cla";
  return undefined;
}

/** Family-scoped 5-hour and weekly windows from retrieveUserQuotaSummary. */
function parseSummaryWindows(payload: unknown): ProviderQuotaWindow[] {
  const body = asRecord(payload);
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  const windows = new Map<string, ProviderQuotaWindow>();
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    const family = group ? summaryFamily(group) : undefined;
    if (!group || !family || !Array.isArray(group.buckets)) continue;
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const windowName = `${typeof bucket.window === "string" ? bucket.window : ""} ${
        typeof bucket.bucketId === "string" ? bucket.bucketId : ""
      } ${typeof bucket.displayName === "string" ? bucket.displayName : ""}`.toLowerCase();
      const suffix = windowName.includes("5h") || windowName.includes("five")
        ? ""
        : windowName.includes("week")
          ? " (Weekly)"
          : undefined;
      if (suffix === undefined) continue;
      const label = `${family}${suffix}`;
      if (windows.has(label)) continue;
      const percent = usedPercent(bucket);
      if (percent === undefined) continue;
      const reset = recordResetAt(bucket);
      windows.set(label, {
        label,
        percent,
        ...(reset !== undefined ? { resetAt: reset } : {}),
      });
    }
  }
  const order = ["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)"];
  return [...windows.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  const payload = await readProviderQuotaJsonForTests(response, timeoutMs);
  if (payload === null) throw new Error("Antigravity quota RPC returned unreadable JSON");
  return payload;
}

export class AntigravityQuotaRpcError extends Error {
  constructor(readonly status: number) {
    super(`Antigravity quota RPC failed: ${status}`);
  }
}

export function isTerminalAntigravityQuotaStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

function terminalRpcError(result: PromiseSettledResult<unknown>): AntigravityQuotaRpcError | null {
  if (result.status !== "rejected" || !(result.reason instanceof AntigravityQuotaRpcError)) return null;
  return isTerminalAntigravityQuotaStatus(result.reason.status) ? result.reason : null;
}

async function fetchRpc(
  fetchImpl: FetchImpl,
  host: string,
  method: "retrieveUserQuota" | "retrieveUserQuotaSummary",
  args: AntigravityLiveQuotaArgs,
): Promise<unknown> {
  const path = method === "retrieveUserQuota" ? LIVE_QUOTA_PATH : LIVE_SUMMARY_PATH;
  const response = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({ project: args.projectId }),
    redirect: "error",
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) throw new AntigravityQuotaRpcError(response.status);
  return readJson(response, args.timeoutMs);
}

async function fetchHostQuota(
  fetchImpl: FetchImpl,
  host: string,
  args: AntigravityLiveQuotaArgs,
): Promise<HostQuotaCandidate | null> {
  const [quotaResult, summaryResult] = await Promise.allSettled([
    fetchRpc(fetchImpl, host, "retrieveUserQuota", args),
    fetchRpc(fetchImpl, host, "retrieveUserQuotaSummary", args),
  ]);
  const terminalError = terminalRpcError(quotaResult) ?? terminalRpcError(summaryResult);
  if (terminalError) throw terminalError;
  const quotaPayload = quotaResult.status === "fulfilled" ? quotaResult.value : null;
  const summaryPayload = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const gem = parseGeminiWindow(quotaPayload);
  const summaryWindows = parseSummaryWindows(summaryPayload);
  const weekly = parseWeeklyWindow(summaryPayload);
  // A legacy weekly-only summary is supplemental to retrieveUserQuota. If the
  // daily RPC failed, keep trying the production host instead of accepting it.
  if (quotaResult.status === "rejected" && summaryWindows.length === 0) return null;
  const customWindows = new Map(summaryWindows.map(window => [window.label, window]));
  if (gem && !customWindows.has("Gem")) customWindows.set("Gem", gem);
  if (customWindows.size === 0 && !weekly) return null;
  const order = ["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)"];
  const quota: ProviderQuota = {
    ...(customWindows.size > 0 ? {
      customWindows: [...customWindows.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)),
    } : {}),
    ...(weekly && !customWindows.has("Gem (Weekly)") && !customWindows.has("Cla (Weekly)")
      ? {
          weeklyPercent: weekly.percent,
          ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
        }
      : {}),
    updatedAt: Date.now(),
  };
  const completeSummary = order.every(label => customWindows.has(label));
  return {
    quota,
    source: summaryWindows.length > 0
      ? "google-antigravity:retrieveUserQuotaSummary"
      : "google-antigravity:retrieveUserQuota",
    retryForCompleteness: quotaResult.status === "rejected" && !completeSummary,
  };
}

export async function fetchAntigravityLiveQuota(
  args: AntigravityLiveQuotaArgs,
): Promise<ProviderQuota | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let partial: HostQuotaCandidate | null = null;
  for (const host of antigravityHostCandidates(args.baseUrl)) {
    if (!isAntigravityHttpsHost(host)) continue;
    try {
      const candidate = await fetchHostQuota(fetchImpl, host, args);
      if (!candidate) continue;
      if (candidate.retryForCompleteness) {
        partial ??= candidate;
        continue;
      }
      liveQuotaSources.set(candidate.quota, candidate.source);
      return candidate.quota;
    } catch (error) {
      if (error instanceof AntigravityQuotaRpcError && isTerminalAntigravityQuotaStatus(error.status)) {
        throw error;
      }
    }
  }
  if (!partial) return null;
  liveQuotaSources.set(partial.quota, partial.source);
  return partial.quota;
}
