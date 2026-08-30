export type SmokeLevel = 1 | 2 | 3;

export const CLAUDE_MCP_SMOKE_TOOL_NAME = "mcp__codex_app__automation_update";

const CLAUDE_MCP_SMOKE_PROMPT = `Call ${CLAUDE_MCP_SMOKE_TOOL_NAME} exactly once with marker "smoke_test_123". After its result, reply with MCP_SMOKE_OK.`;

export function buildClaudeMcpSmokeRequest(
  modelId: string,
  continuation?: { assistantContent: unknown[]; toolUseId: string },
  options: { stream?: boolean } = {},
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
  const stream = options.stream ?? true;
  if (!continuation) {
    return {
      model: modelId,
      max_tokens: 1024,
      stream,
      messages: [user],
      tools,
    };
  }
  return {
    model: modelId,
    max_tokens: 1024,
    stream,
    messages: [
      user,
      { role: "assistant", content: continuation.assistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: continuation.toolUseId, content: "smoke_test_123" }] },
    ],
    tools,
  };
}

export interface ParsedClaudeMessage {
  type: string;
  role: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
}

export function parseClaudeMessageResponse(body: string): ParsedClaudeMessage {
  try {
    const json = JSON.parse(body);
    if (json && typeof json === "object" && json.type === "message") {
      return {
        type: "message",
        role: typeof json.role === "string" ? json.role : "assistant",
        content: Array.isArray(json.content) ? json.content : [],
        stop_reason: typeof json.stop_reason === "string" ? json.stop_reason : null,
      };
    }
  } catch {
    // Treat as SSE stream
  }

  const content: Array<Record<string, unknown>> = [];
  let openBlock: Record<string, unknown> | null = null;
  let toolJson = "";
  let stopReason: string | null = null;

  const closeBlock = () => {
    if (!openBlock) return;
    if (openBlock.type === "tool_use" || openBlock.type === "server_tool_use") {
      try {
        openBlock.input = toolJson.length > 0 ? JSON.parse(toolJson) : (openBlock.input ?? {});
      } catch {
        openBlock.input = openBlock.input ?? {};
      }
    }
    content.push(openBlock);
    openBlock = null;
    toolJson = "";
  };

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const dataStr = line.slice(6).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const data = JSON.parse(dataStr);
      if (!data || typeof data !== "object") continue;
      if (data.type === "content_block_start") {
        closeBlock();
        if (data.content_block && typeof data.content_block === "object") {
          const rawBlock = { ...data.content_block } as Record<string, unknown>;
          if (rawBlock.type === "text" && rawBlock.text === undefined) rawBlock.text = "";
          if (rawBlock.type === "thinking" && rawBlock.thinking === undefined) rawBlock.thinking = "";
          openBlock = rawBlock;
        }
      } else if (data.type === "content_block_delta" && openBlock && data.delta && typeof data.delta === "object") {
        const block = openBlock;
        const delta = data.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = (typeof block.text === "string" ? block.text : "") + delta.text;
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + delta.thinking;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = delta.signature;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          toolJson += delta.partial_json;
        }
      } else if (data.type === "content_block_stop") {
        closeBlock();
      } else if (data.type === "message_delta" && data.delta && typeof data.delta === "object" && typeof data.delta.stop_reason === "string") {
        stopReason = data.delta.stop_reason;
      }
    } catch {}
  }
  closeBlock();
  return { type: "message", role: "assistant", content, stop_reason: stopReason };
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
