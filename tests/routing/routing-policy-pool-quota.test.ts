import { afterEach, describe, expect, test } from "bun:test";

import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { codexPoolQuotaEvidence, quotaEvidenceForCandidate } from "../../src/routing/quota";

afterEach(() => clearAccountQuota());

describe("Codex pool quota evidence for routing policies", () => {
  test("uses the best known usable headroom instead of only one active account", () => {
    setAccountQuotaFromParsed("low", { weeklyPercent: 95 });
    setAccountQuotaFromParsed("healthy", { weeklyPercent: 20 });
    expect(codexPoolQuotaEvidence([
      { accountId: "low", plan: "plus" },
      { accountId: "healthy", plan: "plus" },
    ])).toMatchObject({ known: true, exhausted: false, headroom: 0.8, source: "codex-pool" });
  });

  test("the live policy evidence path aggregates the reconciled pool", () => {
    setAccountQuotaFromParsed("active", { weeklyPercent: 96 });
    setAccountQuotaFromParsed("alternate", { weeklyPercent: 25 });
    expect(quotaEvidenceForCandidate({
      provider: "openai",
      model: "gpt-5.6",
      codexAccountId: "active",
      codexAccountPlan: "plus",
    })).toMatchObject({ known: true, exhausted: false, headroom: 0.75, source: "codex-pool" });
  });

  test("reports exhausted only when every pool account is known exhausted", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: Date.now() + 60_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 100, weeklyResetAt: Date.now() + 120_000 });
    const evidence = codexPoolQuotaEvidence([
      { accountId: "a", plan: "plus" },
      { accountId: "b", plan: "plus" },
    ]);
    expect(evidence.known).toBe(true);
    expect(evidence.exhausted).toBe(true);
    expect(evidence.headroom).toBe(0);
    expect(evidence.resetAtMs).toBeDefined();
  });

  test("does not call a partially unknown pool exhausted", () => {
    setAccountQuotaFromParsed("known-exhausted", { weeklyPercent: 100 });
    expect(codexPoolQuotaEvidence([
      { accountId: "known-exhausted", plan: "plus" },
      { accountId: "unknown", plan: "plus" },
    ])).toEqual({ known: false });
  });

  test("credits-only cached evidence stays unknown", () => {
    setAccountQuotaFromParsed("known-exhausted", { weeklyPercent: 100 });
    setAccountQuotaFromParsed("credits-only", { resetCredits: 7 });
    expect(codexPoolQuotaEvidence([
      { accountId: "known-exhausted", plan: "plus" },
      { accountId: "credits-only", plan: "plus" },
    ])).toEqual({ known: false });
  });

  test("terminal short evidence expires and reports second-based reset epochs in milliseconds", () => {
    const originalNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      setAccountQuotaFromParsed("a", {
        weeklyPercent: 20,
        shortPercent: 100,
        shortResetAt: (now + 60_000) / 1000,
      });
      expect(codexPoolQuotaEvidence([{ accountId: "a", plan: "plus" }])).toMatchObject({
        known: true,
        exhausted: true,
        headroom: 0,
        resetAtMs: now + 60_000,
      });

      now += 120_000;
      expect(codexPoolQuotaEvidence([{ accountId: "a", plan: "plus" }])).toEqual({
        known: true,
        exhausted: false,
        headroom: 0.8,
        source: "codex-pool",
      });

      clearAccountQuota("a");
      setAccountQuotaFromParsed("a", { weeklyPercent: 20, shortPercent: 100 });
      expect(codexPoolQuotaEvidence([{ accountId: "a", plan: "plus" }]).exhausted).toBe(true);
      now += 6 * 60_000;
      expect(codexPoolQuotaEvidence([{ accountId: "a", plan: "plus" }])).toMatchObject({
        known: true,
        exhausted: false,
        headroom: 0.8,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("the five-hour compatibility alias remains governing routing evidence", () => {
    const now = Date.now();
    setAccountQuotaFromParsed("alias-only", {
      weeklyPercent: 20,
      fiveHourPercent: 100,
      fiveHourResetAt: now + 60_000,
    });
    expect(codexPoolQuotaEvidence([{ accountId: "alias-only", plan: "plus" }])).toMatchObject({
      known: true,
      exhausted: true,
      headroom: 0,
      resetAtMs: now + 60_000,
    });
  });
});
