import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryLedger } from "../src/telemetry/ledger";
import type { FailureEvent } from "../src/telemetry/types";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }); });

describe("TelemetryLedger", () => {
  test("counts only failures in the rolling window and tracks status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-telemetry-"));
    paths.push(dir);
    const ledger = new TelemetryLedger(join(dir, "telemetry.sqlite"));
    const event: FailureEvent = { failureKind: "upstream_wire_error", provider: "openai", model: "gpt-5", signature: "broken", timestamp: 1000 };
    const fingerprint = ledger.recordFailure(event, 1000).fingerprint;
    ledger.recordFailure({ ...event, timestamp: 1500 }, 1000);
    ledger.recordFailure({ ...event, timestamp: 2600 }, 1000);
    expect(ledger.getRecord(fingerprint)?.count).toBe(1);
    expect(ledger.shouldDispatch(fingerprint, 2, 1000)).toBe(false);
    ledger.recordFailure({ ...event, timestamp: 3000 }, 1000);
    expect(ledger.shouldDispatch(fingerprint, 2, 1000)).toBe(true);
    ledger.updateStatus(fingerprint, "dispatched", { issueNumber: 7 });
    expect(ledger.getRecord(fingerprint)).toMatchObject({ status: "dispatched", details: { issueNumber: 7 } });
    ledger.close();
  });
});
