import { describe, expect, test } from "bun:test";
import {
  summarizeUsage,
  projectUsageSummary,
  accountLabelForAttribution,
} from "../src/usage/summary";
import { isPersistableAccountLogLabel, type PersistedUsageEntry } from "../src/usage/log";

describe("account usage attribution and filtering", () => {
  test("isPersistableAccountLogLabel accepts valid non-PII Codex and OAuth account IDs", () => {
    expect(isPersistableAccountLogLabel("main")).toBe(true);
    expect(isPersistableAccountLogLabel("pabc123")).toBe(true);
    expect(isPersistableAccountLogLabel("a3ddfc22b5701915a5617a386883ff26")).toBe(true);
    expect(isPersistableAccountLogLabel("a3ddfc22b5701915a5617a386883ff26-1")).toBe(true);
    expect(isPersistableAccountLogLabel("7bbffb6c")).toBe(true);
    expect(isPersistableAccountLogLabel("person@example.com")).toBe(false);
    expect(isPersistableAccountLogLabel("")).toBe(false);
    expect(isPersistableAccountLogLabel(null)).toBe(false);
    expect(isPersistableAccountLogLabel(undefined)).toBe(false);
  });

  test("accountLabelForAttribution falls back to active account for provider when label is missing", () => {
    // Explicit label wins
    expect(accountLabelForAttribution("command-code", "custom-label", { "command-code": "active-id" }))
      .toBe("custom-label");

    // Missing label falls back to active account
    expect(accountLabelForAttribution("command-code", undefined, { "command-code": "active-id" }))
      .toBe("active-id");

    // Account suffix collapses to provider base and falls back
    expect(accountLabelForAttribution("command-code-p123456", undefined, { "command-code": "active-id" }))
      .toBe("active-id");

    // Unmapped provider without legacy label returns null
    expect(accountLabelForAttribution("unknown-provider", undefined, { "command-code": "active-id" }))
      .toBeNull();
  });

  test("summarizeUsage attributes unlabelled entries to active account and includes provider on UsageAccount", () => {
    const now = 1787460817943;
    const entries: PersistedUsageEntry[] = [
      {
        requestId: "req-1",
        timestamp: now - 1000,
        provider: "command-code",
        model: "zai-org/GLM-5.3",
        usageStatus: "reported",
        usage: {
          inputTokens: 1000000,
          outputTokens: 500000,
          totalTokens: 1500000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        requestId: "req-2",
        timestamp: now - 500,
        provider: "command-code",
        model: "gpt-5.6-luna",
        accountLogLabel: "a3ddfc22b5701915a5617a386883ff26",
        usageStatus: "reported",
        usage: {
          inputTokens: 100000,
          outputTokens: 10000,
          totalTokens: 110000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ];

    const fallback = { "command-code": "active-account-id" };
    const summary = summarizeUsage(entries, "30d", now, "all", fallback);

    expect(summary.accounts.length).toBe(2);
    const activeAcc = summary.accounts.find(a => a.accountLogLabel === "active-account-id");
    expect(activeAcc).toBeDefined();
    expect(activeAcc?.provider).toBe("command-code");
    expect(activeAcc?.requests).toBe(1);
    expect(activeAcc?.totalTokens).toBe(1500000);
    // 1M * 1.40 + 0.5M * 4.40 = 3.60
    expect(activeAcc?.estimatedCostUsd).toBeCloseTo(3.60, 4);

    const otherAcc = summary.accounts.find(a => a.accountLogLabel === "a3ddfc22b5701915a5617a386883ff26");
    expect(otherAcc).toBeDefined();
    expect(otherAcc?.provider).toBe("command-code");
    expect(otherAcc?.requests).toBe(1);
    expect(otherAcc?.totalTokens).toBe(110000);
  });

  test("projectUsageSummary filters usage by account", () => {
    const now = 1787460817943;
    const entries: PersistedUsageEntry[] = [
      {
        requestId: "req-1",
        timestamp: now - 1000,
        provider: "command-code",
        model: "zai-org/GLM-5.3",
        accountLogLabel: "a3ddfc22b5701915a5617a386883ff26",
        usageStatus: "reported",
        usage: {
          inputTokens: 1000000,
          outputTokens: 500000,
          totalTokens: 1500000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        requestId: "req-2",
        timestamp: now - 500,
        provider: "command-code",
        model: "gpt-5.6-luna",
        accountLogLabel: "b3ddfc22b5701915a5617a386883ff26",
        usageStatus: "reported",
        usage: {
          inputTokens: 100000,
          outputTokens: 10000,
          totalTokens: 110000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ];

    const fullSummary = summarizeUsage(entries, "30d", now, "all");
    const projected = projectUsageSummary(
      fullSummary,
      { provider: "command-code", account: "a3ddfc22b5701915a5617a386883ff26" },
      entries,
    );

    expect(projected.summary.requests).toBe(1);
    expect(projected.summary.totalTokens).toBe(1500000);
    expect(projected.summary.estimatedCostUsd).toBeCloseTo(3.60, 4);
    expect(projected.models.length).toBe(1);
    expect(projected.models[0].model).toBe("zai-org/GLM-5.3");
  });

  test("Google Antigravity accounts are attributed per account ID", () => {
    const now = 1787460817943;
    const acc1 = "a3ddfc22b5701915a5617a386883ff26";
    const acc2 = "b3ddfc22b5701915a5617a386883ff26";
    const entries: PersistedUsageEntry[] = [
      {
        requestId: "req-ag-1",
        timestamp: now - 1000,
        provider: "google-antigravity",
        model: "gemini-3.7-flash",
        accountLogLabel: acc1,
        usageStatus: "reported",
        usage: {
          inputTokens: 2000000,
          outputTokens: 1000000,
          totalTokens: 3000000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        requestId: "req-ag-2",
        timestamp: now - 500,
        provider: "google-antigravity",
        model: "gemini-3.7-flash",
        accountLogLabel: acc2,
        usageStatus: "reported",
        usage: {
          inputTokens: 500000,
          outputTokens: 250000,
          totalTokens: 750000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ];

    const summary = summarizeUsage(entries, "30d", now, "all");
    expect(summary.accounts.length).toBe(2);

    const row1 = summary.accounts.find(a => a.accountLogLabel === acc1);
    const row2 = summary.accounts.find(a => a.accountLogLabel === acc2);
    expect(row1).toBeDefined();
    expect(row1?.requests).toBe(1);
    expect(row1?.totalTokens).toBe(3000000);
    expect(row2).toBeDefined();
    expect(row2?.requests).toBe(1);
    expect(row2?.totalTokens).toBe(750000);
  });
});
