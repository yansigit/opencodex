import { isDeepStrictEqual } from "node:util";
import type { OcxParsedRequest, OcxTool } from "../../types";
import type { SsePayloadRewrite } from "../sse-payload-rewrite";

const MIRROR_NAMESPACE = "ocx_agents";
const NATIVE_NAMESPACE = "collaboration";
const MIRRORED_NAMES = new Set(["spawn_agent", "send_message", "followup_task"]);
const GUIDANCE = "Use this routed-child mirror for collaboration operations.";
const MAX_SSE_BINDINGS = 128;

type RecordValue = Record<string, unknown>;

export interface V2RoutedDelegationBridgeContext {
  readonly names: ReadonlySet<string>;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rawToolLists(body: unknown): unknown[][] {
  if (!isRecord(body)) return [];
  const lists: unknown[][] = [];
  if (Array.isArray(body.tools)) lists.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) lists.push(item.tools);
    }
  }
  return lists;
}

function mirrorTool(tool: RecordValue): RecordValue {
  return { ...tool, description: `${GUIDANCE} ${tool.name}.` };
}

function mirrorChildren(group: RecordValue): RecordValue[] {
  if (!Array.isArray(group.tools)) return [];
  return group.tools.filter((tool): tool is RecordValue => (
    isRecord(tool) && tool.type === "function" && typeof tool.name === "string" && MIRRORED_NAMES.has(tool.name)
  )).map(mirrorTool);
}

function mirrorGroup(group: RecordValue): RecordValue {
  return { type: "namespace", name: MIRROR_NAMESPACE, tools: mirrorChildren(group) };
}

/**
 * Add request-local plaintext collaboration mirrors to raw and parsed Responses catalogs.
 * The caller has already proved this request is eligible; this helper owns no routing policy.
 */
export function injectV2RoutedDelegationBridge(
  parsed: OcxParsedRequest,
): V2RoutedDelegationBridgeContext | undefined {
  const lists = rawToolLists(parsed._rawBody);
  const nativeGroups: Array<{ list: unknown[]; index: number; group: RecordValue }> = [];
  const existing: Array<{ list: unknown[]; index: number; group: RecordValue }> = [];
  for (const list of lists) {
    list.forEach((tool, index) => {
      if (!isRecord(tool) || tool.type !== "namespace") return;
      if (tool.name === NATIVE_NAMESPACE) nativeGroups.push({ list, index, group: tool });
      if (tool.name === MIRROR_NAMESPACE) existing.push({ list, index, group: tool });
    });
  }
  if (nativeGroups.length === 0) return undefined;

  const names = new Set<string>();
  for (const { group } of nativeGroups) {
    for (const child of mirrorChildren(group)) names.add(child.name as string);
  }
  if (names.size === 0) return undefined;

  const expected = nativeGroups.map(({ list, index, group }) => ({ list, index: index + 1, group: mirrorGroup(group) }));
  const idempotent = existing.length === expected.length && expected.every(candidate => {
    const actual = candidate.list[candidate.index];
    return isRecord(actual) && isDeepStrictEqual(actual, candidate.group);
  });
  if (existing.length > 0 && !idempotent) {
    throw new Error("v2 routed delegation bridge namespace collision");
  }
  if (!idempotent) {
    for (const { list, index, group } of [...expected].reverse()) list.splice(index, 0, group);
  }

  const mirrorTools: OcxTool[] = [];
  for (const name of names) {
    const source = parsed.context.tools?.find(tool => tool.namespace === NATIVE_NAMESPACE && tool.name === name);
    if (source) {
      mirrorTools.push({ ...source, namespace: MIRROR_NAMESPACE, description: `${GUIDANCE} ${name}.` });
      continue;
    }
    const raw = nativeGroups.flatMap(entry => mirrorChildren(entry.group)).find(tool => tool.name === name);
    mirrorTools.push({
      name,
      namespace: MIRROR_NAMESPACE,
      description: `${GUIDANCE} ${name}.`,
      parameters: isRecord(raw?.parameters) ? raw.parameters : {},
    });
  }
  if (mirrorTools.length > 0) {
    const present = new Set((parsed.context.tools ?? [])
      .filter(tool => tool.namespace === MIRROR_NAMESPACE)
      .map(tool => tool.name));
    if (mirrorTools.some(tool => !present.has(tool.name))) {
      parsed.context.tools = [...(parsed.context.tools ?? []), ...mirrorTools.filter(tool => !present.has(tool.name))];
    }
  }
  return names.size > 0 ? { names } : undefined;
}

function rewriteValue(value: unknown, active: V2RoutedDelegationBridgeContext): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(entry => {
      const rewritten = rewriteValue(entry, active);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value).map(([key, entry]) => {
    const rewritten = rewriteValue(entry, active);
    changed ||= rewritten.changed;
    return [key, rewritten.value];
  });
  const next: RecordValue = Object.fromEntries(entries);
  if (value.type === "function_call" && value.namespace === MIRROR_NAMESPACE && typeof value.name === "string" && active.names.has(value.name)) {
    next.namespace = NATIVE_NAMESPACE;
    next.encrypted_function_args = [];
    changed = true;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

/** Normalize only mirror calls armed by this request in a complete JSON response. */
export function rewriteV2RoutedDelegationCallsInJson(
  json: string,
  active: V2RoutedDelegationBridgeContext | undefined,
): string {
  if (!active || active.names.size === 0) return json;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return json; }
  const rewritten = rewriteValue(parsed, active);
  return rewritten.changed ? JSON.stringify(rewritten.value) : json;
}

/** Stateful payload rewrite for SSE; item ids bind later argument events to their mirror call. */
export function createV2RoutedDelegationSseRewrite(
  active: V2RoutedDelegationBridgeContext | undefined,
): SsePayloadRewrite | undefined {
  if (!active || active.names.size === 0) return undefined;
  const bindings = new Map<string, number | undefined>();
  const outputIndexes = new Map<number, string>();
  const bind = (itemId: string | undefined, outputIndex: number | undefined): void => {
    if (itemId === undefined && outputIndex === undefined) return;
    const key = itemId ?? `@${outputIndex}`;
    if (!bindings.has(key) && bindings.size >= MAX_SSE_BINDINGS) return;
    bindings.set(key, outputIndex);
    if (outputIndex !== undefined) outputIndexes.set(outputIndex, key);
  };
  const retire = (itemId: unknown, outputIndex: unknown): void => {
    const key = typeof itemId === "string"
      ? itemId
      : typeof outputIndex === "number" ? outputIndexes.get(outputIndex) : undefined;
    if (!key) return;
    const index = bindings.get(key);
    bindings.delete(key);
    if (index !== undefined && outputIndexes.get(index) === key) outputIndexes.delete(index);
  };
  return payload => {
    let event: unknown;
    try { event = JSON.parse(payload); } catch { return payload; }
    if (!isRecord(event)) return payload;
    const type = event.type;
    const item = isRecord(event.item) ? event.item : undefined;
    const armed = !!item && item.type === "function_call" && item.namespace === MIRROR_NAMESPACE
      && typeof item.name === "string" && active.names.has(item.name);
    if (armed) {
      bind(
        typeof item.id === "string" ? item.id : undefined,
        typeof event.output_index === "number" && Number.isInteger(event.output_index) ? event.output_index : undefined,
      );
    }
    const argumentEvent = type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done";
    const matchedArgument = argumentEvent && (typeof event.item_id === "string"
      ? bindings.has(event.item_id)
      : typeof event.output_index === "number" && outputIndexes.has(event.output_index));
    const rewritten = rewriteValue(event, active);
    if (type === "response.function_call_arguments.done" || (type === "response.output_item.done" && armed)) {
      retire(event.item_id ?? item?.id, event.output_index);
    }
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      bindings.clear();
      outputIndexes.clear();
    }
    if (matchedArgument) {
      const next = rewritten.changed && isRecord(rewritten.value) ? rewritten.value : { ...event };
      next.encrypted_function_args = [];
      return JSON.stringify(next);
    }
    return rewritten.changed ? JSON.stringify(rewritten.value) : payload;
  };
}
