import { describe, expect, test } from "bun:test";
import { oauthAccountLogLabel } from "../src/codex/account-label";
import { isPersistableAccountLogLabel, type PersistedUsageEntry } from "../src/usage/log";
import { summarizeUsage } from "../src/usage/summary";

function entry(requestId: string, accountLogLabel?: string): PersistedUsageEntry {
  return {
    requestId,
    timestamp: 1_787_460_817_943,
    provider: "command-code",
    model: "gpt-5.6-luna",
    ...(accountLogLabel ? { accountLogLabel } : {}),
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    totalTokens: 110,
  };
}

describe("account usage attribution and filtering", () => {
  test("accepts current digest labels and legacy non-PII OAuth labels", () => {
    expect(isPersistableAccountLogLabel("main")).toBe(true);
    expect(isPersistableAccountLogLabel("pabc123")).toBe(true);
    expect(isPersistableAccountLogLabel("oabc123")).toBe(true);
    expect(isPersistableAccountLogLabel("a3ddfc22b5701915a5617a386883ff26")).toBe(true);
    expect(isPersistableAccountLogLabel("a3ddfc22b5701915a5617a386883ff26-1")).toBe(true);
    expect(isPersistableAccountLogLabel("person@example.com")).toBe(false);
    expect(isPersistableAccountLogLabel(null)).toBe(false);
  });

  test("attributes only stamped non-Codex OAuth rows", () => {
    const first = oauthAccountLogLabel("account-1", "command-code");
    const second = oauthAccountLogLabel("account-2", "command-code");
    const summary = summarizeUsage([
      entry("unlabelled"),
      entry("first", first),
      entry("second", second),
    ], "30d", 1_787_460_817_943);

    expect(summary.accounts.map(row => row.accountLogLabel).sort()).toEqual([first, second].sort());
  });
});
