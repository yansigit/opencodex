import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fromBinary, toBinary, type Message, type UnknownField } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  CursorRuleSchema,
  McpToolDefinitionSchema,
  RequestContextSchema,
  type RequestContext,
  type ToolCall,
} from "../../adapters/cursor/gen/agent_pb";
import { consumeConnectFrames } from "../../adapters/cursor/framing";
import { CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES } from "./constants";

const MAX_UNKNOWN_SUMMARIES = 128;
const MAX_CONNECT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_STREAMS = 64;
const MAX_BLOB_REFERENCES = 128;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
type ContextPartKind = "rules" | "skills" | "subagents" | "mcpTools";

export interface CursorOracleUnknownFieldSummary {
  location: string;
  fieldNo: number;
  wireType: number;
  byteLength: number;
  sha256: string;
  occurrences: number;
}

export interface CursorOracleProtocolObservation {
  requestContextMode: "legacy" | "dual" | "ref_only" | "unknown";
  messageCaseCounts: Record<string, number>;
  serverMessageCaseCounts: Record<string, number>;
  actionCaseCounts: Record<string, number>;
  runRequests: number;
  requestContext: {
    inlineCount: number;
    partsCount: number;
    dynamicContextCount: number;
    totalByteLength: number;
    rules: { count: number; byteLength: number; fetchedCount: number; fetchedByteLength: number };
    skills: { count: number; byteLength: number; fetchedCount: number; fetchedByteLength: number };
    subagents: { count: number; byteLength: number; fetchedCount: number; fetchedByteLength: number };
    mcpTools: { count: number; byteLength: number; fetchedCount: number; fetchedByteLength: number };
    cloudRuleByteLength: number;
  };
  toolCalls: {
    started: number;
    partial: number;
    completed: number;
    argumentByteLength: number;
    maxArgumentByteLength: number;
    names: string[];
  };
  checkpoints: { count: number; maxUsedTokens: number };
  terminalEvents: number;
  unknownFields: CursorOracleUnknownFieldSummary[];
  decodeFailures: number;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < bytes.byteLength && shift <= 63n; offset++) {
    const byte = bytes[offset]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: offset + 1 };
    shift += 7n;
  }
  throw new Error("invalid protobuf varint");
}

function lengthDelimitedPayload(field: UnknownField): Uint8Array | undefined {
  if (field.wireType !== 2) return undefined;
  const length = readVarint(field.data, 0);
  const size = Number(length.value);
  if (!Number.isSafeInteger(size) || length.offset + size !== field.data.byteLength) return undefined;
  return field.data.subarray(length.offset);
}

function protobufField(bytes: Uint8Array, wanted: number): Uint8Array | undefined {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytes.byteLength) throw new Error("truncated protobuf field");
      const value = bytes.subarray(offset, end);
      if (fieldNo === wanted) return value;
      offset = end;
      continue;
    }
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      continue;
    }
    if (wireType === 1) { offset += 8; continue; }
    if (wireType === 5) { offset += 4; continue; }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return undefined;
}

function protobufFields(bytes: Uint8Array): Array<{ no: number; wireType: number; value?: Uint8Array }> {
  const fields: Array<{ no: number; wireType: number; value?: Uint8Array }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const no = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (no < 1) throw new Error("invalid protobuf field number");
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytes.byteLength) throw new Error("truncated protobuf field");
      fields.push({ no, wireType, value: bytes.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 0) { offset = readVarint(bytes, offset).offset; fields.push({ no, wireType }); continue; }
    if (wireType === 1) { offset += 8; fields.push({ no, wireType }); continue; }
    if (wireType === 5) { offset += 4; fields.push({ no, wireType }); continue; }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  if (offset !== bytes.byteLength) throw new Error("truncated protobuf field");
  return fields;
}

function normalizedPartBlob(bytes: Uint8Array): { bytes: Uint8Array; fields: ReturnType<typeof protobufFields> } {
  const candidates = [bytes];
  const text = new TextDecoder().decode(bytes);
  if (text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    try { candidates.push(new Uint8Array(Buffer.from(text, "base64"))); } catch {}
  }
  let fallback: { bytes: Uint8Array; fields: ReturnType<typeof protobufFields> } | undefined;
  for (const candidate of candidates) {
    try {
      const fields = protobufFields(candidate);
      const parsed = { bytes: candidate, fields };
      if (fields.some(field => field.no === 1 && field.wireType === 2)) return parsed;
      fallback ??= parsed;
    } catch {}
  }
  if (fallback) return fallback;
  throw new Error("invalid request-context part blob");
}

function blobKey(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeAppendPayload(body: Uint8Array): Uint8Array {
  const data = protobufField(body, 1);
  if (!data) throw new Error("BidiAppend data field missing");
  const text = new TextDecoder().decode(data);
  if (text.length > 0 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text)) {
    return Uint8Array.from({ length: text.length / 2 }, (_, index) =>
      Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
  }
  return data;
}

function maybeGunzip(body: Uint8Array, contentEncoding: string | undefined): Uint8Array {
  if (!contentEncoding?.toLowerCase().split(",").some(value => value.trim() === "gzip")) return body;
  return new Uint8Array(gunzipSync(body, { maxOutputLength: CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES }));
}

function varintUnknownValue(field: UnknownField): number | undefined {
  if (field.wireType !== 0) return undefined;
  const value = readVarint(field.data, 0).value;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function toolName(toolCall: ToolCall | undefined): string | undefined {
  if (!toolCall) return undefined;
  if (toolCall.tool.case === "mcpToolCall") {
    const name = toolCall.tool.value.args?.toolName || toolCall.tool.value.args?.name;
    return name && SAFE_TOOL_NAME.test(name) ? name : undefined;
  }
  return toolCall.tool.case && SAFE_TOOL_NAME.test(toolCall.tool.case) ? toolCall.tool.case : undefined;
}

function toolArgumentBytes(toolCall: ToolCall | undefined): number {
  if (toolCall?.tool.case !== "mcpToolCall") return 0;
  return Object.values(toolCall.tool.value.args?.args ?? {}).reduce((total, value) => total + value.byteLength, 0);
}

export class CursorOracleProtocolObserver {
  private readonly modes = new Set<"legacy" | "dual" | "ref_only">();
  private readonly messageCaseCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly serverMessageCaseCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly actionCaseCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly unknown = new Map<string, CursorOracleUnknownFieldSummary>();
  private readonly toolNames = new Set<string>();
  private readonly responseRemainders = new Map<string, Uint8Array>();
  private readonly contextPartByBlob = new Map<string, ContextPartKind>();
  private readonly pendingPartByKvId = new Map<number, ContextPartKind>();
  private runRequests = 0;
  private inlineCount = 0;
  private partsCount = 0;
  private dynamicContextCount = 0;
  private requestContextBytes = 0;
  private ruleCount = 0;
  private ruleBytes = 0;
  private skillCount = 0;
  private skillBytes = 0;
  private subagentCount = 0;
  private subagentBytes = 0;
  private mcpToolCount = 0;
  private mcpToolBytes = 0;
  private cloudRuleBytes = 0;
  private readonly fetchedPartCounts: Record<ContextPartKind, number> = { rules: 0, skills: 0, subagents: 0, mcpTools: 0 };
  private readonly fetchedPartBytes: Record<ContextPartKind, number> = { rules: 0, skills: 0, subagents: 0, mcpTools: 0 };
  private toolStarted = 0;
  private toolPartial = 0;
  private toolCompleted = 0;
  private toolArgumentByteLength = 0;
  private maxToolArgumentByteLength = 0;
  private checkpointCount = 0;
  private maxUsedTokens = 0;
  private terminalEvents = 0;
  private decodeFailures = 0;

  observeRequest(endpoint: string, body: Uint8Array, contentEncoding?: string): void {
    if (endpoint !== "BidiAppend" || body.byteLength === 0) return;
    try {
      const append = maybeGunzip(body, contentEncoding);
      const message = fromBinary(AgentClientMessageSchema, decodeAppendPayload(append), { readUnknownFields: true });
      const messageCase = message.message.case || "unknown";
      increment(this.messageCaseCounts, messageCase);
      this.observeUnknown("agentClientMessage", message);
      if (message.message.case === "execClientMessage") {
        const result = message.message.value.message;
        if (result.case === "requestContextResult" && result.value.result.case === "success") {
          const context = result.value.result.value.requestContext;
          if (context) {
            this.inlineCount++;
            this.observeRequestContext(context, "requestContext");
            if (this.modes.size === 0) this.modes.add("legacy");
          }
        }
        return;
      }
      if (message.message.case === "kvClientMessage") {
        const kv = message.message.value;
        if (kv.message.case === "getBlobResult") {
          const kind = this.pendingPartByKvId.get(kv.id);
          this.pendingPartByKvId.delete(kv.id);
          if (kind && kv.message.value.blobData) this.observeFetchedPart(kind, kv.message.value.blobData);
        }
        return;
      }
      if (message.message.case !== "runRequest") return;
      this.runRequests++;
      const run = message.message.value;
      this.observeUnknown("runRequest", run);
      const action = run.action;
      if (!action) return;
      const actionCase = action.action.case || "unknown";
      increment(this.actionCaseCounts, actionCase);
      this.observeUnknown("conversationAction", action);
      const inline = action.action.case === "userMessageAction"
        ? action.action.value.requestContext
        : action.action.case === "resumeAction"
          ? action.action.value.requestContext
          : undefined;
      const partsFields = action.$unknown?.filter(field => field.no === 17 && field.wireType === 2) ?? [];
      const hasParts = partsFields.length > 0;
      if (inline) {
        this.inlineCount++;
        this.observeRequestContext(inline, "requestContext");
      }
      if (hasParts) {
        this.partsCount++;
        for (const field of partsFields) {
          const payload = lengthDelimitedPayload(field);
          if (payload) this.observeParts(payload);
        }
      }
      if (inline && hasParts) this.modes.add("dual");
      else if (inline) this.modes.add("legacy");
      else if (hasParts) this.modes.add("ref_only");
      if (run.mcpTools) {
        this.mcpToolCount += run.mcpTools.mcpTools.length;
        this.mcpToolBytes += run.mcpTools.mcpTools.reduce((total, tool) => total + toBinary(McpToolDefinitionSchema, tool).byteLength, 0);
      }
    } catch {
      this.decodeFailures++;
    }
  }

  observeResponseChunk(endpoint: string, chunk: Uint8Array, streamKey = "default"): void {
    if (endpoint !== "RunSSE" || chunk.byteLength === 0) return;
    try {
      const remainder = this.responseRemainders.get(streamKey) ?? new Uint8Array();
      if (!this.responseRemainders.has(streamKey) && this.responseRemainders.size >= MAX_RESPONSE_STREAMS) {
        this.responseRemainders.delete(this.responseRemainders.keys().next().value!);
        this.decodeFailures++;
      }
      if (remainder.byteLength + chunk.byteLength > CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES) {
        this.responseRemainders.delete(streamKey);
        this.decodeFailures++;
        return;
      }
      const next = new Uint8Array(remainder.byteLength + chunk.byteLength);
      next.set(remainder);
      next.set(chunk, remainder.byteLength);
      const decoded = consumeConnectFrames(next, MAX_CONNECT_FRAME_BYTES, 1024);
      const nextRemainder = next.slice(decoded.consumedBytes);
      if (nextRemainder.byteLength > 0) this.responseRemainders.set(streamKey, nextRemainder);
      else this.responseRemainders.delete(streamKey);
      for (const frame of decoded.frames) {
        if (frame.endStream) {
          this.terminalEvents++;
          this.responseRemainders.delete(streamKey);
        }
        if (frame.payload.byteLength === 0 || frame.endStream) continue;
        const payload = frame.compressed
          ? new Uint8Array(gunzipSync(frame.payload, { maxOutputLength: MAX_CONNECT_FRAME_BYTES }))
          : frame.payload;
        const message = fromBinary(AgentServerMessageSchema, payload, { readUnknownFields: true });
        const messageCase = message.message.case || "unknown";
        increment(this.serverMessageCaseCounts, messageCase);
        this.observeUnknown("agentServerMessage", message);
        if (message.message.case === "kvServerMessage") {
          const kv = message.message.value;
          if (kv.message.case === "getBlobArgs") {
            const kind = this.contextPartByBlob.get(blobKey(kv.message.value.blobId));
            if (kind) {
              this.pendingPartByKvId.set(kv.id, kind);
              while (this.pendingPartByKvId.size > MAX_BLOB_REFERENCES) {
                this.pendingPartByKvId.delete(this.pendingPartByKvId.keys().next().value!);
              }
            }
          }
          continue;
        }
        if (message.message.case === "conversationCheckpointUpdate") {
          this.checkpointCount++;
          this.maxUsedTokens = Math.max(this.maxUsedTokens, message.message.value.tokenDetails?.usedTokens ?? 0);
          continue;
        }
        if (message.message.case !== "interactionUpdate") continue;
        const update = message.message.value.message;
        if (update.case === "turnEnded") this.terminalEvents++;
        if (update.case === "toolCallStarted") this.observeTool("started", update.value.toolCall, 0);
        if (update.case === "partialToolCall") this.observeTool("partial", update.value.toolCall, Buffer.byteLength(update.value.argsTextDelta));
        if (update.case === "toolCallCompleted") this.observeTool("completed", update.value.toolCall, toolArgumentBytes(update.value.toolCall));
      }
    } catch {
      this.responseRemainders.delete(streamKey);
      this.decodeFailures++;
    }
  }

  snapshot(): CursorOracleProtocolObservation {
    const requestContextMode = this.modes.size === 1 ? [...this.modes][0]! : "unknown";
    return {
      requestContextMode,
      messageCaseCounts: { ...this.messageCaseCounts },
      serverMessageCaseCounts: { ...this.serverMessageCaseCounts },
      actionCaseCounts: { ...this.actionCaseCounts },
      runRequests: this.runRequests,
      requestContext: {
        inlineCount: this.inlineCount,
        partsCount: this.partsCount,
        dynamicContextCount: this.dynamicContextCount,
        totalByteLength: this.requestContextBytes,
        rules: { count: this.ruleCount, byteLength: this.ruleBytes, fetchedCount: this.fetchedPartCounts.rules, fetchedByteLength: this.fetchedPartBytes.rules },
        skills: { count: this.skillCount, byteLength: this.skillBytes, fetchedCount: this.fetchedPartCounts.skills, fetchedByteLength: this.fetchedPartBytes.skills },
        subagents: { count: this.subagentCount, byteLength: this.subagentBytes, fetchedCount: this.fetchedPartCounts.subagents, fetchedByteLength: this.fetchedPartBytes.subagents },
        mcpTools: { count: this.mcpToolCount, byteLength: this.mcpToolBytes, fetchedCount: this.fetchedPartCounts.mcpTools, fetchedByteLength: this.fetchedPartBytes.mcpTools },
        cloudRuleByteLength: this.cloudRuleBytes,
      },
      toolCalls: {
        started: this.toolStarted,
        partial: this.toolPartial,
        completed: this.toolCompleted,
        argumentByteLength: this.toolArgumentByteLength,
        maxArgumentByteLength: this.maxToolArgumentByteLength,
        names: [...this.toolNames].sort(),
      },
      checkpoints: { count: this.checkpointCount, maxUsedTokens: this.maxUsedTokens },
      terminalEvents: this.terminalEvents,
      unknownFields: [...this.unknown.values()],
      decodeFailures: this.decodeFailures,
    };
  }

  private observeRequestContext(context: RequestContext, location: string): void {
    this.requestContextBytes += toBinary(RequestContextSchema, context).byteLength;
    this.ruleCount += context.rules.length;
    this.ruleBytes += context.rules.reduce((total, rule) => total + toBinary(CursorRuleSchema, rule).byteLength, 0);
    this.subagentCount += context.customSubagents.length;
    this.mcpToolCount += context.tools.length;
    this.mcpToolBytes += context.tools.reduce((total, tool) => total + toBinary(McpToolDefinitionSchema, tool).byteLength, 0);
    this.cloudRuleBytes += context.cloudRule ? Buffer.byteLength(context.cloudRule) : 0;
    const agentSkills = context.$unknown?.filter(field => field.no === 29 && field.wireType === 2) ?? [];
    this.skillCount += agentSkills.length + (context.skillOptions?.skillDescriptors.length ?? 0);
    this.skillBytes += agentSkills.reduce((total, field) => total + (lengthDelimitedPayload(field)?.byteLength ?? field.data.byteLength), 0);
    this.observeUnknown(location, context);
    if (context.env) this.observeUnknown(`${location}.env`, context.env);
  }

  private observeParts(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const tag = readVarint(bytes, offset);
      offset = tag.offset;
      const fieldNo = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 7n);
      if (wireType === 2) {
        const length = readVarint(bytes, offset);
        offset = length.offset;
        const end = offset + Number(length.value);
        if (end > bytes.byteLength) throw new Error("truncated request context parts");
        const value = bytes.subarray(offset, end);
        const kind: ContextPartKind | undefined = fieldNo === 1 ? "rules"
          : fieldNo === 3 ? "skills"
            : fieldNo === 5 ? "subagents"
              : fieldNo === 7 ? "mcpTools"
                : undefined;
        if (kind) {
          this.contextPartByBlob.set(blobKey(value), kind);
          while (this.contextPartByBlob.size > MAX_BLOB_REFERENCES) {
            this.contextPartByBlob.delete(this.contextPartByBlob.keys().next().value!);
          }
        }
        if (fieldNo === 9) {
          this.dynamicContextCount++;
          this.observeRequestContext(fromBinary(RequestContextSchema, value, { readUnknownFields: true }), "requestContextParts.dynamicContext");
        }
        offset = end;
        continue;
      }
      if (wireType === 0) {
        const length = readVarint(bytes, offset);
        offset = length.offset;
        if (fieldNo === 2) this.ruleBytes += Number(length.value);
        if (fieldNo === 4) this.skillBytes += Number(length.value);
        if (fieldNo === 6) this.subagentBytes += Number(length.value);
        if (fieldNo === 8) this.mcpToolBytes += Number(length.value);
        continue;
      }
      throw new Error(`unsupported request context parts wire type ${wireType}`);
    }
  }

  private observeFetchedPart(kind: ContextPartKind, raw: Uint8Array): void {
    const part = normalizedPartBlob(raw);
    this.fetchedPartBytes[kind] += part.bytes.byteLength;
    this.fetchedPartCounts[kind] += part.fields.filter(field => field.no === 1 && field.wireType === 2).length;
  }

  private observeTool(kind: "started" | "partial" | "completed", call: ToolCall | undefined, argumentBytes: number): void {
    if (kind === "started") this.toolStarted++;
    if (kind === "partial") this.toolPartial++;
    if (kind === "completed") this.toolCompleted++;
    this.toolArgumentByteLength += argumentBytes;
    this.maxToolArgumentByteLength = Math.max(this.maxToolArgumentByteLength, argumentBytes);
    const name = toolName(call);
    if (name) this.toolNames.add(name);
  }

  private observeUnknown(location: string, message: Message): void {
    for (const field of message.$unknown ?? []) {
      const data = field.data;
      const hash = createHash("sha256").update(data).digest("hex");
      const key = `${location}:${field.no}:${field.wireType}:${data.byteLength}:${hash}`;
      const existing = this.unknown.get(key);
      if (existing) {
        existing.occurrences++;
        continue;
      }
      if (this.unknown.size >= MAX_UNKNOWN_SUMMARIES) continue;
      this.unknown.set(key, {
        location,
        fieldNo: field.no,
        wireType: field.wireType,
        byteLength: lengthDelimitedPayload(field)?.byteLength ?? field.data.byteLength,
        sha256: hash,
        occurrences: 1,
      });
      // Validate varint-shaped unknown fields without retaining their value.
      void varintUnknownValue(field);
    }
  }
}
