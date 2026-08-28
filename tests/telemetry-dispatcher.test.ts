import { describe, expect, test } from "bun:test";
import { dispatchAutonomousFix, type GhCommandRunner } from "../src/telemetry/dispatcher";
import type { LedgerRecord } from "../src/telemetry/types";

const record: LedgerRecord = {
  fingerprint: "abc123",
  firstSeen: 100,
  lastSeen: 200,
  count: 3,
  status: "monitoring",
  details: { failureKind: "upstream_error", provider: "openai", model: "gpt-5" },
};

function runner(outputs: string[] = []): { calls: string[][]; run: GhCommandRunner } {
  const calls: string[][] = [];
  return { calls, run: async args => { calls.push([...args]); return outputs.shift() ?? ""; } };
}

describe("dispatchAutonomousFix", () => {
  test("is an immediate no-op when disabled or instance is missing", async () => {
    const first = runner();
    expect(await dispatchAutonomousFix(record, {}, first.run)).toEqual({ status: "skipped", reason: "unauthorized" });
    expect(first.calls).toEqual([]);

    const second = runner();
    expect(await dispatchAutonomousFix(record, { autonomousRemediation: { enabled: true } }, second.run)).toEqual({ status: "skipped", reason: "unauthorized" });
    expect(second.calls).toEqual([]);
  });

  test("searches open issues and links an existing match", async () => {
    const command = runner(["42\tExisting issue"]);
    const result = await dispatchAutonomousFix(record, { autonomousRemediation: { enabled: true, instanceId: "local-1" } }, command.run);
    expect(result).toMatchObject({ status: "dispatched", issueNumber: 42, existing: true });
    expect(command.calls).toEqual([["issue", "list", "--repo", "yansigit/opencodex", "--state", "open", "--search", "fingerprint:abc123"]]);
  });

  test("creates a labeled issue with machine-readable telemetry metadata", async () => {
    const command = runner(["", "https://github.com/yansigit/opencodex/issues/43"]);
    const result = await dispatchAutonomousFix(record, { autonomousRemediation: { enabled: true, instanceId: "local-1" } }, command.run);
    expect(result).toMatchObject({ status: "dispatched", existing: false });
    expect(command.calls[1]?.slice(0, 5)).toEqual(["issue", "create", "--repo", "yansigit/opencodex", "--title"]);
    expect(command.calls[1]).toContain("agent:jules,autonomous-fix,instance:verified");
    const body = command.calls[1]?.[command.calls[1].indexOf("--body") + 1] ?? "";
    expect(body).toContain("<!-- opencodex-failure-telemetry");
    expect(body).toContain('"fingerprint":"abc123"');
    expect(body).toContain('"instanceId":"local-1"');
  });
});
