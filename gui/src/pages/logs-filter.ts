import { matchesLogConversationId } from "../log-conversation-id";
import type { LogSurface, LogSurfaceFilter } from "./logs-surface-filter";
import { logMatchesSurface } from "./logs-surface-filter";

export type { LogSurface, LogSurfaceFilter };
export type LogTimeWindow = "all" | "15m" | "1h" | "24h";
export type LogStatusFilter = "all" | "success" | "errors";

export interface LogFilterState {
  surface: LogSurfaceFilter;
  model: string;
  provider: string;
  statusFilter: LogStatusFilter;
  timeWindow: LogTimeWindow;
  minTokPerSec?: number;
  maxTokPerSec?: number;
  interceptedHelpersOnly: boolean;
  conversationId: string;
  conversationQueryHash?: string;
}

export const DEFAULT_LOG_FILTER_STATE: LogFilterState = {
  surface: "all",
  model: "",
  provider: "",
  statusFilter: "all",
  timeWindow: "all",
  interceptedHelpersOnly: false,
  conversationId: "",
};

export function hasActiveFilters(state: LogFilterState): boolean {
  return (
    state.surface !== "all" ||
    state.model !== "" ||
    state.provider !== "" ||
    state.statusFilter !== "all" ||
    state.timeWindow !== "all" ||
    state.minTokPerSec !== undefined ||
    state.maxTokPerSec !== undefined ||
    state.interceptedHelpersOnly ||
    state.conversationId.trim() !== ""
  );
}

export interface MinimalLogAttempt {
  provider?: string;
  model?: string;
}

export interface MinimalLogEntry {
  id?: string;
  timestamp?: number;
  model?: string;
  resolvedModel?: string;
  provider?: string;
  surface?: LogSurface;
  status?: number;
  conversationId?: string;
  shadowCallSource?: string;
  shadowCallRewrittenFrom?: string;
  attempts?: MinimalLogAttempt[];
  displayMetrics?: {
    tokPerSecond?: { kind: "value"; value: number } | { kind: "unavailable" };
  };
}

export function filterLogs<T extends MinimalLogEntry>(
  logs: T[],
  filters: LogFilterState,
  now: number = Date.now(),
): T[] {
  const modelQuery = filters.model.trim().toLowerCase();
  const providerQuery = filters.provider.trim().toLowerCase();
  const conversationQuery = filters.conversationId.trim();

  let timeThreshold = 0;
  if (filters.timeWindow === "15m") {
    timeThreshold = now - 15 * 60 * 1000;
  } else if (filters.timeWindow === "1h") {
    timeThreshold = now - 60 * 60 * 1000;
  } else if (filters.timeWindow === "24h") {
    timeThreshold = now - 24 * 60 * 60 * 1000;
  }

  return logs.filter(log => {
    // Surface filter
    if (!logMatchesSurface(log, filters.surface)) return false;

    // Intercepted helpers
    if (filters.interceptedHelpersOnly && !log.shadowCallRewrittenFrom && log.shadowCallSource !== "agent-helper") {
      return false;
    }

    // Conversation ID
    if (
      conversationQuery &&
      !matchesLogConversationId(
        log.conversationId,
        conversationQuery,
        filters.conversationQueryHash,
      )
    ) {
      return false;
    }

    // Status filter (success: 2xx, errors: >= 400)
    if (filters.statusFilter === "success" && (typeof log.status !== "number" || log.status < 200 || log.status >= 300)) {
      return false;
    }
    if (filters.statusFilter === "errors" && (typeof log.status !== "number" || log.status < 400)) {
      return false;
    }

    // Model filter
    if (modelQuery) {
      const matchModel =
        log.model?.toLowerCase() === modelQuery ||
        log.resolvedModel?.toLowerCase() === modelQuery ||
        log.attempts?.some(a => a.model?.toLowerCase() === modelQuery);
      if (!matchModel) return false;
    }

    // Provider filter
    if (providerQuery) {
      const matchProvider =
        log.provider?.toLowerCase() === providerQuery ||
        log.attempts?.some(a => a.provider?.toLowerCase() === providerQuery);
      if (!matchProvider) return false;
    }

    // Time window
    if (timeThreshold > 0 && typeof log.timestamp === "number" && log.timestamp < timeThreshold) {
      return false;
    }

    // Token speed (tok/s)
    const tokSpeed = log.displayMetrics?.tokPerSecond?.kind === "value"
      ? log.displayMetrics.tokPerSecond.value
      : undefined;

    if (filters.minTokPerSec !== undefined) {
      if (tokSpeed === undefined || tokSpeed < filters.minTokPerSec) return false;
    }
    if (filters.maxTokPerSec !== undefined) {
      if (tokSpeed === undefined || tokSpeed > filters.maxTokPerSec) return false;
    }

    return true;
  });
}

export function extractLogFilterOptions<T extends MinimalLogEntry>(logs: T[]): {
  models: string[];
  providers: string[];
} {
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();

  for (const log of logs) {
    if (log.model) modelSet.add(log.model);
    if (log.resolvedModel) modelSet.add(log.resolvedModel);
    if (log.provider) providerSet.add(log.provider);
    if (log.attempts) {
      for (const attempt of log.attempts) {
        if (attempt.model) modelSet.add(attempt.model);
        if (attempt.provider) providerSet.add(attempt.provider);
      }
    }
  }

  return {
    models: Array.from(modelSet).sort(),
    providers: Array.from(providerSet).sort(),
  };
}
