import { describe, expect, test } from "bun:test";
import {
  analyzeClaudeCompatibility,
  collectClaudeFeatureCodes,
  isClaudeCompatibilityMode,
  resolveClaudeCompatibilityMode,
} from "../src/claude/compatibility";

describe("claude compatibility analyzer (pure, no Lab)", () => {
  test("collect: empty body has no codes, beta header ignored when empty", () => {
    expect(collectClaudeFeatureCodes({}, undefined)).toEqual([]);
    expect(collectClaudeFeatureCodes({}, "")).toEqual([]);
  });

  test("collect: cache_control from any nested block", () => {
    const body = {
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("cache_control");
  });

  test("collect: context_management top-level", () => {
    expect(collectClaudeFeatureCodes({ context_management: { edits: [] } }, undefined)).toContain("context_management");
  });

  test("collect: thinking_block via thinking param", () => {
    expect(collectClaudeFeatureCodes({ thinking: { type: "enabled", budget_tokens: 1000 } }, undefined)).toContain("thinking_block");
  });

  test("collect: thinking_block via message block type thinking", () => {
    const body = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "..." }] }] };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("thinking_block");
  });

  test("collect: thinking_block via redacted_thinking block", () => {
    const body = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] }] };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("thinking_block");
  });

  test("collect: server_tool via tool type != function", () => {
    const body = { tools: [{ type: "web_search_20250305", name: "web_search", description: "x" }] };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("web_search_tool");
  });

  test("collect: server_tool via content block server_tool_use", () => {
    const body = {
      messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "1", name: "web_search" }] }],
    };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("web_search_tool");
  });

  test("collect: deferred_tools via tools.defer true", () => {
    const body = { tools: [{ name: "foo", input_schema: { type: "object" }, defer: true }] };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("deferred_tools");
  });

  test("collect: deferred_tools via top-level flag", () => {
    expect(collectClaudeFeatureCodes({ deferred_tools: true } as unknown as Record<string, unknown>, undefined)).toContain("deferred_tools");
  });

  test("collect: structured_output via output_config.format json_schema", () => {
    const body = { output_config: { format: { type: "json_schema", schema: { type: "object" } } } };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("structured_output");
  });

  test("collect: structured_output via output_config.format json_object + beta not required", () => {
    const body = { output_config: { format: { type: "json_object" } } };
    expect(collectClaudeFeatureCodes(body, undefined)).toContain("structured_output");
  });

  test("collect: beta_* sanitized, sorted, de-duped", () => {
    const codes = collectClaudeFeatureCodes({}, "context-1m-2025-08-07, effort-2025-11-24 , context-1m-2025-08-07");
    expect(codes).toEqual(["beta_context_1m_2025_08_07", "beta_effort_2025_11_24"]);
  });

  test("collect: beta token sanitizes non-alphanum to _ and trims", () => {
    const codes = collectClaudeFeatureCodes({}, "  Foo-Bar.Baz__  ");
    expect(codes).toEqual(["beta_foo_bar_baz"]);
  });

  test("collect: incompatible body + beta combined, sorted stable", () => {
    const body = { context_management: {}, tools: [{ type: "web_search_20250305", name: "ws" }] };
    const codes = collectClaudeFeatureCodes(body, "beta-1");
    expect(codes).toEqual(["beta_beta_1", "context_management", "web_search_tool"]);
  });

  // ── mode resolution ──
  test("isClaudeCompatibilityMode: only shadow|enforce", () => {
    expect(isClaudeCompatibilityMode("shadow")).toBe(true);
    expect(isClaudeCompatibilityMode("enforce")).toBe(true);
    expect(isClaudeCompatibilityMode("allow")).toBe(false);
    expect(isClaudeCompatibilityMode(undefined)).toBe(false);
    expect(isClaudeCompatibilityMode("")).toBe(false);
  });

  test("resolveClaudeCompatibilityMode: default enforce with explicit shadow escape", () => {
    expect(resolveClaudeCompatibilityMode(undefined)).toBe("enforce");
    expect(resolveClaudeCompatibilityMode({})).toBe("enforce");
    expect(resolveClaudeCompatibilityMode({ compatibility: "shadow" })).toBe("shadow");
    expect(resolveClaudeCompatibilityMode({ compatibility: "enforce" })).toBe("enforce");
    // invalid values fall back to enforce
    expect(resolveClaudeCompatibilityMode({ compatibility: "bogus" } as unknown as Record<string, unknown>)).toBe("enforce");
  });

  // ── analyze: compatibility decisions ──
  test("analyze: positional cache_control fails closed on translated targets", () => {
    const body: Record<string, unknown> = {
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    };
    const r = analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "openai-responses" });
    expect(r.compatible).toBe(false);
    expect(r.decision).toBe("reject");
    expect(r.featureCodes).toEqual(expect.arrayContaining(["cache_control", "thinking_block"]));
  });

  test("analyze: incompatible features reject in enforce, shadow only records", () => {
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { context_management: { edits: [] } }, code: "context_management" },
      { body: { tools: [{ type: "code_execution_20250501", name: "code_execution" }] } as unknown as Record<string, unknown>, code: "code_execution" },
      { body: { messages: [{ role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "hi" } }] }] } as unknown as Record<string, unknown>, code: "documents" },
      { body: { tools: [{ name: "foo", input_examples: [{ input: "x" }] }] } as unknown as Record<string, unknown>, code: "input_examples" },
    ];
    for (const { body, code } of cases) {
      const enforce = analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "openai-responses" });
      expect(enforce.decision).toBe("reject");
      expect(enforce.compatible).toBe(false);
      expect(enforce.featureCodes).toContain(code);
      expect(enforce.reason).toContain(code);

      const shadow = analyzeClaudeCompatibility(body, { mode: "shadow", adapter: "openai-responses" });
      expect(shadow.decision).toBe("shadow");
      expect(shadow.compatible).toBe(true);
      expect(shadow.featureCodes).toContain(code);
      expect(shadow.reason).toMatch(/shadow: would reject/);
    }
  });

  test("analyze: beta tokens alone never trigger rejection", () => {
    const r = analyzeClaudeCompatibility({}, { mode: "enforce", anthropicBeta: "deferred-tools-2025-01-01" });
    expect(r.decision).toBe("allow");
    expect(r.compatible).toBe(true);
    expect(r.featureCodes).toEqual(["beta_deferred_tools_2025_01_01"]);
  });

  test("analyze: multiple incompatibles listed together in reason", () => {
    const body = {
      context_management: {},
      tools: [{ type: "code_execution_20250501", name: "code_execution" }],
      messages: [{ role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "hi" } }] }],
    };
    const r = analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "cursor" });
    expect(r.decision).toBe("reject");
    expect(r.reason).toContain("context_management");
    expect(r.reason).toContain("code_execution");
    expect(r.reason).toContain("documents");
  });

  test("analyze: web_search, structured_output, service_tier, tool_search are compatible (lossless) on routed", () => {
    const webSearch = { tools: [{ type: "web_search_20250305", name: "ws" }] } as unknown as Record<string, unknown>;
    expect(analyzeClaudeCompatibility(webSearch, { mode: "enforce", adapter: "openai-responses" }).decision).toBe("allow");
    const structured = { output_config: { format: { type: "json_schema", schema: { type: "object" } } } } as unknown as Record<string, unknown>;
    expect(analyzeClaudeCompatibility(structured, { mode: "enforce", adapter: "openai-responses" }).decision).toBe("allow");
    const tier = { service_tier: "standard" } as unknown as Record<string, unknown>;
    expect(analyzeClaudeCompatibility(tier, { mode: "enforce", adapter: "openai-responses" }).decision).toBe("allow");
    const ts = { tools: [{ name: "tool_search_tool_bm25", type: "tool_search_tool_bm25_20251119" }] } as unknown as Record<string, unknown>;
    expect(analyzeClaudeCompatibility(ts, { mode: "enforce", adapter: "openai-responses" }).decision).toBe("allow");
  });

  test("analyze: deferred tools require the native Responses adapter", () => {
    const body = { tools: [{ name: "lookup", input_schema: { type: "object" }, defer_loading: true }] };
    expect(analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "openai-responses" }).decision).toBe("allow");
    const cursor = analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "cursor" });
    expect(cursor.decision).toBe("reject");
    expect(cursor.reason).toContain("deferred_tools");
  });

  test("analyze: Anthropic-only and unknown body fields fail closed on translated targets", () => {
    for (const [field, code] of [
      ["container", "container"],
      ["inference_geo", "inference_geo"],
      ["user_profile_id", "user_profile"],
      ["future_semantic_option", "unknown_body_field"],
    ] as const) {
      const result = analyzeClaudeCompatibility({ [field]: {} }, { mode: "enforce", adapter: "openai-responses" });
      expect(result.decision).toBe("reject");
      expect(result.featureCodes).toContain(code);
    }
  });

  test("analyze: empty body allow in both modes", () => {
    expect(analyzeClaudeCompatibility({}, { mode: "enforce" }).decision).toBe("allow");
    expect(analyzeClaudeCompatibility({}, { mode: "shadow" }).decision).toBe("allow");
  });
});
