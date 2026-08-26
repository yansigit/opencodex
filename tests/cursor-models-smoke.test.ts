import { describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../src/adapters/cursor";
import {
  cursorToolInputSchema,
  buildCursorToolGuidanceSystemNote,
} from "../src/adapters/cursor/tool-definitions";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
} from "../src/adapters/cursor/protobuf-events";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { create } from "@bufbuild/protobuf";
import type { OcxParsedRequest, OcxTool, OcxMessage } from "../src/types";

describe("Cursor Provider Models Comprehensive Smoke Test", () => {
  test("Smoke 1: Kimi K3 structured output does not throw and formats prompt", async () => {
    const adapter = createCursorAdapter({ adapter: "cursor", baseUrl: "https://example.com" });
    const parsed = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "generate title", timestamp: 1 }] },
      options: {
        reasoning: "max",
        textFormat: {
          type: "json_schema",
          name: "title_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      _structuredOutput: true,
    } as unknown as OcxParsedRequest;

    expect(() => adapter.validateRequest?.(parsed)).not.toThrow();

    let seenHeadroom: number | undefined;
    await adapter.runTurn(
      parsed,
      {
        headers: new Headers(),
      } as any,
      () => {},
    );
  });

  test("Smoke 2: Kimi K3 textual pseudo tool call is converted into structured tool call", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, {
              text: 'I will list the directory.\n[TOOL_CALL]mcp_opencodex-responses_exec[ARGS]{"cmd":"ls"}\nDone.',
            }),
          },
        }),
      },
    });

    const events = mapCursorProtobufServerMessage(msg, state);
    expect(events.map(e => e.type)).toEqual(["text", "tool_call_start", "tool_call_delta", "tool_call_end", "text"]);
    expect((events[0] as any).text).toBe("I will list the directory.\n");
    expect((events[1] as any).name).toBe("exec");
    expect((events[2] as any).arguments).toBe('{"cmd":"ls"}');
    expect((events[4] as any).text).toBe("\nDone.");
  });

  test("Smoke 3: Grok sandbox escalation schema and system guidance are active", () => {
    const tool: OcxTool = {
      name: "exec_command",
      description: "Run shell",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    };

    const schema = cursorToolInputSchema(tool) as { properties: Record<string, unknown> };
    expect(schema.properties.sandbox_permissions).toBeDefined();
    expect(schema.properties.justification).toBeDefined();
    expect(schema.properties.prefix_rule).toBeDefined();

    const codeModeGuidance = buildCursorToolGuidanceSystemNote([{ name: "exec", freeform: true }]);
    expect(codeModeGuidance).toContain("require_escalated");
    expect(codeModeGuidance).toContain("justification");
    expect(codeModeGuidance).toContain("mcp_opencodex-responses_");

    const bareExecGuidance = buildCursorToolGuidanceSystemNote([tool]);
    expect(bareExecGuidance).toContain("require_escalated");
    expect(bareExecGuidance).toContain("justification");
  });

  test("Smoke 4: Grok 4.6 and Kimi K3 get 300s watchdog headroom", async () => {
    let capturedHeadroom: number | undefined;
    const adapter = createCursorAdapter(
      { adapter: "cursor", baseUrl: "https://example.com" },
      {
        createTransport: input => {
          capturedHeadroom = input.streamHeartbeatOnlyFailMs;
          return {
            async *run() { yield { type: "done" }; },
            writeClient() {},
          };
        },
      },
    );

    const grokReq = {
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "think deeply", timestamp: 1 }] },
      options: { reasoning: "high" },
    } as unknown as OcxParsedRequest;

    await adapter.runTurn(grokReq, { headers: new Headers() } as any, () => {});
    expect(capturedHeadroom).toBe(300_000);

    const kimiReq = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "solve math", timestamp: 1 }] },
      options: { reasoning: "max" },
    } as unknown as OcxParsedRequest;

    await adapter.runTurn(kimiReq, { headers: new Headers() } as any, () => {});
    expect(capturedHeadroom).toBe(300_000);
  });
});

