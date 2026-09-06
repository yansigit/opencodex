import { describe, expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { decodeReasoningEnvelope, encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { responsesJsonToAnthropicMessage } from "../../src/claude/outbound";

describe("reasoning and tool/result envelopes", () => {
  test("preserves ordered thinking blocks and genuine signatures", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "first", signature: "sig-first" },
        { type: "tool_use", id: "call-1", name: "Read", input: {} },
        { type: "thinking", thinking: "second", signature: "sig-second" },
      ] }],
    }) as any;
    expect(body.input.map((item: any) => item.type)).toEqual(["reasoning", "function_call", "reasoning"]);
    expect(body.input[0].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-first" }));
    expect(body.input[2].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-second" }));
  });

  test("rejects malformed or nested OpenCodex signatures", () => {
    for (const signature of [
      "ocxr1:not-base64!!!",
      encodeReasoningEnvelope({ sig: "nested" }),
      encodeReasoningEnvelope({ sig: "", txt: "nested-empty-signature" }),
    ]) {
      expect(() => anthropicToResponsesBody({
        model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature }] }],
      })).toThrow();
    }
  });

  test("round-trips redacted thinking without exposing it as a genuine signature", () => {
    const encoded = encodeReasoningEnvelope({ sig: "sig", red: ["red-a", "red-b"] });
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "visible" }], encrypted_content: encoded }],
    }, "m") as any;
    expect(message.content[0]).toMatchObject({ type: "thinking", signature: "sig" });
    expect(message.content.slice(1)).toEqual([
      { type: "redacted_thinking", data: "red-a" },
      { type: "redacted_thinking", data: "red-b" },
    ]);
  });

  test("owned fallback is bounded and decodable", () => {
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] }],
    }, "m") as any;
    const signature = message.content[0].signature as string;
    expect(signature.startsWith("ocxr1:")).toBe(true);
    expect(decodeReasoningEnvelope(signature)).toEqual({ txt: "think" });
  });

  test("preserves an explicitly empty fallback text", () => {
    expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ txt: "" }))).toEqual({ txt: "" });
  });

  test("inbound preserves redacted-only reasoning when visible text is empty", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }],
    }) as any;
    expect(body.input).toHaveLength(1);
    expect(body.input[0].type).toBe("reasoning");
    expect(decodeReasoningEnvelope(body.input[0].encrypted_content)?.red).toEqual(["opaque"]);
  });

  test("drops an empty unsigned thinking block", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "" }] }],
    }) as any;
    expect(body.input).toEqual([]);
  });

  test("preserves signature-only reasoning in JSON output", () => {
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "sig-only" }) }],
    }, "m") as any;
    expect(message.content).toEqual([{ type: "thinking", thinking: "", signature: "sig-only" }]);
  });
});
