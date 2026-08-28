import { describe, expect, test } from "bun:test";
import { fromBinary, create } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

function decodeTurns(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const turns = run?.conversationState?.turns ?? [];
  return turns.map(id => {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(id));
    if (turn.turn.case !== "agentConversationTurn") return null;
    const steps = turn.turn.value.steps.map(sId => fromBinary(ConversationStepSchema, blobData(sId)));
    return steps;
  });
}

describe("Cursor external model continuation context", () => {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "list files in src", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/kimi-k3",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_exec_1", name: "exec", namespace: undefined, arguments: { cmd: "ls src" } }],
    },
    { role: "toolResult", toolCallId: "call_exec_1", toolName: "exec", content: "index.ts\nrouter.ts", isError: false, timestamp: 3 },
  ];

  test("external model conversationTurns carry tool name in tool-result step text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "kimi-k3-max",
      conversationId: "c_kimi_turns",
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Continue" }],
      rawMessages,
    });

    const turns = decodeTurns(bytes);
    const serialized = JSON.stringify(turns);
    expect(serialized).toContain("index.ts");
    expect(serialized).toContain("Tool output for exec");
    expect(serialized).toContain("call_exec_1");
  });

  test("external replay does not expose protocol markers that models can echo as final chat", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "kimi-k3-max",
      conversationId: "c_kimi_markers",
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Continue" }],
      rawMessages,
    });

    const serialized = JSON.stringify(decodeTurns(bytes));
    expect(serialized).toContain("Tool output for exec");
    expect(serialized).toContain("call_exec_1");
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
  });

  test("external replay preserves actionable normalization for empty exec output", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "gpt-5.6-sol-xhigh",
      conversationId: "c_empty_exec",
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Continue" }],
      rawMessages: [
        { role: "user", content: "inspect the repository", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/gpt-5.6-sol",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_exec_empty", name: "exec", arguments: { cmd: "true" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call_exec_empty",
          toolName: "exec",
          content: "",
          isError: false,
          timestamp: 3,
        },
      ],
    });

    const serialized = JSON.stringify(decodeTurns(bytes));
    expect(serialized).toContain("NOT lost context");
    expect(serialized).toContain("Tool output for exec");
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
  });
});
