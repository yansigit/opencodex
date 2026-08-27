export type SmokeLevel = 1 | 2 | 3;

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
