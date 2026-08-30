import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { createCursorAdapter as createCursorAdapterProduction } from "../src/adapters/cursor";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
  getCursorCheckpoint,
} from "../src/adapters/cursor/checkpoint-store";
import { ConversationStateStructureSchema } from "../src/adapters/cursor/gen/agent_pb";
import {
  createCursorRequest,
  cursorCoveredPrefixDigest,
  cursorInstructionDigest,
} from "../src/adapters/cursor/request-builder";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorServerMessage } from "../src/adapters/cursor/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
};

const base: OcxParsedRequest = {
  modelId: "cursor/gpt-5.6-sol",
  context: { messages: [] },
  stream: false,
  options: {},
};

function checkpointBytes(marker: string): Uint8Array {
  return toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
    pendingToolCalls: [marker],
  }));
}

function buildParsed(messages: OcxMessage[]): OcxParsedRequest {
  return {
    ...base,
    _clientThreadId: "thread-continuation-durability",
    _cursorIdentityScope: "acct-continuation",
    context: { messages },
  };
}

function commitForParsed(parsed: OcxParsedRequest, conversationId: string, marker: string): string {
  const coveredMessageCount = parsed.context.messages.length;
  const ref = commitCursorCheckpoint({
    conversationId,
    identityScope: parsed._cursorIdentityScope,
    modelId: "gpt-5.6-sol",
    checkpointBytes: checkpointBytes(marker),
    coveredMessageCount,
    prefixDigest: cursorCoveredPrefixDigest(parsed, coveredMessageCount),
    systemDigest: cursorInstructionDigest(parsed),
  });
  if (!ref) throw new Error("failed to commit checkpoint for " + marker);
  return ref;
}

describe("Cursor continuation durability", () => {
  test("preserves conversation and checkpoint identity across 12 continuation rounds, then invalidates on drift", () => {
    clearCursorCheckpointsForTests();
    const rounds = 12;
    let messages: OcxMessage[] = [{ role: "user", content: "round-0", timestamp: 1 }];
    let parsed = buildParsed(messages);
    let request = createCursorRequest(parsed);
    const conversationId = request.conversationId;
    expect(conversationId.startsWith("cursor_")).toBe(true);
    expect(request.continuationMode).toBe("full-replay");

    let checkpointRef = commitForParsed(parsed, conversationId, "round-0");
    for (let round = 1; round <= rounds; round++) {
      messages = [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: "reply-" + (round - 1) }], timestamp: round * 2 },
        { role: "user", content: "round-" + round, timestamp: round * 2 + 1 },
      ];
      parsed = buildParsed(messages);
      request = createCursorRequest({
        ...parsed,
        _cursorConversationId: conversationId,
        _providerContinuation: {
          cursor: { conversationId, checkpointUsable: true, checkpointRef },
        },
      });
      expect(request.conversationId).toBe(conversationId);
      expect(request.continuationMode).toBe("checkpoint");
      expect(request.checkpointBytes).toEqual(getCursorCheckpoint(checkpointRef)?.checkpointBytes);
      checkpointRef = commitForParsed(parsed, conversationId, "round-" + round);
    }

    const stableParsed = buildParsed(messages);
    const identityChanged = createCursorRequest({
      ...stableParsed,
      _cursorConversationId: conversationId,
      _cursorIdentityScope: "acct-other",
      _providerContinuation: {
        cursor: { conversationId, checkpointUsable: true, checkpointRef },
      },
    });
    expect(identityChanged.continuationMode).toBe("full-replay");
    expect(identityChanged.checkpointInvalidationReason).toBe("identity_changed");

    const conversationChanged = createCursorRequest({
      ...stableParsed,
      _cursorConversationId: "cursor_other",
      _providerContinuation: {
        cursor: { conversationId, checkpointUsable: true, checkpointRef },
      },
    });
    expect(conversationChanged.continuationMode).toBe("full-replay");
    expect(conversationChanged.checkpointInvalidationReason).toBe("conversation_changed");

    const branchedMessages: OcxMessage[] = [
      ...messages.slice(0, -1),
      { role: "user", content: "different branch", timestamp: 999 },
    ];
    const lineageMismatch = createCursorRequest({
      ...buildParsed(branchedMessages),
      _cursorConversationId: conversationId,
      _providerContinuation: {
        cursor: { conversationId, checkpointUsable: true, checkpointRef },
      },
    });
    expect(lineageMismatch.continuationMode).toBe("full-replay");
    expect(lineageMismatch.checkpointInvalidationReason).toBe("lineage_mismatch");
    clearCursorCheckpointsForTests();
  });

  test("keeps an interrupted stream checkpoint for same-conversation resume", async () => {
    clearCursorCheckpointsForTests();
    const captured = checkpointBytes("interrupted-resume");
    let attempts = 0;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          if (attempts === 1) {
            yield { type: "text", text: "partial" } satisfies CursorServerMessage;
            yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
            return;
          }
          if (attempts === 2) {
            throw new Error("Cursor upstream error: stream interrupted before completion");
          }
          yield { type: "done", usage: { inputTokens: 2, outputTokens: 1 } } satisfies CursorServerMessage;
        },
        writeClient() {},
        capturedConversationCheckpoint() {
          return attempts === 1 ? captured : undefined;
        },
      }),
    });

    const body: OcxParsedRequest = {
      ...base,
      context: { messages: [{ role: "user", content: "start", timestamp: 1 }] },
      _cursorConversationId: "cursor_interrupt_resume",
      _cursorIdentityScope: "acct-interrupt",
    };
    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => firstEvents.push(event));
    const firstDone = firstEvents.find(event => event.type === "done");
    expect(firstDone?.type).toBe("done");
    const checkpointRef = firstDone && firstDone.type === "done"
      ? firstDone.providerState?.cursor?.checkpointRef
      : undefined;
    expect(checkpointRef).toBeDefined();
    expect(getCursorCheckpoint(checkpointRef)?.conversationId).toBe("cursor_interrupt_resume");
    expect(body._providerContinuation?.cursor?.checkpointRef).toBe(checkpointRef);

    const interruptedEvents: AdapterEvent[] = [];
    await adapter.runTurn?.({
      ...body,
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 2 },
          { role: "user", content: "continue after interrupt", timestamp: 3 },
        ],
      },
      _providerContinuation: {
        cursor: {
          conversationId: "cursor_interrupt_resume",
          checkpointUsable: true,
          checkpointRef,
        },
      },
    }, { headers: new Headers() }, event => interruptedEvents.push(event));
    expect(interruptedEvents.some(event => event.type === "error")).toBe(true);
    expect(getCursorCheckpoint(checkpointRef)?.ref).toBe(checkpointRef);

    const resumedEvents: AdapterEvent[] = [];
    await adapter.runTurn?.({
      ...body,
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 2 },
          { role: "user", content: "continue after interrupt", timestamp: 3 },
        ],
      },
      _providerContinuation: body._providerContinuation,
    }, { headers: new Headers() }, event => resumedEvents.push(event));
    expect(resumedEvents.some(event => event.type === "error")).toBe(false);
    expect(attempts).toBe(3);
    expect(body._cursorConversationId).toBe("cursor_interrupt_resume");
    expect(body._providerContinuation?.cursor?.checkpointRef).toBe(checkpointRef);
    clearCursorCheckpointsForTests();
  });
});
