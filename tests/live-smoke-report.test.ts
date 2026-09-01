import { describe, expect, test } from "bun:test";
import { classifyLiveSmokeFailure, formatLiveSmokeReport } from "../scripts/live-smoke-report";

describe("live smoke privacy-safe reporting", () => {
  test("classifies failures without returning raw provider errors", () => {
    expect(classifyLiveSmokeFailure("The operation timed out after 30000ms")).toBe("timeout");
    expect(classifyLiveSmokeFailure("HTTP 503: unavailable")).toBe("upstream");
    expect(classifyLiveSmokeFailure("level 2 assertion failed")).toBe("assertion");
    expect(classifyLiveSmokeFailure("fetch failed: ECONNRESET")).toBe("transport");
  });

  test("prints bounded diagnostics and omits raw errors, models, and secrets", () => {
    const report = formatLiveSmokeReport([{
      provider: "cursor",
      modelId: "cursor/private-model",
      status: "failed",
      level1Passed: false,
      level2Passed: false,
      level3Passed: false,
      claudeMcpPassed: false,
      durationMs: 30_004.6,
      error: "fetch failed for https://secret.example?token=Bearer-private-value",
    }], 1).join("\n");

    expect(report).toBe("cursor attempt 1: failed (duration=30005ms; gates=fail,fail,fail,fail; category=transport)");
    expect(report).not.toContain("private-model");
    expect(report).not.toContain("secret.example");
    expect(report).not.toContain("Bearer-private-value");
  });

  test("normalizes untrusted provider and skip reasons", () => {
    expect(formatLiveSmokeReport([{
      provider: "provider\n::warning::injected",
      status: "skipped",
      reason: "account-user@example.com",
      durationMs: 1,
    }], 2)).toEqual([
      "unknown-provider attempt 2: skipped (duration=1ms; gates=fail,fail,fail,fail; category=provider_skip)",
    ]);
  });

  test("rejects malformed result structures", () => {
    expect(() => formatLiveSmokeReport([], 1)).toThrow("invalid live smoke result");
    expect(() => formatLiveSmokeReport([{ provider: "cursor", status: "unknown" }], 1)).toThrow("invalid live smoke status");
    expect(() => formatLiveSmokeReport([{ provider: "cursor", status: "passed" }], 3)).toThrow("invalid live smoke attempt");
  });
});
