import { afterEach, describe, expect, test } from "bun:test";
import {
  beginConversationTurn,
  clearConversationProgressForTests,
  CURSOR_429_STORM_COOLDOWN_MS,
  CURSOR_REPEATED_TOOL_OUTPUT_THRESHOLD,
  finishConversationTurn,
  guardRepeatedPreToolText,
  MAX_PRE_TOOL_TEXT_GUARD_BYTES,
  observeTurnProgress,
} from "../../src/server/conversation-progress";
import type { AdapterEvent } from "../../src/types";
import { normalizeUsageEntryForTest } from "../../src/usage/log";

afterEach(clearConversationProgressForTests);

async function guarded(events: AdapterEvent[], turn: ReturnType<typeof beginConversationTurn>): Promise<AdapterEvent[]> {
  const output: AdapterEvent[] = [];
  for await (const event of guardRepeatedPreToolText(
    (async function* () {
      for (const event of events) {
        observeTurnProgress(turn.telemetry, event);
        yield event;
      }
    })(),
    turn.key,
    turn.telemetry,
  )) output.push(event);
  return output;
}

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

  test("interrupts a repeated tool-bearing output loop once, then permits a deliberate retry", () => {
    for (let ordinal = 1; ordinal <= CURSOR_REPEATED_TOOL_OUTPUT_THRESHOLD + 1; ordinal++) {
      const turn = beginConversationTurn("conversation-a", "cursor", "composer-2.5", ordinal);
      expect(turn.telemetry.repetitionCircuitOpen).toBeUndefined();
      observeTurnProgress(turn.telemetry, { type: "text_delta", text: "I will inspect it." });
      observeTurnProgress(turn.telemetry, { type: "tool_call_start", id: `call-${ordinal}`, name: "exec" });
      observeTurnProgress(turn.telemetry, { type: "tool_call_delta", arguments: '{"cmd":"pwd"}' });
      observeTurnProgress(turn.telemetry, { type: "tool_call_end" });
      finishConversationTurn(turn.key, turn.telemetry, 200, { now: ordinal });
    }

    const blocked = beginConversationTurn("conversation-a", "cursor", "composer-2.5", 10);
    expect(blocked.telemetry.repetitionCircuitOpen).toBe(true);
    finishConversationTurn(blocked.key, blocked.telemetry, 502, { now: 10 });
    expect(beginConversationTurn("conversation-a", "cursor", "composer-2.5", 11).telemetry.repetitionCircuitOpen)
      .toBeUndefined();
  });

  test("does not treat different tool arguments as an exact repeated output", () => {
    for (let ordinal = 1; ordinal <= CURSOR_REPEATED_TOOL_OUTPUT_THRESHOLD + 2; ordinal++) {
      const turn = beginConversationTurn("conversation-a", "cursor", "composer-2.5", ordinal);
      expect(turn.telemetry.repetitionCircuitOpen).toBeUndefined();
      observeTurnProgress(turn.telemetry, { type: "text_delta", text: "I will inspect it." });
      observeTurnProgress(turn.telemetry, { type: "tool_call_start", id: `call-${ordinal}`, name: "exec" });
      observeTurnProgress(turn.telemetry, { type: "tool_call_delta", arguments: JSON.stringify({ cmd: `sed -n '${ordinal}p' file` }) });
      observeTurnProgress(turn.telemetry, { type: "tool_call_end" });
      finishConversationTurn(turn.key, turn.telemetry, 200, { now: ordinal });
    }
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

  test("suppresses only repeated normalized pre-tool narration", async () => {
    const events = (text: string): AdapterEvent[] => [
      { type: "text_delta", text },
      { type: "tool_call_start", id: "call", name: "read_workflow" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const first = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 1);
    const firstNarration = "I’ll call the workflow reader, then give a one-sentence summary.";
    expect(await guarded(events(firstNarration), first)).toEqual(events(firstNarration));
    expect(first.telemetry.preToolTextBytes).toBeGreaterThan(0);
    expect(first.telemetry.normalizedPreToolTextRepeat).toBe(false);

    const second = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 2);
    expect((await guarded(events("I’ll read that workflow now!"), second)).map(event => event.type))
      .toEqual(["tool_call_start", "tool_call_end", "done"]);
    expect(second.telemetry.normalizedPreToolTextRepeat).toBe(false);
    expect(second.telemetry.repeatedPreToolNarration).toBe(true);
    expect(second.telemetry.suppressedRepeatedPreToolText).toBe(true);

    const third = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 3);
    const materiallyDifferent = events("Let me run the destructive migration script.");
    expect(await guarded(materiallyDifferent, third)).toEqual(materiallyDifferent);
    expect(third.telemetry.repeatedPreToolNarration).toBe(false);

    const fourth = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 4);
    const unique: AdapterEvent[] = [
      { type: "text_delta", text: "Safety note: this reads a different workflow." },
      { type: "tool_call_start", id: "call", name: "read_workflow" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    expect(await guarded(unique, fourth)).toEqual(unique);
    expect(fourth.telemetry.normalizedPreToolTextRepeat).toBeUndefined();

    const fifth = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 5);
    const sixth = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 6);
    expect(fifth.telemetry.logicalCallOrdinal).toBe(5);
    expect(sixth.telemetry.logicalCallOrdinal).toBe(6);
    const staleRepeat = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 7);
    expect(await guarded(events("Let me run the destructive migration script."), staleRepeat))
      .toEqual(events("Let me run the destructive migration script."));
    expect(staleRepeat.telemetry.suppressedRepeatedPreToolText).toBeUndefined();
  });

  test("flushes text-only and over-limit output unchanged", async () => {
    const answer = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 1);
    const textOnly: AdapterEvent[] = [{ type: "text_delta", text: "ordinary answer" }, { type: "done" }];
    expect(await guarded(textOnly, answer)).toEqual(textOnly);
    finishConversationTurn(answer.key, answer.telemetry, 200);
    expect(answer.telemetry.preToolTextBytes).toBe(0);

    const large = beginConversationTurn("conversation-a", "cursor", "grok-4.6", 2);
    const largeText = "x".repeat(MAX_PRE_TOOL_TEXT_GUARD_BYTES + 1);
    const largeEvents: AdapterEvent[] = [
      { type: "text_delta", text: largeText },
      { type: "tool_call_start", id: "call", name: "probe" },
    ];
    expect(await guarded(largeEvents, large)).toEqual(largeEvents);
    expect(large.telemetry.suppressedRepeatedPreToolText).toBeUndefined();
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
    const { preToolTextBytes: _legacyMissing, ...legacyTelemetry } = telemetry;
    expect(normalizeUsageEntryForTest({ ...base, turnProgress: legacyTelemetry }).turnProgress?.preToolTextBytes)
      .toBe(0);
    expect(normalizeUsageEntryForTest({
      ...base,
      turnProgress: { ...telemetry, textBytes: -1 },
    }).turnProgress).toBeUndefined();
  });
});
