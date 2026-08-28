export interface AutonomousRemediationConfig {
  enabled: boolean;
  instanceId?: string;
  threshold: number;
  rollingWindowMs: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 86_400_000;

export function resolveAutonomousRemediationConfig(value: unknown): AutonomousRemediationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false, instanceId: undefined, threshold: DEFAULT_THRESHOLD, rollingWindowMs: DEFAULT_WINDOW_MS };
  }
  const input = value as Record<string, unknown>;
  const enabled = input.enabled === true;
  const instanceId = typeof input.instanceId === "string" && input.instanceId.trim() ? input.instanceId.trim() : undefined;
  const threshold = typeof input.threshold === "number" && Number.isInteger(input.threshold) && input.threshold > 0 ? input.threshold : DEFAULT_THRESHOLD;
  const rollingWindowMs = typeof input.rollingWindowMs === "number" && Number.isInteger(input.rollingWindowMs) && input.rollingWindowMs > 0 ? input.rollingWindowMs : DEFAULT_WINDOW_MS;
  return { enabled, instanceId, threshold, rollingWindowMs };
}
