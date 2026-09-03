import { afterEach, describe, expect, test } from "bun:test";
import {
  beginConversationTurn,
  clearConversationProgressForTests,
  CURSOR_429_STORM_COOLDOWN_MS,
  finishConversationTurn,
  observeTurnProgress,
} from "../src/server/conversation-progress";
import { normalizeUsageEntryForTest } from "../src/usage/log";

afterEach(clearConversationProgressForTests);

describe("conversation progress telemetry", () => {
  test("opens a bounded circuit after three consecutive logical 429s", () => {
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const turn = beginConversationTurn("conversation-a", "cursor", "grok-4.6", ordinal * 100);
      expect(turn.retryAfterSeconds).toBeUndefined();
      expect(turn.telemetry.logicalCallOrdinal).toBe(ordinal);
      finishConversationTurn(turn.key, turn.telemetry, 429, { now: ordinal * 100 });
    }

    const blocked = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 400);
    expect(blocked.telemetry.consecutive429sBeforeCall).toBe(3);
    expect(blocked.telemetry.rateLimitCircuitOpen).toBe(true);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    finishConversationTurn(blocked.key, blocked.telemetry, 429, { circuitBlocked: true, now: 400 });
    const stillBlocked = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 500);
    expect(stillBlocked.telemetry.consecutive429sBeforeCall).toBe(3);
  });

  test("isolates routes and resets on success or cooldown", () => {
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const failed = beginConversationTurn("conversation-a", "cursor", "k3", ordinal);
      finishConversationTurn(failed.key, failed.telemetry, 429, { now: ordinal });
    }
    expect(beginConversationTurn("conversation-b", "cursor", "k3", 4).retryAfterSeconds).toBeUndefined();
    expect(beginConversationTurn("conversation-a", "cursor", "grok-4.6", 4).retryAfterSeconds).toBeUndefined();
    expect(beginConversationTurn("conversation-a", "cursor", "k3", CURSOR_429_STORM_COOLDOWN_MS + 10).retryAfterSeconds).toBeUndefined();

    const failed = beginConversationTurn("conversation-c", "cursor", "k3", 100);
    finishConversationTurn(failed.key, failed.telemetry, 429, { now: 100 });
    const success = beginConversationTurn("conversation-c", "cursor", "k3", 101);
    finishConversationTurn(success.key, success.telemetry, 200, { now: 101 });
    expect(beginConversationTurn("conversation-c", "cursor", "k3", 102).telemetry.consecutive429sBeforeCall).toBe(0);
  });

  test("counts objective protocol progress and marks exact repeated output", () => {
    const first = beginConversationTurn("conversation-a", "cursor", "k3", 1);
    observeTurnProgress(first.telemetry, { type: "text_delta", text: "Checking the files." });
    observeTurnProgress(first.telemetry, { type: "tool_call_start", id: "1", name: "exec" });
    observeTurnProgress(first.telemetry, { type: "tool_call_end" });
    observeTurnProgress(first.telemetry, { type: "done" });
    finishConversationTurn(first.key, first.telemetry, 200, { now: 2 });
    expect(first.telemetry).toMatchObject({
      textDeltaCount: 1,
      textBytes: 19,
      toolCallsStarted: 1,
      toolCallsCompleted: 1,
      terminalEvents: 1,
      exactOutputRepeat: false,
    });

    const second = beginConversationTurn("conversation-a", "cursor", "k3", 3);
    expect(second.telemetry.logicalCallsSinceToolCompletion).toBe(1);
    observeTurnProgress(second.telemetry, { type: "text_delta", text: "Checking the files." });
    finishConversationTurn(second.key, second.telemetry, 200, { now: 4 });
    expect(second.telemetry.exactOutputRepeat).toBe(true);
  });

  test("flags punctuation-equivalent commentary without suppressing it", () => {
    const first = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 1);
    observeTurnProgress(first.telemetry, {
      type: "text_delta",
      text: "I’ll inspect the logs now.",
      phase: "commentary",
    });
    finishConversationTurn(first.key, first.telemetry, 200, { now: 2 });
    expect(first.telemetry.commentaryOnlyRound).toBe(true);

    const second = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 3);
    observeTurnProgress(second.telemetry, {
      type: "text_delta",
      text: "I’ll inspect the logs now!",
      phase: "commentary",
    });
    finishConversationTurn(second.key, second.telemetry, 200, { now: 4 });
    expect(second.telemetry.normalizedCommentaryRepeat).toBe(true);
    expect(second.telemetry.commentaryOnlyRound).toBe(true);
  });

  test("durable normalization keeps counters but drops malformed telemetry", () => {
    const base = {
      requestId: "ocx-progress",
      timestamp: 1,
      provider: "cursor",
      model: "k3",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported" as const,
    };
    const telemetry = beginConversationTurn("conversation-a", "cursor", "k3", 1).telemetry;
    expect(normalizeUsageEntryForTest({ ...base, turnProgress: telemetry }).turnProgress).toEqual(telemetry);
    expect(normalizeUsageEntryForTest({
      ...base,
      turnProgress: { ...telemetry, textBytes: -1 },
    }).turnProgress).toBeUndefined();
  });
});
