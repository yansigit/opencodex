import { describe, expect, test } from "bun:test";
import { fromBinary, create } from "@bufbuild/protobuf";
import { createCursorAdapter } from "../src/adapters/cursor";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxParsedRequest } from "../src/types";

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

function decodeRoots(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
  return roots.map(id => JSON.parse(new TextDecoder().decode(blobData(id))));
}

describe("Cursor structured output support", () => {
  test("validateRequest does not throw on textFormat or _structuredOutput", () => {
    const adapter = createCursorAdapter({ adapter: "cursor", baseUrl: "https://example.com" });
    const parsed = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      options: {
        textFormat: {
          type: "json_schema",
          name: "title_generator",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, description: { type: "string" } },
            required: ["title", "description"],
          },
        },
      },
      _structuredOutput: true,
    } as unknown as OcxParsedRequest;

    expect(() => adapter.validateRequest?.(parsed)).not.toThrow();
  });

  test("encodeCursorRunRequest injects JSON schema instructions into system prompt when textFormat is present", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "kimi-k3-max",
      conversationId: "c_json_schema",
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Generate a task title." }],
      textFormat: {
        type: "json_schema",
        name: "title_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });

    const roots = decodeRoots(bytes) as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    const systemRoots = roots.filter(r => r.role === "system");
    const systemText = systemRoots.map(r => typeof r.content === "string" ? r.content : (r.content ?? []).map(c => c.text ?? "").join("\n")).join("\n");

    expect(systemText).toContain("JSON");
    expect(systemText).toContain('"title"');
  });
});

