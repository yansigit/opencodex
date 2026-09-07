import { describe, expect, test } from "bun:test";

import { childStartupMarkerMs } from "../helpers/ci-watchdog";

describe("fresh child startup marker budget", () => {
  test("keeps local runs at the requested budget", () => {
    expect(childStartupMarkerMs(10_000, false, "win32")).toBe(10_000);
  });

  test("gives Windows CI a distinct cold-start floor", () => {
    expect(childStartupMarkerMs(10_000, true, "win32")).toBe(75_000);
    expect(childStartupMarkerMs(90_000, true, "win32")).toBe(90_000);
  });

  test("preserves the existing non-Windows CI floor", () => {
    expect(childStartupMarkerMs(10_000, true, "linux")).toBe(30_000);
    expect(childStartupMarkerMs(10_000, true, "darwin")).toBe(30_000);
  });
});
