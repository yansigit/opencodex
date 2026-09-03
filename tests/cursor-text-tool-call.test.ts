import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  createCursorProtobufEventState,
  finalizeTurnEvents,
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

  test("parses Kimi XML tool calls into structured events across every chunk boundary", () => {
    const xml = '<tool_call>\n{"name":"functions.ocx_client_read_workflow","arguments":{"path":"gsd-core/workflows/plan-phase.md"}}\n</tool_call>';
    for (let split = 0; split <= xml.length; split++) {
      const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
      const events = [
        ...mapCursorProtobufServerMessage(textDeltaMsg(xml.slice(0, split)), state),
        ...mapCursorProtobufServerMessage(textDeltaMsg(xml.slice(split)), state),
      ];
      expect(events.map(event => event.type)).toEqual([
        "tool_call_start",
        "tool_call_delta",
        "tool_call_end",
      ]);
      expect(events[0]).toMatchObject({ type: "tool_call_start", name: "ocx_client_read_workflow" });
      expect(events[1]).toEqual({
        type: "tool_call_delta",
        arguments: '{"path":"gsd-core/workflows/plan-phase.md"}',
      });
    }
  });

  test("leaves malformed, unknown, and explanatory XML tool-call text unchanged", () => {
    const values = [
      '<tool_call>{"name":"functions.unknown","arguments":{}}</tool_call>',
      '<tool_call>{"name":"functions.ocx_client_read_workflow","arguments":"not-an-object"}</tool_call>',
      "Documentation can mention <tool_call> without forming a call.",
    ];
    for (const value of values) {
      const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
      const events = [
        ...mapCursorProtobufServerMessage(textDeltaMsg(value), state),
        ...finalizeTurnEvents(state),
      ];
      expect(events.filter(event => event.type === "text").map(event => event.text).join(""))
        .toBe(value);
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
    }
  });

  test("uses the JSON object boundary instead of a closing tag inside an argument string", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
    const xml = '<tool_call>{"name":"functions.ocx_client_read_workflow","arguments":{"path":"contains </tool_call> text"}}</tool_call>';
    const events = mapCursorProtobufServerMessage(textDeltaMsg(xml), state);
    expect(events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end"]);
    expect(events[1]).toEqual({
      type: "tool_call_delta",
      arguments: '{"path":"contains </tool_call> text"}',
    });
  });

  test("bounds an unclosed XML tool call and releases it as text", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
    const value = '<tool_call>{"name":"functions.ocx_client_read_workflow","arguments":{"path":"'
      + "x".repeat(256 * 1_024)
      + '"';
    const events = mapCursorProtobufServerMessage(textDeltaMsg(value), state);
    expect(events.filter(event => event.type === "text").map(event => event.text).join(""))
      .toBe(value);
    expect(state.textToolCallBuffer).toBeUndefined();
  });

  test("parses Grok bare JSON tool objects across every chunk boundary", () => {
    const json = '{"id":"call_plan_phase_001","name":"mcp_opencodex-responses_ocx_client_read_workflow","arguments":{"path":"gsd-core/workflows/plan-phase.md"}}';
    for (let split = 0; split <= json.length; split++) {
      const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
      const events = [
        ...mapCursorProtobufServerMessage(textDeltaMsg(json.slice(0, split)), state),
        ...mapCursorProtobufServerMessage(textDeltaMsg(json.slice(split)), state),
      ];
      expect(events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end"]);
      expect(events[1]).toEqual({
        type: "tool_call_delta",
        arguments: '{"path":"gsd-core/workflows/plan-phase.md"}',
      });
    }
  });

  test("leaves ordinary and unknown bare JSON objects as text", () => {
    const values = [
      '{"answer":42}',
      '{"id":"call","name":"functions.unknown","arguments":{}}',
      '{"name":"functions.ocx_client_read_workflow","arguments":{}}',
    ];
    for (const value of values) {
      const state = createCursorProtobufEventState({ clientToolNames: ["ocx_client_read_workflow"] });
      const events = mapCursorProtobufServerMessage(textDeltaMsg(value), state);
      expect(events).toEqual([{ type: "text", text: value }]);
    }
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
