import { describe, expect, test } from "bun:test";
import {
  clearAccountQuota,
  getAccountQuota,
  isCodexQuotaExhausted,
  parseUpstreamQuotaHeaders,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "../src/codex/quota";

describe("codex quota parsing & preservation", () => {
  test("parseUpstreamQuotaHeaders parses sub-day primary window as 5h and preserves secondary as weekly", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "25",
      "x-codex-primary-reset-at": "1780000000",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "60",
      "x-codex-secondary-reset-at": "1780500000",
      "x-codex-secondary-window-minutes": "10080",
    });

    const parsed = parseUpstreamQuotaHeaders(headers);
    expect(parsed).toEqual({
      fiveHourPercent: 25,
      fiveHourResetAt: 1780000000,
      shortPercent: 25,
      shortResetAt: 1780000000,
      shortWindowSeconds: 18000,
      weeklyPercent: 60,
      weeklyResetAt: 1780500000,
    });
  });

  test("parseUsageQuota populates both fiveHourPercent and shortPercent for burst window", () => {
    const data = {
      rate_limit: {
        primary_window: { used_percent: 15, reset_at: 1780000000, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 45, reset_at: 1780500000, limit_window_seconds: 604800 },
      },
    };

    const parsed = parseUsageQuota(data);
    expect(parsed).toEqual({
      fiveHourPercent: 15,
      fiveHourResetAt: 1780000000,
      shortPercent: 15,
      shortResetAt: 1780000000,
      shortWindowSeconds: 18000,
      weeklyPercent: 45,
      weeklyResetAt: 1780500000,
    });
  });

  test("isCodexQuotaExhausted recognizes 5-hour burst exhaustion", () => {
    expect(isCodexQuotaExhausted({ fiveHourPercent: 100, weeklyPercent: 10 })).toBe(true);
    expect(isCodexQuotaExhausted({ shortPercent: 100, weeklyPercent: 10 })).toBe(true);
    expect(isCodexQuotaExhausted({ fiveHourPercent: 50, weeklyPercent: 10 })).toBe(false);
  });

  test("setAccountQuotaFromParsed and updateAccountQuota preserve fiveHour fields", () => {
    clearAccountQuota("test-acct");
    setAccountQuotaFromParsed("test-acct", {
      fiveHourPercent: 20,
      fiveHourResetAt: 1780000000,
      weeklyPercent: 40,
      weeklyResetAt: 1780500000,
    });

    expect(getAccountQuota("test-acct")).toMatchObject({
      fiveHourPercent: 20,
      fiveHourResetAt: 1780000000,
      weeklyPercent: 40,
      weeklyResetAt: 1780500000,
    });

    updateAccountQuota("test-acct", 55, 1780600000);
    expect(getAccountQuota("test-acct")).toMatchObject({
      fiveHourPercent: 20,
      fiveHourResetAt: 1780000000,
      weeklyPercent: 55,
      weeklyResetAt: 1780600000,
    });
  });
});
