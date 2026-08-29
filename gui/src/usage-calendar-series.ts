export interface CalendarSeriesDay {
  date: string;
  requests: number;
  totalTokens: number;
}

function isoDate(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Last `length` local calendar days, oldest first, with missing API rows filled with zeroes. */
export function buildCalendarSeries(
  days: readonly CalendarSeriesDay[] | undefined,
  length: number,
  end = new Date(),
): CalendarSeriesDay[] {
  if (length <= 0 || !Number.isFinite(end.getTime())) return [];
  const byDate = new Map(days?.map(day => [day.date, day]));
  const cursor = new Date(end);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - length + 1);

  return Array.from({ length }, () => {
    const date = isoDate(cursor);
    const row = byDate.get(date);
    cursor.setDate(cursor.getDate() + 1);
    return { date, requests: row?.requests ?? 0, totalTokens: row?.totalTokens ?? 0 };
  });
}

function sparklinePoint(values: readonly number[], index: number, width: number, height: number): [number, number] {
  if (values.length === 1) return [width / 2, height / 2];
  const clean = values.map(value => Number.isFinite(value) ? Math.max(0, value) : 0);
  const max = Math.max(0, ...clean);
  const x = index * width / (values.length - 1);
  const y = max === 0 ? height / 2 : height - (clean[index]! / max) * height;
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

/** SVG polyline coordinates that stay finite for empty, single-point, and zero-only data. */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  return values.map((_, index) => sparklinePoint(values, index, width, height).join(",")).join(" ");
}

export function selectedSparklinePoint(
  values: readonly number[],
  index: number,
  width: number,
  height: number,
): [number, number] | null {
  if (index < 0 || index >= values.length) return null;
  return sparklinePoint(values, index, width, height);
}

export function formatCalendarDate(date: string, locale: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed)
    : date;
}
