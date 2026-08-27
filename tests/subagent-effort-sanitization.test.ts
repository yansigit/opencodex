import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { supportedLadderFor, stripEmptyLadderEffort } from "../src/server/effort-policy";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      cursor: {
        adapter: "cursor",
        baseUrl: "https://api2.cursor.sh",
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    },
    defaultProvider: "openai",
    ...overrides,
  } as OcxConfig;
}

function makeParsed(model: string, reasoning?: string): OcxParsedRequest {
  return {
    modelId: model,
    context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    stream: true,
    options: reasoning ? { reasoning: reasoning as never } : {},
    _rawBody: { model, reasoning: reasoning ? { effort: reasoning, summary: "auto" } : undefined },
  };
}

describe("Effort & parameter auto-sanitization for effortless models", () => {
  test("composer-2.5 has empty supported ladder", () => {
    const config = makeConfig();
    const route = routeModel(config, "cursor/composer-2.5");
    const ladder = supportedLadderFor(route);
    expect(ladder).toBeDefined();
    expect(ladder?.length).toBe(0);
  });

  test("stripEmptyLadderEffort sanitizes reasoning effort on empty ladder while preserving summary", () => {
    const ladder: string[] = [];
    const reasoning = { effort: "high", summary: "auto" };
    const stripped = stripEmptyLadderEffort(reasoning, ladder);
    expect(stripped).toEqual({ summary: "auto" });

    const effortOnly = { effort: "high" };
    expect(stripEmptyLadderEffort(effortOnly, ladder)).toBeUndefined();
  });

  test("effort sanitization strips reasoning from parsed.options and parsed._rawBody when routed to composer-2.5 without configured cap", async () => {
    // A subagent request arrives with reasoning effort 'high'
    const config = makeConfig();
    const route = routeModel(config, "cursor/composer-2.5");
    const parsed = makeParsed("cursor/composer-2.5", "high");
    const ladder = supportedLadderFor(route);

    // When sanitized for effortless models
    const { sanitizeEffortForModel } = await import("../src/server/effort-policy");
    sanitizeEffortForModel(parsed, ladder);

    expect(parsed.options.reasoning).toBeUndefined();
    const raw = parsed._rawBody as { reasoning?: { effort?: string; summary?: string } };
    expect(raw.reasoning?.effort).toBeUndefined();
    expect(raw.reasoning?.summary).toBe("auto");
  });

  test("effort sanitization drops reasoning object entirely from parsed._rawBody if only effort was present", async () => {
    const config = makeConfig();
    const route = routeModel(config, "cursor/composer-2.5");
    const parsed = makeParsed("cursor/composer-2.5", "high");
    (parsed._rawBody as { reasoning?: unknown }).reasoning = { effort: "high" };
    const ladder = supportedLadderFor(route);

    const { sanitizeEffortForModel } = await import("../src/server/effort-policy");
    sanitizeEffortForModel(parsed, ladder);

    expect(parsed.options.reasoning).toBeUndefined();
    const raw = parsed._rawBody as { reasoning?: unknown };
    expect(raw.reasoning).toBeUndefined();
  });

  test("effort sanitization is a no-op for models with non-empty or undefined ladder", async () => {
    const parsed = makeParsed("gpt-5.6-luna", "high");
    const { sanitizeEffortForModel } = await import("../src/server/effort-policy");

    // Non-empty ladder
    sanitizeEffortForModel(parsed, ["low", "medium", "high"]);
    expect(parsed.options.reasoning).toBe("high");
    expect((parsed._rawBody as any).reasoning.effort).toBe("high");

    // Undefined ladder
    sanitizeEffortForModel(parsed, undefined);
    expect(parsed.options.reasoning).toBe("high");
    expect((parsed._rawBody as any).reasoning.effort).toBe("high");
  });

  test("handleResponses normalizes effortless model turn end-to-end", async () => {
    const { handleResponses } = await import("../src/server/responses/core");
    const config = makeConfig({
      providers: {
        cursor: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          apiKey: "test-key",
        },
      },
    });
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" },
      body: JSON.stringify({
        model: "cursor/composer-2.5",
        input: "hello",
        reasoning: { effort: "high", summary: "auto" },
        stream: false,
      }),
    });
    const logCtx: any = { model: "", provider: "" };
    // It should reach adapter/network or fail authorization rather than 400 rejection
    const res = await handleResponses(req, config, logCtx, {});
    expect(logCtx.requestedEffort).toBe("high->none");
  });
});
