import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
} from "../src/adapters/cursor/protobuf-events";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";

function textDeltaMsg(text: string) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
      }),
    },
  });
}

describe("Cursor textual pseudo tool call parsing", () => {
  test("parses [TOOL_CALL]...[ARGS]... into real tool call events", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg('[TOOL_CALL]mcp_opencodex-responses_exec[ARGS]{"cmd":"ls"}'),
      state,
    );

    const types = events.map(e => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_end");
    expect(types).not.toContain("text");

    const start = events.find(e => e.type === "tool_call_start") as { name: string };
    expect(start.name).toBe("exec");

    const delta = events.find(e => e.type === "tool_call_delta") as { arguments: string };
    expect(delta.arguments).toBe('{"cmd":"ls"}');
  });

  test("emits preceding prose as text before emitting the parsed tool call", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg('Checking directory:\n[TOOL_CALL]exec[ARGS]{"cmd":"pwd"}'),
      state,
    );

    const types = events.map(e => e.type);
    expect(types).toEqual(["text", "tool_call_start", "tool_call_delta", "tool_call_end"]);
    expect(events[0]).toEqual({ type: "text", text: "Checking directory:\n" });
  });

  test("leaves ordinary text without [ARGS] marker as plain text", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const prose = "We support [TOOL_CALL] style syntax in documentation.";
    const events = mapCursorProtobufServerMessage(textDeltaMsg(prose), state);
    expect(events).toEqual([{ type: "text", text: prose }]);
  });

  test("parses [TOOL_CALL] marker split across multiple streaming textDelta frames", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const events1 = mapCursorProtobufServerMessage(
      textDeltaMsg('[TOOL_CALL]mcp_opencodex-responses_exec'),
      state,
    );
    const events2 = mapCursorProtobufServerMessage(
      textDeltaMsg('[ARGS]{"cmd":"ls"}'),
      state,
    );

    const allEvents = [...events1, ...events2];
    const types = allEvents.map(e => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_end");
    expect(types).not.toContain("text");
  });

  test("parses multiple sequential [TOOL_CALL] markers in the same delta", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg('[TOOL_CALL]exec[ARGS]{"cmd":"echo 1"}[TOOL_CALL]exec[ARGS]{"cmd":"echo 2"}'),
      state,
    );

    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(2);
    const deltas = events.filter(e => e.type === "tool_call_delta") as Array<{ arguments: string }>;
    expect(deltas[0]?.arguments).toBe('{"cmd":"echo 1"}');
    expect(deltas[1]?.arguments).toBe('{"cmd":"echo 2"}');
  });

  test("handles nested quotes and braces inside JSON args", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const complexJson = '{"cmd":"python3 -c \"print({\'a\': \\\"b\\\"})\""}';
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg(`[TOOL_CALL]exec[ARGS]${complexJson}`),
      state,
    );

    const delta = events.find(e => e.type === "tool_call_delta") as { arguments: string };
    expect(delta.arguments).toBe(complexJson);
  });

  test("parses streaming delta split inside the JSON args", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const e1 = mapCursorProtobufServerMessage(textDeltaMsg('[TOOL_CALL]exec[ARGS]{"cmd":"ls'), state);
    const e2 = mapCursorProtobufServerMessage(textDeltaMsg(' -la"}'), state);
    const all = [...e1, ...e2];
    const delta = all.find(e => e.type === "tool_call_delta") as { arguments: string };
    expect(delta).toBeDefined();
    expect(delta.arguments).toBe('{"cmd":"ls -la"}');
  });

  test("translates structured edit tools via textual tool call to apply_patch", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["apply_patch", "edit_file"],
      syntheticStructuredEditToolNames: ["edit_file"],
    });
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg('[TOOL_CALL]edit_file[ARGS]{"file_path":"test.txt","old_string":"foo","new_string":"bar"}'),
      state,
    );

    const start = events.find(e => e.type === "tool_call_start") as { name: string };
    expect(start.name).toBe("apply_patch");
    const delta = events.find(e => e.type === "tool_call_delta") as { arguments: string };
    expect(delta.arguments).toContain("*** Begin Patch");
    expect(delta.arguments).toContain("-foo");
    expect(delta.arguments).toContain("+bar");
  });

  test("normalizes shell_command cmd arg to command via textual tool call", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["shell_command"],
    });
    const events = mapCursorProtobufServerMessage(
      textDeltaMsg('[TOOL_CALL]shell_command[ARGS]{"cmd":"git status"}'),
      state,
    );

    const delta = events.find(e => e.type === "tool_call_delta") as { arguments: string };
    expect(delta.arguments).toContain('"command":"git status"');
  });
});
