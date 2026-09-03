import { createHash, createHmac, randomBytes, type Hash } from "node:crypto";
import type { AdapterEvent } from "../types/request";
import type { TurnProgressTelemetry } from "../types/progress";

export type { TurnProgressTelemetry } from "../types/progress";

export const CURSOR_429_STORM_THRESHOLD = 3;
export const CURSOR_429_STORM_WINDOW_MS = 45_000;
export const CURSOR_429_STORM_COOLDOWN_MS = 30_000;

const MAX_TRACKED_TURNS = 4_096;
const PROCESS_KEY = randomBytes(32);

interface ConversationState {
  logicalCalls: number;
  consecutive429s: number;
  last429At: number;
  circuitUntil: number;
  logicalCallsSinceToolCompletion: number;
  lastOutputDigest?: string;
  lastCommentaryDigest?: string;
  touchedAt: number;
}

const conversations = new Map<string, ConversationState>();
const outputHashes = new WeakMap<TurnProgressTelemetry, Hash>();
const commentaryText = new WeakMap<TurnProgressTelemetry, string>();
const MAX_COMMENTARY_FINGERPRINT_BYTES = 8_192;

function scopedKey(conversationId: string, provider: string, model: string): string {
  return createHmac("sha256", PROCESS_KEY)
    .update(conversationId)
    .update("\0")
    .update(provider)
    .update("\0")
    .update(model)
    .digest("hex");
}

function prune(now: number): void {
  if (conversations.size < MAX_TRACKED_TURNS) return;
  const staleBefore = now - Math.max(CURSOR_429_STORM_WINDOW_MS, CURSOR_429_STORM_COOLDOWN_MS) * 4;
  for (const [key, state] of conversations) {
    if (state.touchedAt < staleBefore) conversations.delete(key);
  }
  while (conversations.size >= MAX_TRACKED_TURNS) {
    const oldest = conversations.keys().next().value as string | undefined;
    if (!oldest) break;
    conversations.delete(oldest);
  }
}

export interface BegunConversationTurn {
  key: string;
  telemetry: TurnProgressTelemetry;
  retryAfterSeconds?: number;
}

export function beginConversationTurn(
  conversationId: string,
  provider: string,
  model: string,
  now = Date.now(),
): BegunConversationTurn {
  prune(now);
  const key = scopedKey(conversationId, provider, model);
  let state = conversations.get(key);
  if (!state) {
    state = {
      logicalCalls: 0,
      consecutive429s: 0,
      last429At: 0,
      circuitUntil: 0,
      logicalCallsSinceToolCompletion: 0,
      touchedAt: now,
    };
    conversations.set(key, state);
  } else {
    conversations.delete(key);
    conversations.set(key, state);
  }
  if (now - state.last429At > CURSOR_429_STORM_WINDOW_MS) {
    state.consecutive429s = 0;
    state.circuitUntil = 0;
  }
  state.logicalCalls++;
  state.logicalCallsSinceToolCompletion++;
  state.touchedAt = now;
  const circuitOpen = state.consecutive429s >= CURSOR_429_STORM_THRESHOLD && now < state.circuitUntil;
  return {
    key,
    telemetry: {
      logicalCallOrdinal: state.logicalCalls,
      consecutive429sBeforeCall: state.consecutive429s,
      logicalCallsSinceToolCompletion: state.logicalCallsSinceToolCompletion,
      textDeltaCount: 0,
      textBytes: 0,
      commentaryTextBytes: 0,
      finalTextBytes: 0,
      thinkingDeltaCount: 0,
      toolCallsStarted: 0,
      toolCallsCompleted: 0,
      assistantBoundaries: 0,
      terminalEvents: 0,
      ...(circuitOpen ? { rateLimitCircuitOpen: true } : {}),
    },
    ...(circuitOpen ? { retryAfterSeconds: Math.max(1, Math.ceil((state.circuitUntil - now) / 1_000)) } : {}),
  };
}

export function observeTurnProgress(telemetry: TurnProgressTelemetry, event: AdapterEvent): void {
  switch (event.type) {
    case "text_delta":
      telemetry.textDeltaCount++;
      {
        const bytes = Buffer.byteLength(event.text);
        telemetry.textBytes += bytes;
        if (event.phase === "commentary") {
          telemetry.commentaryTextBytes += bytes;
          const prior = commentaryText.get(telemetry) ?? "";
          if (Buffer.byteLength(prior) < MAX_COMMENTARY_FINGERPRINT_BYTES) {
            commentaryText.set(telemetry, `${prior}${event.text}`.slice(0, MAX_COMMENTARY_FINGERPRINT_BYTES));
          }
        } else {
          telemetry.finalTextBytes += bytes;
        }
      }
      (outputHashes.get(telemetry) ?? (() => {
        const hash = createHash("sha256");
        outputHashes.set(telemetry, hash);
        return hash;
      })()).update(event.text);
      return;
    case "thinking_delta":
    case "reasoning_raw_delta":
      telemetry.thinkingDeltaCount++;
      return;
    case "tool_call_start":
      telemetry.toolCallsStarted++;
      return;
    case "tool_call_end":
      telemetry.toolCallsCompleted++;
      return;
    case "assistant_boundary":
      telemetry.assistantBoundaries++;
      return;
    case "done":
    case "incomplete":
    case "error":
      telemetry.terminalEvents++;
      return;
    default:
      return;
  }
}

export function finishConversationTurn(
  key: string,
  telemetry: TurnProgressTelemetry,
  status: number,
  options: { circuitBlocked?: boolean; now?: number } = {},
): void {
  const state = conversations.get(key);
  if (!state) return;
  const now = options.now ?? Date.now();
  state.touchedAt = now;
  if (telemetry.toolCallsCompleted > 0) state.logicalCallsSinceToolCompletion = 0;
  telemetry.commentaryOnlyRound = telemetry.commentaryTextBytes > 0
    && telemetry.finalTextBytes === 0
    && telemetry.toolCallsCompleted === 0;
  telemetry.emptyProtocolRound = telemetry.textBytes === 0 && telemetry.toolCallsCompleted === 0;
  const outputHash = outputHashes.get(telemetry);
  if (outputHash) {
    const outputDigest = outputHash.digest("hex");
    outputHashes.delete(telemetry);
    telemetry.exactOutputRepeat = outputDigest === state.lastOutputDigest;
    state.lastOutputDigest = outputDigest;
  }
  const commentary = commentaryText.get(telemetry);
  if (commentary) {
    commentaryText.delete(telemetry);
    const normalized = commentary.toLocaleLowerCase("en-US")
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (normalized) {
      const digest = createHash("sha256").update(normalized).digest("hex");
      telemetry.normalizedCommentaryRepeat = digest === state.lastCommentaryDigest;
      state.lastCommentaryDigest = digest;
    }
  }
  if (options.circuitBlocked) return;
  if (status === 429) {
    state.consecutive429s = now - state.last429At <= CURSOR_429_STORM_WINDOW_MS
      ? state.consecutive429s + 1
      : 1;
    state.last429At = now;
    if (state.consecutive429s >= CURSOR_429_STORM_THRESHOLD) {
      state.circuitUntil = now + CURSOR_429_STORM_COOLDOWN_MS;
    }
  } else {
    state.consecutive429s = 0;
    state.circuitUntil = 0;
  }
}

export function clearConversationProgressForTests(): void {
  conversations.clear();
}
