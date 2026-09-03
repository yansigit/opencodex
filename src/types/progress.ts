/** Privacy-safe, protocol-level evidence for one client-initiated model call. */
export interface TurnProgressTelemetry {
  logicalCallOrdinal: number;
  consecutive429sBeforeCall: number;
  logicalCallsSinceToolCompletion: number;
  textDeltaCount: number;
  textBytes: number;
  commentaryTextBytes: number;
  finalTextBytes: number;
  thinkingDeltaCount: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  assistantBoundaries: number;
  terminalEvents: number;
  exactOutputRepeat?: boolean;
  normalizedCommentaryRepeat?: boolean;
  commentaryOnlyRound?: boolean;
  emptyProtocolRound?: boolean;
  rateLimitCircuitOpen?: boolean;
}
