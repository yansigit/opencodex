import { expect, test } from "bun:test";

test("calendar series zero-fills sparse days without invalid sparkline coordinates", async () => {
  const calendar = await import("../src/usage-calendar-series").catch(() => null);
  expect(calendar).not.toBeNull();

  const rows = calendar!.buildCalendarSeries(
    [
      { date: "2026-08-25", requests: 2, totalTokens: 50 },
      { date: "2026-08-27", requests: 4, totalTokens: 100 },
    ],
    4,
    new Date(2026, 7, 28),
  );

  expect(rows).toEqual([
    { date: "2026-08-25", requests: 2, totalTokens: 50 },
    { date: "2026-08-26", requests: 0, totalTokens: 0 },
    { date: "2026-08-27", requests: 4, totalTokens: 100 },
    { date: "2026-08-28", requests: 0, totalTokens: 0 },
  ]);

  for (const values of [[], [0], [9], [0, 0, 0], [0, 4, 0, 9]]) {
    const points = calendar!.sparklinePoints(values, 120, 32);
    expect(points).not.toMatch(/NaN|Infinity/);
  }
  expect(calendar!.sparklinePoints([], 120, 32)).toBe("");
  expect(calendar!.sparklinePoints([9], 120, 32)).toBe("60,16");
});
