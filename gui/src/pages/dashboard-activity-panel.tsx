import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { formatTokens } from "../format-tokens";
import { navigateHash } from "../hash-routing";
import type { Locale, TFn } from "../i18n/shared";
import {
  buildCalendarSeries,
  formatCalendarDate,
  selectedSparklinePoint,
  sparklinePoints,
  type CalendarSeriesDay,
} from "../usage-calendar-series";

const WIDTH = 240;
const HEIGHT = 32;

function Sparkline({
  className,
  days,
  values,
  selected,
  onSelect,
}: {
  className: string;
  days: CalendarSeriesDay[];
  values: number[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const point = selectedSparklinePoint(values, selected, WIDTH, HEIGHT);
  const hitWidth = WIDTH / Math.max(1, days.length);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline className={className} points={sparklinePoints(values, WIDTH, HEIGHT)} />
      {point && <circle className="dash-activity-marker" cx={point[0]} cy={point[1]} r="2.5" />}
      {days.map((day, index) => (
        <rect
          key={day.date}
          data-activity-date={day.date}
          x={index * hitWidth}
          y={0}
          width={hitWidth}
          height={HEIGHT}
          fill="transparent"
          onPointerEnter={() => onSelect(index)}
          onPointerDown={() => onSelect(index)}
        />
      ))}
    </svg>
  );
}

export function DashboardActivityPanel({
  days,
  locale,
  t,
}: {
  days?: readonly CalendarSeriesDay[];
  locale: Locale;
  t: TFn;
}) {
  const series = useMemo(() => buildCalendarSeries(days, 30), [days]);
  const [selected, setSelected] = useState(series.length - 1);
  const selectedIndex = Math.max(0, Math.min(selected, series.length - 1));
  const day = series[selectedIndex]!;
  const detailId = useId();
  const detail = t("usage.chart.dayDetail", {
    date: formatCalendarDate(day.date, locale),
    requests: day.requests,
    tokens: formatTokens(day.totalTokens, locale),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    if (event.key === "ArrowLeft") next = Math.max(0, selectedIndex - 1);
    else if (event.key === "ArrowRight") next = Math.min(series.length - 1, selectedIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = series.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
  };

  return (
    <section className="panel dash-activity-panel" aria-labelledby="dash-activity-title">
      <div className="panel-head">
        <h3 id="dash-activity-title" className="panel-title">{t("dash.activity.title")}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash("usage")}>
          {t("dash.activity.viewUsage")}
        </button>
      </div>
      <div
        className="dash-activity-plot"
        role="group"
        tabIndex={0}
        aria-label={t("dash.activity.chartLabel")}
        aria-describedby={detailId}
        onKeyDown={onKeyDown}
      >
        <div className="dash-activity-row">
          <span>{t("dash.activity.requests")}</span>
          <Sparkline className="dash-activity-requests" days={series} values={series.map(item => item.requests)} selected={selectedIndex} onSelect={setSelected} />
        </div>
        <div className="dash-activity-row">
          <span>{t("dash.activity.tokens")}</span>
          <Sparkline className="dash-activity-tokens" days={series} values={series.map(item => item.totalTokens)} selected={selectedIndex} onSelect={setSelected} />
        </div>
      </div>
      <output id={detailId} className="dash-activity-detail" aria-live="polite">{detail}</output>
    </section>
  );
}
