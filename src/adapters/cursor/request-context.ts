import { create, toBinary } from "@bufbuild/protobuf";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  CursorRuleSchema,
  CursorRuleSource,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  RequestContextEnvSchema,
  RequestContextSchema,
  type CursorRule,
  type McpToolDefinition,
  type RequestContext,
} from "./gen/agent_pb";

const CURSOR_REQUEST_CONTEXT_MAX_BYTES = 512 * 1024;

function runtimeTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"; } catch { return "UTC"; }
}

/**
 * Cursor AgentService reconstructs the model prompt from `requestContext.rules`,
 * not from the client-supplied `rootPromptMessagesJson` system blobs. Map each
 * system-prompt entry to a global CursorRule so always-apply rules survive
 * that reconstruction. Mirrors oh-my-pi `buildCursorRequestContextRules`.
 */
export function buildCursorRequestContextRules(systemPrompt: readonly string[] | undefined): CursorRule[] {
  return normalizeSystemPrompts(systemPrompt).map(({ content, index }) =>
    create(CursorRuleSchema, {
      fullPath: `/opencodex/system-prompt/${index}.mdc`,
      content,
      source: CursorRuleSource.USER,
      type: create(CursorRuleTypeSchema, {
        type: {
          case: "global",
          value: create(CursorRuleTypeGlobalSchema, {}),
        },
      }),
    }),
  );
}

export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): Array<{ content: string; index: number }> {
  if (systemPrompt === undefined || systemPrompt === null) return [];
  const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
  return prompts
    .map((prompt, index) => ({ content: typeof (prompt as unknown as { toWellFormed?: () => string }).toWellFormed === "function" ? (prompt as unknown as { toWellFormed: () => string }).toWellFormed() : prompt, index }))
    .filter(prompt => prompt.content.trim().length > 0);
}

export function buildCursorRequestContext(input: {
  system?: readonly string[];
  tools?: readonly McpToolDefinition[];
}): RequestContext {
  const originalRules = buildCursorRequestContextRules(input.system);
  const rules = [...originalRules];
  const make = () => create(RequestContextSchema, {
    rules,
    tools: [...(input.tools ?? [])],
    env: create(RequestContextEnvSchema, { timeZone: runtimeTimeZone() }),
  });
  let context = make();
  let bytes = toBinary(RequestContextSchema, context).byteLength;
  while (rules.length > 0 && bytes > CURSOR_REQUEST_CONTEXT_MAX_BYTES) {
    rules.pop();
    context = make();
    bytes = toBinary(RequestContextSchema, context).byteLength;
  }
  if (rules.length !== originalRules.length) {
    debugProviderDiagnostic("cursor", "request-context-truncated", {
      originalRules: originalRules.length,
      keptRules: rules.length,
      keptBytes: bytes,
      limit: CURSOR_REQUEST_CONTEXT_MAX_BYTES,
    });
  }
  return context;
}
