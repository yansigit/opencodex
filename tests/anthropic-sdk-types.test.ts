import { describe, expect, test } from "bun:test";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";

const nonStreamingFixture = {
  model: "claude-sonnet-5",
  max_tokens: 2048,
  stream: false,
  service_tier: "auto",
  metadata: { user_id: "opaque-session" },
  thinking: { type: "enabled", budget_tokens: 1024 },
  output_config: {
    effort: "high",
    format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
  },
  system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{
    name: "lookup",
    description: "Look up a value",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    input_examples: [{ key: "example" }],
  }],
  tool_choice: { type: "tool", name: "lookup" },
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "read this", cache_control: { type: "ephemeral" } },
        { type: "document", title: "note", source: { type: "text", media_type: "text/plain", data: "hello" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "consider", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "value" }] },
  ],
} satisfies MessageCreateParams;

const streamingFixture = {
  model: "claude-sonnet-5",
  max_tokens: 512,
  stream: true,
  messages: [{ role: "user", content: "hello" }],
} satisfies MessageCreateParams;

const toolSearchFixture = {
  model: "claude-sonnet-5",
  max_tokens: 1024,
  messages: [{
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "search_1", name: "tool_search_tool_bm25", input: { query: "lookup" } },
      {
        type: "tool_search_tool_result",
        tool_use_id: "search_1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "lookup" }],
        },
      },
    ],
  }],
  tools: [
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    { name: "lookup", input_schema: { type: "object" }, defer_loading: true },
  ],
} satisfies MessageCreateParams;

describe("Anthropic SDK request contracts", () => {
  test("representative streaming and non-streaming fixtures satisfy MessageCreateParams", () => {
    expect(nonStreamingFixture.stream).toBe(false);
    expect(streamingFixture.stream).toBe(true);
    expect(toolSearchFixture.tools[1]?.defer_loading).toBe(true);
  });
});
