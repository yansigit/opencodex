/** Privacy-safe, protocol-level evidence for one client-initiated model call. */
export interface TurnProgressTelemetry {
  logicalCallOrdinal: number;
  consecutive429sBeforeCall: number;
  logicalCallsSinceToolCompletion: number;
  textDeltaCount: number;
  textBytes: number;
  commentaryTextBytes: number;
  finalTextBytes: number;
  /** Model text emitted before the first tool call, regardless of phase labeling. */
  preToolTextBytes: number;
  thinkingDeltaCount: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  assistantBoundaries: number;
  terminalEvents: number;
  exactOutputRepeat?: boolean;
  normalizedCommentaryRepeat?: boolean;
  normalizedPreToolTextRepeat?: boolean;
  repeatedPreToolNarration?: boolean;
  suppressedRepeatedPreToolText?: boolean;
  commentaryOnlyRound?: boolean;
  emptyProtocolRound?: boolean;
  rateLimitCircuitOpen?: boolean;
}
