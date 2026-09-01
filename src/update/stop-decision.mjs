import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "./stop-contract.mjs";

/** Decide whether an updater may replace files after the proxy stop attempt. */
export function decidePostStopUpdate({ status, hasRuntimeState, liveness, teardownOutstanding = false }) {
  const historyOnly = status === STOP_HISTORY_INCOMPLETE_EXIT_CODE;
  if (status !== 0 && !historyOnly) return { proceed: false, reason: "stop-failed" };
  if (hasRuntimeState) return { proceed: false, reason: "runtime-state" };
  if (teardownOutstanding) return { proceed: false, reason: "teardown-outstanding" };
  if (liveness === "live") return { proceed: false, reason: "proxy-live" };
  if (liveness !== "dead") return { proceed: false, reason: "proxy-unknown" };
  return { proceed: true, reason: historyOnly ? "history-only" : "ok" };
}
