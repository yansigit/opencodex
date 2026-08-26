import { describe, expect, test } from "bun:test";
import {
  CURSOR_EXEC_COMMAND_INPUT_SCHEMA,
  cursorToolInputSchema,
  CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA,
  buildCursorToolGuidanceSystemNote,
} from "../src/adapters/cursor/tool-definitions";
import type { OcxTool } from "../src/types";

describe("Cursor exec_command sandbox escalation and schema preservation", () => {
  test("CURSOR_EXEC_COMMAND_INPUT_SCHEMA includes sandbox escalation fields", () => {
    const props = CURSOR_EXEC_COMMAND_INPUT_SCHEMA.properties as Record<string, unknown>;
    expect(props).toHaveProperty("sandbox_permissions");
    expect(props).toHaveProperty("justification");
    expect(props).toHaveProperty("prefix_rule");
  });

  test("cursorToolInputSchema preserves client sandbox_permissions and justification on exec_command", () => {
    const clientTool: OcxTool = {
      name: "exec_command",
      description: "Run command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] },
          justification: { type: "string" },
          prefix_rule: { type: "array", items: { type: "string" } },
        },
        required: ["cmd"],
      },
    };

    const schema = cursorToolInputSchema(clientTool) as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("sandbox_permissions");
    expect(schema.properties).toHaveProperty("justification");
    expect(schema.properties).toHaveProperty("prefix_rule");
    expect(schema.properties).toHaveProperty("cmd");
  });

  test("CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA includes sandbox escalation fields", () => {
    const props = CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA.properties as Record<string, unknown>;
    expect(props).toHaveProperty("sandbox_permissions");
    expect(props).toHaveProperty("justification");
  });

  test("buildCursorToolGuidanceSystemNote provides escalation guidance in code mode", () => {
    const tools: OcxTool[] = [
      { name: "exec", freeform: true },
      { name: "wait" },
    ];
    const guidance = buildCursorToolGuidanceSystemNote(tools);
    expect(guidance).toBeDefined();
    expect(guidance).toContain("require_escalated");
    expect(guidance).toContain("justification");
    expect(guidance).toContain("mcp_opencodex-responses_");
  });

  test("buildCursorToolGuidanceSystemNote provides escalation guidance in bare exec mode", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    ];
    const guidance = buildCursorToolGuidanceSystemNote(tools);
    expect(guidance).toBeDefined();
    expect(guidance).toContain("require_escalated");
    expect(guidance).toContain("justification");
  });
});
