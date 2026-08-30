import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  ExecClientMessageSchema,
  GetBlobArgsSchema,
  GetBlobResultSchema,
  InteractionUpdateSchema,
  KvClientMessageSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  McpToolCallSchema,
  McpToolsSchema,
  RequestContextEnvSchema,
  RequestContextResultSchema,
  RequestContextSuccessSchema,
  RequestContextSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TurnEndedUpdateSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  AgentRunRequestSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import { encodeCursorBidiAppendRequest } from "../src/adapters/cursor/http1-bidi";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { CursorOracleProtocolObserver } from "../src/lab/oracle/protocol-observer";
import { cursorOracleSchemaFingerprint } from "../src/lab/oracle/runner";
import { CURSOR_VERIFIED_SCHEMA_FINGERPRINT } from "../src/adapters/cursor/protocol-profile";

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let next = value;
  do {
    let byte = next & 0x7f;
    next = Math.floor(next / 128);
    if (next > 0) byte |= 0x80;
    out.push(byte);
  } while (next > 0);
  return Uint8Array.from(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function field(no: number, wireType: 0 | 2, value: Uint8Array | number): Uint8Array {
  const tag = varint((no << 3) | wireType);
  return wireType === 0
    ? concat(tag, varint(value as number))
    : concat(tag, varint((value as Uint8Array).byteLength), value as Uint8Array);
}

function appendRequest(mode: "legacy" | "dual" | "ref_only"): Uint8Array {
  const context = create(RequestContextSchema, {
    env: create(RequestContextEnvSchema, { timeZone: "UTC" }),
  });
  const user = create(UserMessageActionSchema, {
    userMessage: create(UserMessageSchema, { text: "synthetic" }),
    ...(mode === "ref_only" ? {} : { requestContext: context }),
  });
  const action = create(ConversationActionSchema, { action: { case: "userMessageAction", value: user } });
  if (mode !== "legacy") {
    const dynamic = toBinary(RequestContextSchema, context);
    const parts = concat(field(2, 0, 11), field(4, 0, 22), field(6, 0, 33), field(8, 0, 44), field(9, 2, dynamic));
    action.$unknown = [{ no: 17, wireType: 2, data: concat(varint(parts.byteLength), parts) }];
  }
  const bytes = toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: create(AgentRunRequestSchema, {
      conversationState: create(ConversationStateStructureSchema, {}),
      action,
      mcpTools: create(McpToolsSchema, {}),
    }) },
  }));
  return new Uint8Array(gzipSync(encodeCursorBidiAppendRequest(bytes, "fixture", 0n)));
}

function appendMessage(message: Parameters<typeof toBinary<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return appendBytes(toBinary(AgentClientMessageSchema, message));
}

function appendBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(encodeCursorBidiAppendRequest(bytes, "fixture", 0n)));
}

describe("Cursor oracle protocol observer", () => {
  test("matches the reviewed official CLI field-layout fingerprint", () => {
    const protocol = new CursorOracleProtocolObserver().snapshot();
    protocol.requestContextMode = "legacy";
    protocol.unknownFields = [
      ...[[12, 0], [14, 2], [16, 2], [25, 2]].map(([fieldNo, wireType]) => ({ location: "runRequest", fieldNo, wireType })),
      ...[[25, 2], [26, 2], [27, 2], [28, 2], [29, 2], [32, 0], [33, 0], [34, 2]].map(([fieldNo, wireType]) => ({ location: "requestContext", fieldNo, wireType })),
      ...[[14, 0], [16, 0], [19, 0], [20, 0], [21, 2], [22, 0]].map(([fieldNo, wireType]) => ({ location: "requestContext.env", fieldNo, wireType })),
    ].map(field => ({ ...field, byteLength: 0, sha256: "", occurrences: 1 }));
    expect(cursorOracleSchemaFingerprint("2026.08.25-3e8eec8", protocol)).toBe(CURSOR_VERIFIED_SCHEMA_FINGERPRINT);
    protocol.requestContextMode = "dual";
    expect(cursorOracleSchemaFingerprint("2026.08.25-3e8eec8", protocol)).not.toBe(CURSOR_VERIFIED_SCHEMA_FINGERPRINT);
  });

  test("classifies the production adapter request as legacy with ordered rules", () => {
    const observer = new CursorOracleProtocolObserver();
    observer.observeRequest("BidiAppend", appendBytes(encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "oracle-adapter-fixture",
      system: ["rule one", "rule two"],
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })), "gzip");
    const snapshot = observer.snapshot();
    expect(snapshot.requestContextMode).toBe("legacy");
    expect(snapshot.requestContext.rules.count).toBe(2);
    expect(snapshot.decodeFailures).toBe(0);
  });

  test("classifies the official CLI request-context exec result as legacy", () => {
    const observer = new CursorOracleProtocolObserver();
    const context = create(RequestContextSchema, {
      env: create(RequestContextEnvSchema, { timeZone: "UTC" }),
    });
    observer.observeRequest("BidiAppend", appendMessage(create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: create(ExecClientMessageSchema, {
        id: 1,
        message: { case: "requestContextResult", value: create(RequestContextResultSchema, {
          result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: context }) },
        }) },
      }) },
    })), "gzip");
    const snapshot = observer.snapshot();
    expect(snapshot.requestContextMode).toBe("legacy");
    expect(snapshot.requestContext.inlineCount).toBe(1);
    expect(snapshot.decodeFailures).toBe(0);
  });

  for (const mode of ["legacy", "dual", "ref_only"] as const) {
    test(`classifies ${mode} request-context transport`, () => {
      const observer = new CursorOracleProtocolObserver();
      observer.observeRequest("BidiAppend", appendRequest(mode), "gzip");
      const snapshot = observer.snapshot();
      expect(snapshot.requestContextMode).toBe(mode);
      expect(snapshot.runRequests).toBe(1);
      expect(snapshot.decodeFailures).toBe(0);
      expect(snapshot.requestContext.inlineCount).toBe(mode === "ref_only" ? 0 : 1);
      expect(snapshot.requestContext.partsCount).toBe(mode === "legacy" ? 0 : 1);
      expect(snapshot.requestContext.dynamicContextCount).toBe(mode === "legacy" ? 0 : 1);
      if (mode !== "legacy") {
        expect(snapshot.requestContext.rules.byteLength).toBe(11);
        expect(snapshot.requestContext.skills.byteLength).toBe(22);
        expect(snapshot.requestContext.subagents.byteLength).toBe(33);
        expect(snapshot.requestContext.mcpTools.byteLength).toBe(44);
      }
      expect(JSON.stringify(snapshot)).not.toContain("synthetic");
    });
  }

  test("summarizes split response frames without retaining ids or arguments", () => {
    const observer = new CursorOracleProtocolObserver();
    const args = create(McpArgsSchema, {
      name: "fixture_tool",
      toolName: "fixture_tool",
      toolCallId: "private-id",
      args: { path: new TextEncoder().encode(JSON.stringify("private-path")) },
    });
    const toolCall = create(ToolCallSchema, {
      tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
    });
    const messages = [
      create(AgentServerMessageSchema, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "toolCallStarted", value: create(ToolCallStartedUpdateSchema, { callId: "private-id", toolCall }) },
      }) } }),
      create(AgentServerMessageSchema, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "toolCallCompleted", value: create(ToolCallCompletedUpdateSchema, { callId: "private-id", toolCall }) },
      }) } }),
      create(AgentServerMessageSchema, { message: { case: "conversationCheckpointUpdate", value: create(ConversationStateStructureSchema, {
        tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 123 }),
      }) } }),
      create(AgentServerMessageSchema, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }) } }),
    ];
    const wire = concat(
      ...messages.map(message => encodeConnectFrame(toBinary(AgentServerMessageSchema, message))),
      encodeConnectFrame(new Uint8Array(), { endStream: true }),
    );
    for (let offset = 0; offset < wire.byteLength; offset += 7) {
      observer.observeResponseChunk("RunSSE", wire.subarray(offset, Math.min(offset + 7, wire.byteLength)));
    }
    const snapshot = observer.snapshot();
    expect(snapshot.toolCalls).toMatchObject({ started: 1, completed: 1, names: ["fixture_tool"] });
    expect(snapshot.toolCalls.argumentByteLength).toBeGreaterThan(0);
    expect(snapshot.checkpoints).toEqual({ count: 1, maxUsedTokens: 123 });
    expect(snapshot.terminalEvents).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("private-id");
    expect(JSON.stringify(snapshot)).not.toContain("private-path");
  });

  test("keeps interleaved RunSSE frame remainders isolated per response", () => {
    const observer = new CursorOracleProtocolObserver();
    const frame = (tokens: number) => encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "conversationCheckpointUpdate", value: create(ConversationStateStructureSchema, {
        tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: tokens }),
      }) },
    })));
    const left = frame(11);
    const right = frame(22);
    const leftSplit = Math.floor(left.byteLength / 2);
    const rightSplit = Math.floor(right.byteLength / 2);
    observer.observeResponseChunk("RunSSE", left.subarray(0, leftSplit), "left");
    observer.observeResponseChunk("RunSSE", right.subarray(0, rightSplit), "right");
    observer.observeResponseChunk("RunSSE", left.subarray(leftSplit), "left");
    observer.observeResponseChunk("RunSSE", right.subarray(rightSplit), "right");
    expect(observer.snapshot().checkpoints).toEqual({ count: 2, maxUsedTokens: 22 });
    expect(observer.snapshot().decodeFailures).toBe(0);
  });

  for (const representation of ["binary", "base64"] as const) {
    test(`summarizes fetched request-context parts from ${representation} blob bytes`, () => {
      const observer = new CursorOracleProtocolObserver();
      const blobId = new Uint8Array([7, 8, 9]);
      const context = create(RequestContextSchema, { env: create(RequestContextEnvSchema, { timeZone: "UTC" }) });
      const user = create(UserMessageActionSchema, {
        userMessage: create(UserMessageSchema, { text: "synthetic" }),
        requestContext: context,
      });
      const action = create(ConversationActionSchema, { action: { case: "userMessageAction", value: user } });
      const parts = concat(field(1, 2, blobId), field(2, 0, 5));
      action.$unknown = [{ no: 17, wireType: 2, data: concat(varint(parts.byteLength), parts) }];
      observer.observeRequest("BidiAppend", appendMessage(create(AgentClientMessageSchema, {
        message: { case: "runRequest", value: create(AgentRunRequestSchema, {
          conversationState: create(ConversationStateStructureSchema, {}),
          action,
          mcpTools: create(McpToolsSchema, {}),
        }) },
      })), "gzip");

      observer.observeResponseChunk("RunSSE", encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
        message: { case: "kvServerMessage", value: create(KvServerMessageSchema, {
          id: 41,
          message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
        }) },
      }))));
      const decodedPart = field(1, 2, new TextEncoder().encode("rule"));
      const blobData = representation === "binary"
        ? decodedPart
        : new TextEncoder().encode(Buffer.from(decodedPart).toString("base64"));
      observer.observeRequest("BidiAppend", appendMessage(create(AgentClientMessageSchema, {
        message: { case: "kvClientMessage", value: create(KvClientMessageSchema, {
          id: 41,
          message: { case: "getBlobResult", value: create(GetBlobResultSchema, { blobData }) },
        }) },
      })), "gzip");

      expect(observer.snapshot().requestContext.rules).toMatchObject({ fetchedCount: 1, fetchedByteLength: decodedPart.byteLength });
      expect(observer.snapshot().decodeFailures).toBe(0);
    });
  }
});
