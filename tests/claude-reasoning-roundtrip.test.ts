import { describe, expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import { encodeReasoningEnvelope, decodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import {
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
  collectAnthropicMessage,
} from "../src/claude/outbound";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
function streamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (let i=0;i<text.length;i+=7) c.enqueue(enc.encode(text.slice(i,i+7))); c.close(); }});
}
async function collectAnthropic(stream: ReadableStream<Uint8Array>) {
  return collectAnthropicMessage(stream, "m", createTestTranslatorBudget());
}

describe("claude reasoning roundtrip", () => {
  test("inbound: multiple thinking blocks preserve order and interleave with tool_use", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [{
        role: "assistant", content: [
          { type: "thinking", thinking: "first", signature: "sig-first" },
          { type: "tool_use", id: "t1", name: "Read", input: { a: 1 } },
          { type: "thinking", thinking: "second", signature: "sig-second" },
          { type: "tool_use", id: "t2", name: "tool_search", input: { q: "x" } },
          { type: "text", text: "hello" },
        ]
      }]
    }) as any;
    const input = body.input as any[];
    expect(input.map((i:any)=>i.type)).toEqual(["reasoning","function_call","reasoning","tool_search_call","message"]);
    expect(input[0].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-first" }));
    expect(input[0].summary).toEqual([{type:"summary_text", text:"first"}]);
    expect(input[2].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-second" }));
    expect(input[3]).toMatchObject({ type: "tool_search_call", call_id: "t2" });
  });

  test("inbound: redacted_thinking encodes red envelope and preserves block", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "red1" }, { type: "redacted_thinking", data: "red2" }] }]
    }) as any;
    const input = body.input as any[];
    expect(input).toHaveLength(2);
    expect(decodeReasoningEnvelope(input[0].encrypted_content)?.red).toEqual(["red1"]);
    expect(decodeReasoningEnvelope(input[1].encrypted_content)?.red).toEqual(["red2"]);
  });

  test("inbound: malformed and owned ocxr1 signatures fail closed", () => {
    for (const signature of ["ocxr1:not-base64!!!", encodeReasoningEnvelope({ sig: "nested-genuine" })]) {
      expect(() => anthropicToResponsesBody({
        model: "m", max_tokens: 10,
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hi", signature }] }]
      })).toThrow();
    }
  });

  test("inbound: valid OpenCodex-owned continuity is not double-wrapped", () => {
    const signature = encodeReasoningEnvelope({ txt: "prior thought" });
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hi", signature }] }],
    }) as any;
    expect(body.input[0].encrypted_content).toBe(signature);
  });

  test("outbound JSON: genuine sig preserved, owned ocxr1 for non-Anthropic, never krc", () => {
    const genuineSig = "anthropic-sig-123";
    const genuineEnc = encodeReasoningEnvelope({ sig: genuineSig });
    const msgGenuine = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{type:"summary_text", text:"think"}], encrypted_content: genuineEnc }],
      usage: {}
    }, "m") as any;
    expect(msgGenuine.content[0].signature).toBe(genuineSig);
    const msgOwned = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{type:"summary_text", text:"think"}] }],
      usage: {}
    }, "m") as any;
    expect(msgOwned.content[0].signature.startsWith("ocxr1:")).toBe(true);
    expect(decodeReasoningEnvelope(msgOwned.content[0].signature)?.txt).toBe("think");
    expect(decodeReasoningEnvelope(msgOwned.content[0].signature)?.sig).toBeUndefined();
    const krcEnc = encodeReasoningEnvelope({ krc: "krc-blob", txt: "hidden" });
    const msgKrc = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{type:"summary_text", text:"think"}], encrypted_content: krcEnc }],
      usage: {}
    }, "m") as any;
    expect(msgKrc.content[0].signature.startsWith("ocxr1:")).toBe(true);
    expect(decodeReasoningEnvelope(msgKrc.content[0].signature)?.krc).toBeUndefined();
    expect(decodeReasoningEnvelope(msgKrc.content[0].signature)?.txt).toBe("think");
  });

  test("outbound JSON: red envelope emits redacted_thinking blocks", () => {
    const enc = encodeReasoningEnvelope({ sig: "s1", red: ["r1","r2"] });
    const msg = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{type:"summary_text", text:"t"}], encrypted_content: enc }],
      usage: {}
    }, "m") as any;
    expect(msg.content[0].type).toBe("thinking");
    expect(msg.content[0].signature).toBe("s1");
    expect(msg.content[1]).toEqual({ type: "redacted_thinking", data: "r1" });
    expect(msg.content[2]).toEqual({ type: "redacted_thinking", data: "r2" });
  });

  test("outbound JSON: tool_search_call maps to tool_use name tool_search and triggers tool_use stop_reason", () => {
    const msg = responsesJsonToAnthropicMessage({
      output: [{ type: "tool_search_call", call_id: "c1", arguments: JSON.stringify({ q: "x" }) }],
      usage: {}
    }, "m") as any;
    expect(msg.content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "tool_search" });
    expect(msg.stop_reason).toBe("tool_use");
  });

  test("outbound SSE: tool_search arguments present only on item.done are emitted", async () => {
    const upstream = [
      sse("response.output_item.added", { output_index: 0, item: { type: "tool_search_call", call_id: "c1" } }),
      sse("response.output_item.done", { output_index: 0, item: { type: "tool_search_call", call_id: "c1", arguments: JSON.stringify({ query: "lookup" }) } }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const msg = await collectAnthropic(responsesSseToAnthropicSse(
      streamFrom(upstream), "m", { pingIntervalMs: 0, translatorBudget: createTestTranslatorBudget() },
    )) as any;
    expect(msg.content[0]).toEqual({ type: "tool_use", id: "c1", name: "tool_search", input: { query: "lookup" } });
    expect(msg.stop_reason).toBe("tool_use");
  });

  test("outbound SSE: thinking signature derived from encrypted_content, owned fallback, red emission", async () => {
    const genuineSig = "genuine-sig-xyz";
    const encGenuine = encodeReasoningEnvelope({ sig: genuineSig });
    const upstreamGenuine = [
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs1" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs1", summary_index: 0, delta: "hello" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs1", summary: [{type:"summary_text", text:"hello"}], encrypted_content: encGenuine } }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const msgG = await collectAnthropic(responsesSseToAnthropicSse(streamFrom(upstreamGenuine), "m", { pingIntervalMs: 0, translatorBudget: createTestTranslatorBudget() })) as any;
    const thinkG = msgG.content.find((c:any)=>c.type==="thinking");
    expect(thinkG.signature).toBe(genuineSig);
    const encRed = encodeReasoningEnvelope({ sig: "sig2", red: ["redA"] });
    const upstreamRed = [
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs2" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs2", summary_index: 0, delta: "hi" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs2", summary: [{type:"summary_text", text:"hi"}], encrypted_content: encRed } }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const msgR = await collectAnthropic(responsesSseToAnthropicSse(streamFrom(upstreamRed), "m", { pingIntervalMs: 0, translatorBudget: createTestTranslatorBudget() })) as any;
    expect(msgR.content.some((c:any)=>c.type==="redacted_thinking" && c.data==="redA")).toBe(true);
    const encKrc = encodeReasoningEnvelope({ krc: "krc-blob", txt: "hidden" });
    const upstreamKrc = [
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs3" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs3", summary_index: 0, delta: "hi" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs3", summary: [{type:"summary_text", text:"hi"}], encrypted_content: encKrc } }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const msgK = await collectAnthropic(responsesSseToAnthropicSse(streamFrom(upstreamKrc), "m", { pingIntervalMs: 0, translatorBudget: createTestTranslatorBudget() })) as any;
    const thinkK = msgK.content.find((c:any)=>c.type==="thinking");
    expect(thinkK.signature.startsWith("ocxr1:")).toBe(true);
    expect(decodeReasoningEnvelope(thinkK.signature)?.krc).toBeUndefined();
  });
});
