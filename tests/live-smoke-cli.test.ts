import { describe, expect, test } from "bun:test";
import { smokeExitCode } from "../scripts/live-smoke";

describe("live smoke CLI result handling", () => {
  test("fails CI only when a provider inference run fails", () => {
    expect(smokeExitCode([{ status: "passed" }])).toBe(0);
    expect(smokeExitCode([{ status: "skipped" }])).toBe(0);
    expect(smokeExitCode([{ status: "failed" }])).toBe(1);
  });
});
