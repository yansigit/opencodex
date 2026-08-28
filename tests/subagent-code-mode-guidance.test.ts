import { describe, expect, test } from "bun:test";
import { multiAgentGuidanceText } from "../src/server/responses/collaboration";
import type { OcxParsedRequest } from "../src/types";

function parsedV2Fixture(tools?: Array<{ name: string; namespace?: string }>): OcxParsedRequest {
  return {
    modelId: "gpt-5.5",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: (tools ?? [{ name: "spawn_agent" }, { name: "send_message" }]) as never,
    },
    stream: true,
    options: {},
    _rawBody: { model: "gpt-5.5", input: [] },
  };
}

describe("v2 multi-agent guidance: subagent code-mode & role guidance", () => {
  test("includes orchestrator guidance to omit agent_type or use worker for model overrides", async () => {
    const text = await multiAgentGuidanceText(
      parsedV2Fixture(),
      { injectionModel: "cursor/composer-2.5" },
      {
        collectCatalogState: () => ({ state: "fresh" }),
        resolveEffectiveSubagentRoster: () => ({
          candidates: [{ model: "cursor/composer-2.5", efforts: [] }],
          advertised: [{ model: "cursor/composer-2.5", efforts: [] }],
          excluded: [],
        }),
      },
    );

    expect(text).not.toBeNull();
    // Role override guidance: advise orchestrator to omit agent_type or use worker
    expect(text).toContain("agent_type");
    expect(text).toContain("worker");
  });

  test("includes code-mode isolate guidance (no require('fs'), escape template literals for apply_patch)", async () => {
    const text = await multiAgentGuidanceText(
      parsedV2Fixture(),
      { injectionModel: "cursor/composer-2.5" },
      {
        collectCatalogState: () => ({ state: "fresh" }),
        resolveEffectiveSubagentRoster: () => ({
          candidates: [{ model: "cursor/composer-2.5", efforts: [] }],
          advertised: [{ model: "cursor/composer-2.5", efforts: [] }],
          excluded: [],
        }),
      },
    );

    expect(text).not.toBeNull();
    // Code-mode isolate guidance: pure V8 isolate, no require('fs'), template literal escaping for apply_patch
    expect(text).toContain("require('fs')");
    expect(text).toContain("apply_patch");
    expect(text).toContain("\\`");
    expect(text).toContain("\\\${");
  });

  test("renders both role advice, isolate guidance, preferred model and roster without truncation under raised budget", async () => {
    const text = await multiAgentGuidanceText(
      parsedV2Fixture(),
      {
        injectionModel: "cursor/composer-2.5",
        subagentModels: ["cursor/composer-2.5", "gpt-5.6-luna"],
      },
      {
        collectCatalogState: () => ({ state: "fresh" }),
        resolveEffectiveSubagentRoster: () => ({
          candidates: [
            { model: "cursor/composer-2.5", efforts: [] },
            { model: "gpt-5.6-luna", efforts: ["low", "high"] },
          ],
          advertised: [
            { model: "cursor/composer-2.5", efforts: [] },
            { model: "gpt-5.6-luna", efforts: ["low", "high"] },
          ],
          excluded: [],
        }),
      },
    );

    expect(text).not.toBeNull();
    expect(text).toContain("agent_type");
    expect(text).toContain("worker");
    expect(text).toContain("require('fs')");
    expect(text).toContain("apply_patch");
    expect(text).toContain("\\`");
    expect(text).toContain("\\\${");
    expect(text).toContain('model "cursor/composer-2.5"');
    expect(text).toContain("Available models");
  });
});

