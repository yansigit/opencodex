import type { TFn } from "../i18n/shared";
import { IconX } from "../icons";
import { formatProviderDisplayName } from "../provider-icons";
import type { LogAgentKind, LogFilterState, LogStatusFilter, LogTimeWindow } from "./logs-filter";

interface LogsFilterBarProps {
  filters: LogFilterState;
  options: { models: string[]; providers: string[] };
  hasActiveFilters: boolean;
  filteredCount: number;
  totalCount: number;
  t: TFn;
  onFilterChange: (next: LogFilterState) => void;
  onResetFilters: () => void;
}

export function LogsFilterBar({
  filters,
  options,
  hasActiveFilters,
  filteredCount,
  totalCount,
  t,
  onFilterChange,
  onResetFilters,
}: LogsFilterBarProps) {
  const currentSpeed =
    filters.maxTokPerSec === 15
      ? "slow"
      : filters.minTokPerSec === 15 && filters.maxTokPerSec === 50
        ? "medium"
        : filters.minTokPerSec === 50
          ? "fast"
          : "all";

  const handleSpeedChange = (value: string) => {
    if (value === "slow") {
      onFilterChange({ ...filters, minTokPerSec: undefined, maxTokPerSec: 15 });
    } else if (value === "medium") {
      onFilterChange({ ...filters, minTokPerSec: 15, maxTokPerSec: 50 });
    } else if (value === "fast") {
      onFilterChange({ ...filters, minTokPerSec: 50, maxTokPerSec: undefined });
    } else {
      onFilterChange({ ...filters, minTokPerSec: undefined, maxTokPerSec: undefined });
    }
  };

  return (
    <div className="logs-filter-container">
      <div className="logs-toolbar">
        <span className="muted text-control">{t("logs.filter.surface.label")}</span>
        <div
          className="segmented logs-segmented"
          role="radiogroup"
          aria-label={t("logs.filter.surface.label")}
        >
          {(["all", "claude", "codex", "grok"] as const).map(surface => (
            <button
              key={surface}
              type="button"
              role="radio"
              aria-checked={filters.surface === surface}
              className={`btn btn-sm${filters.surface === surface ? " btn-primary" : " btn-ghost"}`}
              style={{
                background: filters.surface === surface ? undefined : "transparent",
                color: filters.surface === surface ? undefined : "var(--muted)",
              }}
              onClick={() => onFilterChange({ ...filters, surface })}
            >
              {t(`logs.filter.surface.${surface}`)}
            </button>
          ))}
        </div>

        {/* Provider dropdown */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.provider.label")}
          <select
            className="input select-sm"
            value={filters.provider}
            aria-label={t("logs.filter.provider.label")}
            onChange={e => onFilterChange({ ...filters, provider: e.target.value })}
          >
            <option value="">{t("logs.filter.provider.all")}</option>
            {options.providers.map(p => (
              <option key={p} value={p}>
                {formatProviderDisplayName(p, t)}
              </option>
            ))}
          </select>
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.agent.label")}
          <select
            className="input select-sm"
            value={filters.agentKind}
            aria-label={t("logs.filter.agent.label")}
            onChange={e => onFilterChange({ ...filters, agentKind: e.target.value as LogAgentKind })}
          >
            <option value="all">{t("logs.filter.agent.all")}</option>
            <option value="main">{t("logs.filter.agent.main")}</option>
            <option value="subagent">{t("logs.filter.agent.subagent")}</option>
            <option value="internal">{t("logs.filter.agent.internal")}</option>
            <option value="unknown">{t("logs.filter.agent.unknown")}</option>
          </select>
        </label>

        {/* Model dropdown */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.model.label")}
          <select
            className="input select-sm"
            value={filters.model}
            aria-label={t("logs.filter.model.label")}
            onChange={e => onFilterChange({ ...filters, model: e.target.value })}
          >
            <option value="">{t("logs.filter.model.all")}</option>
            {options.models.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        {/* Time window dropdown */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.time.label")}
          <select
            className="input select-sm"
            value={filters.timeWindow}
            aria-label={t("logs.filter.time.label")}
            onChange={e =>
              onFilterChange({
                ...filters,
                timeWindow: e.target.value as LogTimeWindow,
              })
            }
          >
            <option value="all">{t("logs.filter.time.all")}</option>
            <option value="15m">{t("logs.filter.time.15m")}</option>
            <option value="1h">{t("logs.filter.time.1h")}</option>
            <option value="24h">{t("logs.filter.time.24h")}</option>
          </select>
        </label>

        {/* Token speed dropdown */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.speed.label")}
          <select
            className="input select-sm"
            value={currentSpeed}
            aria-label={t("logs.filter.speed.label")}
            onChange={e => handleSpeedChange(e.target.value)}
          >
            <option value="all">{t("logs.filter.speed.all")}</option>
            <option value="slow">{t("logs.filter.speed.slow")}</option>
            <option value="medium">{t("logs.filter.speed.medium")}</option>
            <option value="fast">{t("logs.filter.speed.fast")}</option>
          </select>
        </label>

        {/* Status dropdown */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.status.label")}
          <select
            className="input select-sm"
            value={filters.statusFilter}
            aria-label={t("logs.filter.status.label")}
            onChange={e =>
              onFilterChange({
                ...filters,
                statusFilter: e.target.value as LogStatusFilter,
              })
            }
          >
            <option value="all">{t("logs.filter.status.all")}</option>
            <option value="success">{t("logs.filter.status.success")}</option>
            <option value="errors">{t("logs.filter.status.errors")}</option>
          </select>
        </label>
      </div>

      <div className="logs-toolbar logs-toolbar-secondary">
        {/* Intercepted helpers */}
        <label className="muted text-control logs-filter-field">
          <input
            type="checkbox"
            checked={filters.interceptedHelpersOnly}
            onChange={e =>
              onFilterChange({
                ...filters,
                interceptedHelpersOnly: e.target.checked,
              })
            }
          />
          {t("logs.filter.interceptedHelpersOnly")}
        </label>

        {/* Conversation search */}
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.conversation.label")}
          <input
            type="search"
            className="input mono select-sm"
            value={filters.conversationId}
            onChange={e =>
              onFilterChange({ ...filters, conversationId: e.target.value })
            }
            placeholder={t("logs.filter.conversation.placeholder")}
            aria-label={t("logs.filter.conversation.label")}
          />
        </label>

        {/* Showing count and reset button */}
        {hasActiveFilters && (
          <div className="logs-filter-status">
            <span className="muted text-control">
              {t("logs.filter.showingCount", {
                count: filteredCount,
                total: totalCount,
              })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onResetFilters}
            >
              <IconX /> {t("logs.filter.reset")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
