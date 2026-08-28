import { afterEach, describe, expect, test } from "bun:test";
import { resolveAutonomousRemediationConfig } from "../src/config/autonomous-remediation";
import { interceptRuntimeFailure } from "../src/telemetry/hook";
import { TelemetryLedger } from "../src/telemetry/ledger";

const ledgers: TelemetryLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });

describe("autonomous remediation configuration", () => {
  test("parses valid settings and safely defaults malformed settings", () => {
    expect(resolveAutonomousRemediationConfig({ enabled: true, instanceId: "host-a", threshold: 3, rollingWindowMs: 120000 }))
      .toEqual({ enabled: true, instanceId: "host-a", threshold: 3, rollingWindowMs: 120000 });
    expect(resolveAutonomousRemediationConfig({ enabled: "yes", threshold: 0 })).toEqual({
      enabled: false, instanceId: undefined, threshold: 3, rollingWindowMs: 86_400_000,
    });
  });
});

describe("interceptRuntimeFailure", () => {
  test("records a websocket 1006 failure without requiring a stream change", () => {
    const ledger = new TelemetryLedger(":memory:");
    ledgers.push(ledger);
    const result = interceptRuntimeFailure(new Error("socket closed"), {
      category: "websocket_1006", provider: "openai", model: "gpt-5", timestamp: 1000,
      config: { enabled: true, instanceId: "host-a", threshold: 2, rollingWindowMs: 10000 }, ledger,
    });
    expect(result?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.getRecord(result!.fingerprint)?.count).toBe(1);
  });

  test("classifies repetition and wire failures and ignores disabled telemetry", () => {
    const ledger = new TelemetryLedger(":memory:");
    ledgers.push(ledger);
    expect(interceptRuntimeFailure(new Error("tool call repeated"), { category: "tool_repetition_loop", ledger })).toBeNull();
    expect(interceptRuntimeFailure(new Error("wire reset"), { category: "upstream_wire_error", ledger, config: { enabled: true } })).not.toBeNull();
  });
});
