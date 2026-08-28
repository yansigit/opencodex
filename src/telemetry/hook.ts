import { resolveAutonomousRemediationConfig, type AutonomousRemediationConfig } from "../config/autonomous-remediation";
import { TelemetryLedger } from "./ledger";
import type { LedgerRecord } from "./types";

export type RuntimeFailureCategory = "websocket_1006" | "tool_repetition_loop" | "upstream_wire_error";

export interface RuntimeFailureContext {
  category?: RuntimeFailureCategory;
  provider?: string;
  model?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: number;
  config?: AutonomousRemediationConfig | unknown;
  ledger?: TelemetryLedger;
}

let defaultLedger: TelemetryLedger | undefined;

function categoryFor(error: unknown, requested?: RuntimeFailureCategory): RuntimeFailureCategory {
  if (requested) return requested;
  const message = error instanceof Error ? error.message : String(error);
  if (/1006|abnormal closure|websocket/i.test(message)) return "websocket_1006";
  if (/tool.{0,32}(repeat|loop)|(?:repeat|loop).{0,32}tool/i.test(message)) return "tool_repetition_loop";
  return "upstream_wire_error";
}

export function interceptRuntimeFailure(error: unknown, context: RuntimeFailureContext = {}): LedgerRecord | null {
  const config = resolveAutonomousRemediationConfig(context.config);
  if (!config.enabled) return null;
  const ledger = context.ledger ?? (defaultLedger ??= new TelemetryLedger());
  const category = categoryFor(error, context.category);
  const signature = error instanceof Error ? error.message : String(error);
  return ledger.recordFailure({
    failureKind: category,
    signature,
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.model ? { model: context.model } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.timestamp !== undefined ? { timestamp: context.timestamp } : {}),
  }, config.rollingWindowMs);
}
