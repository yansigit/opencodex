/**
 * ProviderCapacityQuota — per-provider quota bars plus the aggregation context the
 * quota API attaches for pooled Codex providers (estimate, excluded accounts, recovery
 * rows, current-account breakdown). Shared by the aggregate dashboard and the
 * single-provider Overview so both surfaces present the same capacity semantics.
 */
import { useT, useI18n } from "../../i18n/shared";
import {
  accountQuotaFromReport,
  capacityAggregationFromReport,
  type CapacityWindowView,
  type ProviderQuotaReportView,
} from "../../provider-workspace/report";
import { type QuotaWindowKey } from "../QuotaBars";
import QuotaBars from "../QuotaBars";

export function ProviderCapacityQuota({ report, pending }: { report: ProviderQuotaReportView; pending: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const aggregation = capacityAggregationFromReport(report);
  const primaryQuota = accountQuotaFromReport(report);
  const showsAggregate = aggregation?.presentation === "aggregate";
  const totalPoolAccounts = (aggregation?.includedAccounts ?? 0) + (aggregation?.excludedAccounts ?? 0);
  const isMultiAccountPool = Boolean(showsAggregate && totalPoolAccounts > 1);
  const displayQuota = (!isMultiAccountPool && aggregation?.currentAccount?.quota)
    ? aggregation.currentAccount.quota
    : primaryQuota;
  const displayPlan = !isMultiAccountPool ? aggregation?.currentAccount?.plan : undefined;
  const showsCurrentAccountBreakdown = Boolean(showsAggregate && isMultiAccountPool && aggregation?.currentAccount?.quota);
  const incompleteWindowKeys = new Set<QuotaWindowKey>();
  const incompleteCustomWindowLabels = new Set<string>();
  if (showsAggregate && isMultiAccountPool && aggregation) {
    if (aggregation.fiveHour?.incomplete) incompleteWindowKeys.add("fiveHour");
    if (aggregation.weekly?.incomplete) incompleteWindowKeys.add("weekly");
    if (aggregation.monthly?.incomplete) incompleteWindowKeys.add("monthly");
    for (const window of aggregation.customWindows ?? []) {
      if (window.incomplete) incompleteCustomWindowLabels.add(window.label);
    }
  }
  const recoveryRows: Array<{ key: number; label: string; window: CapacityWindowView }> = showsAggregate && isMultiAccountPool && aggregation ? [
    ...(aggregation.fiveHour ? [{ key: 0, label: t("codexAuth.fiveHour"), window: aggregation.fiveHour }] : []),
    ...(aggregation.weekly ? [{ key: 1, label: t("codexAuth.weekly"), window: aggregation.weekly }] : []),
    ...(aggregation.monthly ? [{ key: 2, label: t("codexAuth.monthly"), window: aggregation.monthly }] : []),
    ...(aggregation.customWindows ?? []).map((window, index) => ({ key: index + 3, label: window.label, window })),
  ] : [];
  const formatPercent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const formatRecoveryAt = (value: number) => new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value > 10_000_000_000 ? value : value * 1000));
  const activeRecoveryRows = recoveryRows.filter(
    r => r.window.nextRecoveryAt !== undefined && r.window.nextRecoveryPercent !== undefined,
  );
  const hasIncompleteWarning = Boolean(aggregation?.incomplete && aggregation.excludedAccounts > 0);
  const hasPartialWarning = Boolean(aggregation && aggregation.partialWindowAccounts > 0);
  const hasDetails = Boolean(
    aggregation && (
      activeRecoveryRows.length > 0
      || showsCurrentAccountBreakdown
      || hasIncompleteWarning
      || hasPartialWarning
    ),
  );

  return (
    <>
      {showsAggregate && isMultiAccountPool && <div className="pws-capacity-label">{t("pws.capacity.estimate")}</div>}
      {(displayQuota || pending) && (
        <QuotaBars
          quota={displayQuota}
          plan={displayPlan}
          threshold={80}
          t={t}
          layout="stacked"
          pending={pending}
          incompleteWindowKeys={showsAggregate && isMultiAccountPool ? incompleteWindowKeys : undefined}
          incompleteCustomWindowLabels={showsAggregate && isMultiAccountPool ? incompleteCustomWindowLabels : undefined}
        />
      )}
      {hasDetails && (
        <div className="pws-capacity-details">
          {activeRecoveryRows.map(({ key, label, window }) => (
            <div className="pws-capacity-recovery" key={key}>
              <span>{t("pws.capacity.nextRecovery")} · {label} · {formatRecoveryAt(window.nextRecoveryAt!)}</span>
              <strong>{t("pws.capacity.recoveryShare", { percent: formatPercent(window.nextRecoveryPercent!) })}</strong>
            </div>
          ))}
          {showsCurrentAccountBreakdown && aggregation?.currentAccount?.quota && (
            <div className="pws-capacity-current">
              <span className="pws-capacity-label">
                {t("pws.capacity.currentAccount")}
                {aggregation.currentAccount.plan ? ` · ${aggregation.currentAccount.plan}` : ""}
              </span>
              <QuotaBars quota={aggregation.currentAccount.quota} threshold={80} t={t} layout="stacked" />
            </div>
          )}
          {hasIncompleteWarning && aggregation && (
            <div className="pws-capacity-incomplete">
              {t("pws.capacity.incomplete", {
                excluded: aggregation.excludedAccounts,
                unknown: aggregation.unknownPlanAccounts,
              })}
            </div>
          )}
          {hasPartialWarning && aggregation && (
            <div className="pws-capacity-incomplete">
              {t("pws.capacity.partial", { count: aggregation.partialWindowAccounts })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
