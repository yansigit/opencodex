import type { CursorOracleProtocolObservation } from "./protocol-observer";

export type CursorOracleScenarioId = string;

export interface CursorOracleRunRequest {
  scenario: CursorOracleScenarioId;
  model?: string;
  agentBin?: string;
  keepRaw?: boolean;
  json?: boolean;
}

export interface CursorOracleEnvSummary {
  cursorAgentBin: string;
  cursorAgentResolved: boolean;
  nodeVersion?: string;
}

export interface CursorOracleObservationV1 {
  schemaVersion: 1;
  oracleRunId: string;
  oracle: "cursor";
  cliVersion: string | null;
  schemaFingerprint: string;
  protocolProfile: {
    status: "VERIFIED_PROTOCOL_PROFILE" | "DEGRADED_PROTOCOL_PROFILE";
    requestContextMode: CursorOracleProtocolObservation["requestContextMode"];
    runSseRequests: number;
    bidiAppendRequests: number;
    endpointCounts: Record<string, number>;
    observedClientVersions: string[];
    messages: CursorOracleProtocolObservation;
  };
  behavior: {
    instructionCanaryObserved: boolean;
  };
  scenario: CursorOracleScenarioId;
  model: string | null;
  startedAt: number;
  completedAt: number;
  outcome: "pass" | "fail" | "blocked" | "inconclusive";
  diagnostics: Array<{ code: string }>;
}

export interface CursorOracleRunResult {
  observation: CursorOracleObservationV1;
  rawPaths?: string[];
  rawDir?: string;
  rawTtlMs?: number;
  exitCode: number;
}
