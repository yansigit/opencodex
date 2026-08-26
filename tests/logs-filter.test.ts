import { describe, expect, test } from "bun:test";
import {
  filterLogs,
  extractLogFilterOptions,
  type LogFilterState,
  DEFAULT_LOG_FILTER_STATE,
} from "../gui/src/pages/logs-filter";

describe("logs-filter", () => {
  const sampleLogs = [
    {
      id: "req_1",
      timestamp: Date.now() - 5 * 60 * 1000, // 5 min ago
      model: "claude-3-5-sonnet",
      resolvedModel: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      surface: "claude" as const,
      status: 200,
      conversationId: "conv-123",
      displayMetrics: {
        tokPerSecond: { kind: "value" as const, value: 45.5, estimated: false },
        cost: { kind: "unavailable" as const, reason: "usage_missing" as const },
      },
    },
    {
      id: "req_2",
      timestamp: Date.now() - 30 * 60 * 1000, // 30 min ago
      model: "gpt-4o",
      provider: "openai",
      status: 500,
      conversationId: "conv-456",
      displayMetrics: {
        tokPerSecond: { kind: "value" as const, value: 12.0, estimated: false },
        cost: { kind: "unavailable" as const, reason: "usage_missing" as const },
      },
    },
    {
      id: "req_3",
      timestamp: Date.now() - 2 * 3600 * 1000, // 2 hours ago
      model: "gemini-1.5-pro",
      provider: "google",
      status: 200,
      conversationId: "conv-123",
      displayMetrics: {
        tokPerSecond: { kind: "value" as const, value: 85.2, estimated: false },
        cost: { kind: "unavailable" as const, reason: "usage_missing" as const },
      },
      shadowCallSource: "agent-helper",
      attempts: [
        {
          ordinal: 0,
          provider: "google-backup",
          model: "gemini-1.5-flash",
          adapter: "gemini",
          status: 429,
          durationMs: 500,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "unreported" as const,
        },
      ],
    },
  ];

  test("default filter returns all logs", () => {
    const filtered = filterLogs(sampleLogs as any, DEFAULT_LOG_FILTER_STATE);
    expect(filtered.length).toBe(3);
  });

  test("filters by model including resolvedModel and attempt model", () => {
    const byExact = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      model: "claude-3-5-sonnet",
    });
    expect(byExact.map(l => l.id)).toEqual(["req_1"]);

    const byResolved = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      model: "claude-3-5-sonnet-20241022",
    });
    expect(byResolved.map(l => l.id)).toEqual(["req_1"]);

    const byAttempt = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      model: "gemini-1.5-flash",
    });
    expect(byAttempt.map(l => l.id)).toEqual(["req_3"]);
  });

  test("filters by provider including attempt provider", () => {
    const byMain = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      provider: "openai",
    });
    expect(byMain.map(l => l.id)).toEqual(["req_2"]);

    const byAttempt = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      provider: "google-backup",
    });
    expect(byAttempt.map(l => l.id)).toEqual(["req_3"]);
  });

  test("filters by status (success vs errors)", () => {
    const successLogs = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      statusFilter: "success",
    });
    expect(successLogs.map(l => l.id)).toEqual(["req_1", "req_3"]);

    const errorLogs = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      statusFilter: "errors",
    });
    expect(errorLogs.map(l => l.id)).toEqual(["req_2"]);
  });

  test("filters by token speed (min/max tok/s)", () => {
    const slowLogs = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      maxTokPerSec: 20,
    });
    expect(slowLogs.map(l => l.id)).toEqual(["req_2"]);

    const fastLogs = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      minTokPerSec: 50,
    });
    expect(fastLogs.map(l => l.id)).toEqual(["req_3"]);

    const midLogs = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      minTokPerSec: 20,
      maxTokPerSec: 50,
    });
    expect(midLogs.map(l => l.id)).toEqual(["req_1"]);
  });

  test("filters by time window preset", () => {
    const now = Date.now();
    const last15m = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      timeWindow: "15m",
    }, now);
    expect(last15m.map(l => l.id)).toEqual(["req_1"]);

    const last1h = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      timeWindow: "1h",
    }, now);
    expect(last1h.map(l => l.id)).toEqual(["req_1", "req_2"]);

    const last24h = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      timeWindow: "24h",
    }, now);
    expect(last24h.map(l => l.id)).toEqual(["req_1", "req_2", "req_3"]);
  });

  test("filters by intercepted helpers only", () => {
    const intercepted = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      interceptedHelpersOnly: true,
    });
    expect(intercepted.map(l => l.id)).toEqual(["req_3"]);
  });

  test("filters by conversation ID", () => {
    const byConv = filterLogs(sampleLogs as any, {
      ...DEFAULT_LOG_FILTER_STATE,
      conversationId: "conv-123",
    });
    expect(byConv.map(l => l.id)).toEqual(["req_1", "req_3"]);
  });

  test("extracts unique models and providers for dropdown options", () => {
    const options = extractLogFilterOptions(sampleLogs as any);
    expect(options.models).toContain("claude-3-5-sonnet");
    expect(options.models).toContain("gpt-4o");
    expect(options.models).toContain("gemini-1.5-pro");
    expect(options.providers).toContain("anthropic");
    expect(options.providers).toContain("openai");
    expect(options.providers).toContain("google");
  });
});

