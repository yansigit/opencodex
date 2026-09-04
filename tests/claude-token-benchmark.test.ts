import { describe, expect, test } from "bun:test";

import {
  canonicalFixtureDigest,
  defaultTokenBenchmarkFixtureSet,
  formatBenchmarkReport,
  materializeFixture,
  runTokenBenchmark,
  TOKEN_BENCHMARK_FIXTURE_SCHEMA_VERSION,
  type AuthoritativeCountCall,
  type AuthoritativeCountResult,
  type AuthoritativeCountTransport,
  type TokenBenchmarkFixture,
  type TokenBenchmarkReport,
} from "../src/claude/token-benchmark";
import { serializeBenchmarkReport } from "../src/claude/token-benchmark";
import { estimateClaudeRequestTokens } from "../src/server/claude-messages";

const MODEL_ID = "offline-benchmark-model";
const PROVIDER_KIND = "benchmark-local";

interface TransportLog {
  count: number;
  fixtureIds: string[];
  modelIds: string[];
}

function textFixture(id: string, ch: string, size: number): TokenBenchmarkFixture {
  return {
    id,
    category: "text",
    body: { messages: [{ role: "user", content: ch.repeat(size) }] },
  };
}

function localOf(fixture: TokenBenchmarkFixture): number {
  return estimateClaudeRequestTokens(materializeFixture(fixture), MODEL_ID);
}

function transportFor(
  resultsFor: Map<string, AuthoritativeCountResult>,
  log: TransportLog,
): AuthoritativeCountTransport {
  return (call: AuthoritativeCountCall) => {
    log.count += 1;
    log.fixtureIds.push(call.fixtureId);
    log.modelIds.push(call.modelId);
    const result = resultsFor.get(call.fixtureId);
    if (!result) throw new Error("missing fake transport result");
    return result;
  };
}

type RunRow = readonly [TokenBenchmarkFixture, AuthoritativeCountResult];

function run(rows: readonly RunRow[]): { log: TransportLog; report: TokenBenchmarkReport } {
  const log: TransportLog = { count: 0, fixtureIds: [], modelIds: [] };
  const map = new Map(rows.map(row => [row[0].id, row[1]] as const));
  const report = runTokenBenchmark(
    rows.map(row => row[0]),
    transportFor(map, log),
    { modelId: MODEL_ID, providerKind: PROVIDER_KIND },
  );
  return { log, report };
}

function supported(inputTokens: number): AuthoritativeCountResult {
  return { state: "supported", usage: { inputTokens } };
}

const FIRST = textFixture("z-first-tracer", "a", 40);
const SECOND = textFixture("a-second-tracer", "b", 40);

function byId(report: TokenBenchmarkReport, id: string) {
  return report.fixtures.find(row => row.id === id);
}

function runBenchmarkSet(fixtures: readonly TokenBenchmarkFixture[]): TokenBenchmarkReport {
  const log: TransportLog = { count: 0, fixtureIds: [], modelIds: [] };
  const map = new Map(fixtures.map(fx => [fx.id, supported(localOf(fx))] as const));
  return runTokenBenchmark(fixtures, transportFor(map, log), {
    modelId: MODEL_ID,
    providerKind: PROVIDER_KIND,
  });
}

function generatedBase64Slice(): string {
  const mixed = materializeFixture(
    defaultTokenBenchmarkFixtureSet.find(f => f.id === "mixed-envelope")!,
  );
  const content = (mixed.messages as Array<{ content: Array<{ source?: { data?: string } }> }>)[0].content;
  const base64 = content[1].source!.data!;
  return base64.slice(100, 140);
}

describe("04-01 offline token benchmark", () => {
  test("one local estimate and one injected transport call per fixture", () => {
    const localA = localOf(FIRST);
    const localB = localOf(SECOND);
    const { log, report } = run([
      [FIRST, supported(localA)],
      [SECOND, supported(localB)],
    ]);
    expect(log.count).toBe(2);
    expect(log.fixtureIds).toEqual(["a-second-tracer", "z-first-tracer"]);
    expect(log.modelIds.every(id => id === MODEL_ID)).toBe(true);
    expect(report.status).toBe("pass");
    expect(byId(report, "a-second-tracer")!.metrics!.localTokens).toBe(localB);
    expect(byId(report, "z-first-tracer")!.metrics!.localTokens).toBe(localA);
    expect(report.modelId).toBe(MODEL_ID);
    expect(report.providerKind).toBe(PROVIDER_KIND);
  });

  test("transport is never retried, not even after a failure", () => {
    const { log, report } = run([
      [FIRST, { state: "failed", error: new Error("SECRET-ERROR-SENTINEL-ABC") }],
    ]);
    expect(log.count).toBe(1);
    expect(report.fixtures.length).toBe(1);
    expect(report.fixtures[0].state).toBe("failed");
    expect(report.fixtures[0].failureReason).toBe("transport_failed");
    expect(report.status).toBe("incomplete");
  });

  test("32-token absolute tolerance holds at both limbs", () => {
    const absPass = textFixture("abs-pass", "a", 400);
    const localPass = localOf(absPass);
    expect(localPass - 33).toBeGreaterThanOrEqual(1);
    expect(localPass).toBeLessThanOrEqual(160);
    const passRun = run([[absPass, supported(localPass - 32)]]);
    expect(passRun.report.fixtures[0].state).toBe("supported");
    expect(passRun.report.fixtures[0].metrics!.passed).toBe(true);
    expect(passRun.report.fixtures[0].metrics!.absoluteError).toBe(32);
    expect(passRun.report.fixtures[0].metrics!.absoluteTolerance).toBe(32);
    // The run-level aggregate gate is separate: weighted error 32/76 > 0.10.
    expect(passRun.report.summary.allSupportedPassed).toBe(true);
    expect(passRun.report.status).toBe("incomplete");

    const absFail = textFixture("abs-fail", "a", 400);
    const localFail = localOf(absFail);
    const failRun = run([[absFail, supported(localFail - 33)]]);
    expect(failRun.report.fixtures[0].metrics!.absoluteError).toBe(33);
    expect(failRun.report.fixtures[0].metrics!.absoluteTolerance).toBe(32);
    expect(failRun.report.fixtures[0].metrics!.passed).toBe(false);
    expect(failRun.report.status).toBe("incomplete");
  });

  test("20 percent relative tolerance holds at both limbs", () => {
    const relPass = textFixture("rel-pass", "z", 609);
    const localPass = localOf(relPass);
    expect(localPass).toBeGreaterThanOrEqual(160);
    const k = Math.floor(localPass / 4);
    const passRun = run([[relPass, supported(localPass + k)]]);
    expect(passRun.report.fixtures[0].metrics!.passed).toBe(true);
    // The run-level aggregate gate is separate: weighted error 40/200 = 0.20.
    expect(passRun.report.summary.allSupportedPassed).toBe(true);
    expect(passRun.report.status).toBe("incomplete");

    const relFail = textFixture("rel-fail", "z", 609);
    const localFail = localOf(relFail);
    expect(localFail).toBeGreaterThanOrEqual(160);
    const kFail = Math.floor(localFail / 4);
    const failRun = run([[relFail, supported(localFail + kFail + 1)]]);
    expect(failRun.report.fixtures[0].metrics!.passed).toBe(false);
    expect(failRun.report.status).toBe("incomplete");
  });

  test("malformed, estimated, and cache usage are distinct unsupported outcomes", () => {
    const rows: RunRow[] = [
      [textFixture("u-zero", "a", 10), supported(0)],
      [textFixture("u-negative", "a", 10), supported(-5)],
      [textFixture("u-nan", "a", 10), supported(Number.NaN)],
      [textFixture("u-fractional", "a", 10), supported(12.5)],
      [textFixture("u-estimated", "a", 10), { state: "supported", usage: { inputTokens: 20, estimated: true } }],
      [textFixture("u-cached", "a", 10), { state: "supported", usage: { inputTokens: 20, cacheReadInputTokens: 10 } }],
    ];
    const { report } = run(rows);
    expect(report.summary.unsupportedCount).toBe(6);
    expect(byId(report, "u-zero")!.unsupportedReason).toBe("malformed_usage");
    expect(byId(report, "u-negative")!.unsupportedReason).toBe("malformed_usage");
    expect(byId(report, "u-nan")!.unsupportedReason).toBe("malformed_usage");
    expect(byId(report, "u-fractional")!.unsupportedReason).toBe("malformed_usage");
    expect(byId(report, "u-estimated")!.unsupportedReason).toBe("estimated_usage");
    expect(byId(report, "u-cached")!.unsupportedReason).toBe("cache_usage_present");
    expect(report.status).toBe("incomplete");
  });

  test("zero supported fixtures cannot pass the run", () => {
    const decline: AuthoritativeCountResult = { state: "unsupported" };
    const { report } = run([
      [textFixture("only-unsupported", "a", 40), decline],
    ]);
    expect(report.summary.supportedCount).toBe(0);
    expect(report.summary.allSupportedPassed).toBe(false);
    expect(report.summary.weightedErrorWithinLimit).toBe(false);
    expect(report.status).toBe("incomplete");
  });

  test("weighted absolute error boundary at 10 percent blocks an otherwise perfect run", () => {
    const baseline = textFixture("w-base", "y", 409);
    const drifting = textFixture("w-drift", "z", 1569);
    const baseLocal = 110;
    const driftLocal = 400;
    expect(localOf(baseline)).toBe(baseLocal);
    expect(localOf(drifting)).toBe(driftLocal);

    // 46 / 464 <= 0.10 while every fixture individually passes.
    const { report: passReport } = run([
      [baseline, supported(baseLocal)],
      [drifting, supported(driftLocal - 46)],
    ]);
    expect(passReport.summary.weightedErrorWithinLimit).toBe(true);
    expect(passReport.status).toBe("pass");

    // 47 / 463 > 0.10 -> incomplete despite all fixtures passing.
    const { report: failReport } = run([
      [baseline, supported(baseLocal)],
      [drifting, supported(driftLocal - 47)],
    ]);
    expect(failReport.summary.supportedCount).toBe(2);
    expect(failReport.summary.allSupportedPassed).toBe(true);
    expect(failReport.summary.weightedErrorWithinLimit).toBe(false);
    expect(failReport.status).toBe("incomplete");
  });

  test("failure after prior successes is incomplete and leaks no details", () => {
    const sentinelFixture = textFixture("z-secret-fixture", "a", 40);
    (sentinelFixture.body.messages as unknown as Array<Record<string, unknown>>)[0].content =
      "SECRET-FIXTURE-SENTINEL-XYZ";
    const ok1 = textFixture("a-ok-1", "a", 40);
    const ok2 = textFixture("b-ok-2", "a", 40);
    const { log, report } = run([
      [ok1, supported(localOf(ok1))],
      [ok2, supported(localOf(ok2))],
      [sentinelFixture, { state: "failed", error: new Error("SECRET-ERROR-SENTINEL-ABC") }],
    ]);
    expect(log.count).toBe(3);
    expect(report.summary.failedCount).toBe(1);
    expect(report.summary.supportedCount).toBe(2);
    expect(report.status).toBe("incomplete");
    const serialized = serializeBenchmarkReport(report);
    const human = formatBenchmarkReport(report);
    expect(serialized).not.toContain("SECRET-FIXTURE-SENTINEL-XYZ");
    expect(serialized).not.toContain("SECRET-ERROR-SENTINEL-ABC");
    expect(human).not.toContain("SECRET-FIXTURE-SENTINEL-XYZ");
    expect(human).not.toContain("SECRET-ERROR-SENTINEL-ABC");
  });

  test("unsupported detail text is never rendered", () => {
    const { report } = run([
      [textFixture("a-decline", "a", 40), { state: "unsupported", detail: "DETAIL-SENTINEL-QRS-789" }],
    ]);
    expect(byId(report, "a-decline")!.unsupportedReason).toBe("transport_declined");
    const serialized = serializeBenchmarkReport(report);
    const human = formatBenchmarkReport(report);
    expect(serialized).not.toContain("DETAIL-SENTINEL-QRS-789");
    expect(human).not.toContain("DETAIL-SENTINEL-QRS-789");
    expect(serialized).toContain("transport_declined");
  });

  test("default fixture set covers all eight categories in sorted order", () => {
    const ids = defaultTokenBenchmarkFixtureSet.map(f => f.id).sort();
    expect(ids).toEqual([
      "documents-pdf",
      "image-metadata",
      "mixed-envelope",
      "system-blocks",
      "text-tracer",
      "thinking-blocks",
      "tool-results",
      "tools-list",
    ]);
    expect(defaultTokenBenchmarkFixtureSet.length).toBe(8);
    const rows = defaultTokenBenchmarkFixtureSet.map(fx => [fx, supported(localOf(fx))] as const);
    const { report } = run(rows);
    expect(report.status).toBe("pass");
    expect(report.summary.weightedErrorWithinLimit).toBe(true);
    expect(report.fixtureSchemaVersion).toBe(TOKEN_BENCHMARK_FIXTURE_SCHEMA_VERSION);
  });

  test("serialized report DTO is a closed allowlist with digests", () => {
    const rows = defaultTokenBenchmarkFixtureSet.map(fx => [fx, supported(localOf(fx))] as const);
    const { report } = run(rows);
    const serialized = serializeBenchmarkReport(report);
    const human = formatBenchmarkReport(report);
    expect(serialized).not.toContain("__fixtureBase64");
    expect(human).not.toContain("__fixtureBase64");
    expect(serialized).not.toContain("\"body\"");
    expect(serialized).not.toContain("\"messages\"");
    expect(human).not.toContain("\"messages\"");

    const generatedSlice = generatedBase64Slice();
    expect(generatedSlice.length).toBe(40);
    expect(serialized).not.toContain(generatedSlice);
    expect(human).not.toContain(generatedSlice);

    const parsed = JSON.parse(serialized) as {
      fixtures: Array<{
        id: string;
        schemaVersion: number;
        digest: string;
        state: string;
        metrics?: Record<string, unknown>;
      }>;
    };
    expect(parsed.fixtures.length).toBe(8);
    for (const row of parsed.fixtures) {
      expect(Object.keys(row).sort()).toEqual([
        "digest",
        "id",
        "metrics",
        "schemaVersion",
        "state",
      ]);
      expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(row.metrics!).sort()).toEqual([
        "absoluteError",
        "absoluteTolerance",
        "authoritativeTokens",
        "localTokens",
        "passed",
        "relativeError",
        "signedError",
      ]);
    }
  });

  test("digests are stable across runs, repeats, and reversed input order", () => {
    const first = runBenchmarkSet(defaultTokenBenchmarkFixtureSet);
    const second = runBenchmarkSet(defaultTokenBenchmarkFixtureSet);
    const reversed = runBenchmarkSet([...defaultTokenBenchmarkFixtureSet].reverse());
    const firstJson = serializeBenchmarkReport(first);
    expect(serializeBenchmarkReport(second)).toBe(firstJson);
    expect(serializeBenchmarkReport(reversed)).toBe(firstJson);
    for (const fixture of defaultTokenBenchmarkFixtureSet) {
      const digest = canonicalFixtureDigest(materializeFixture(fixture));
      const fromFirst = first.fixtures.find(r => r.id === fixture.id)!.digest;
      const fromReversed = reversed.fixtures.find(r => r.id === fixture.id)!.digest;
      expect(fromFirst).toBe(digest);
      expect(fromReversed).toBe(digest);
    }
  });
});
