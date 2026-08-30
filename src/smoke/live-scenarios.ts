export type SmokeLevel = 1 | 2 | 3;

export const CLAUDE_MCP_SMOKE_TOOL_NAME = "mcp__codex_app__automation_update";

const CLAUDE_MCP_SMOKE_PROMPT = `Call ${CLAUDE_MCP_SMOKE_TOOL_NAME} exactly once with marker "smoke_test_123". After its result, reply with MCP_SMOKE_OK.`;

export function buildClaudeMcpSmokeRequest(
  modelId: string,
  continuation?: { assistantContent: unknown[]; toolUseId: string },
): Record<string, unknown> {
  const tools = [{
    name: CLAUDE_MCP_SMOKE_TOOL_NAME,
    description: "Smoke-only client function that echoes a marker without changing state.",
    input_schema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
      additionalProperties: false,
    },
  }];
  const user = { role: "user", content: CLAUDE_MCP_SMOKE_PROMPT };
  if (!continuation) {
    return {
      model: modelId,
      max_tokens: 1024,
      stream: false,
      messages: [user],
      tools,
    };
  }
  return {
    model: modelId,
    max_tokens: 1024,
    stream: false,
    messages: [
      user,
      { role: "assistant", content: continuation.assistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: continuation.toolUseId, content: "smoke_test_123" }] },
    ],
    tools,
  };
}

export interface SmokeScenario {
  level: SmokeLevel;
  name: string;
  buildRequest: (modelId: string, options?: { previousResponseId?: string; toolResult?: string }) => Record<string, unknown>;
}

export function buildSmokeScenarioRequest(
  level: SmokeLevel,
  modelId: string,
  options: { previousResponseId?: string; toolCallId?: string; toolResult?: string } = {},
): Record<string, unknown> {
  const common = { model: modelId, stream: true };
  if (level === 1) return {
    ...common,
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly five words and include a brief reasoning process." }] }],
  };
  if (level === 2) return {
    ...common,
    input: [{ role: "user", content: [{ type: "input_text", text: "Use the provided exec_command tool to run echo \"smoke_test_123\"." }] }],
    tools: [{ type: "function", name: "exec_command", description: "Execute a shell command.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
  };
  return {
    ...common,
    ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
    input: [{ type: "function_call_output", call_id: options.toolCallId ?? "smoke_call", output: options.toolResult ?? "smoke_test_123" }],
  };
}

export const BasicStreamingTurn: SmokeScenario = { level: 1, name: "BasicStreamingTurn", buildRequest: (model, options) => buildSmokeScenarioRequest(1, model, options) };
export const ToolCallingTurn: SmokeScenario = { level: 2, name: "ToolCallingTurn", buildRequest: (model, options) => buildSmokeScenarioRequest(2, model, options) };
export const MultiTurnContinuity: SmokeScenario = { level: 3, name: "MultiTurnContinuity", buildRequest: (model, options) => buildSmokeScenarioRequest(3, model, options) };
