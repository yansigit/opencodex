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
  lastPreToolDigest?: string;
  lastPreToolTokenHashes?: ReadonlySet<string>;
  lastNarratedToolName?: string;
  lastNarratedToolOrdinal?: number;
  touchedAt: number;
}

const conversations = new Map<string, ConversationState>();
const outputHashes = new WeakMap<TurnProgressTelemetry, Hash>();
const commentaryText = new WeakMap<TurnProgressTelemetry, string>();
const MAX_COMMENTARY_FINGERPRINT_BYTES = 8_192;
export const MAX_GENERIC_PRE_TOOL_NARRATION_BYTES = 512;
export const MAX_PRE_TOOL_TEXT_GUARD_BYTES = MAX_GENERIC_PRE_TOOL_NARRATION_BYTES;
const GENERIC_PRE_TOOL_NARRATION = /^\s*(?:i(?:['’](?:ll|m)| will| am going to)|let me)\b/i;
const GENERIC_PRE_TOOL_PREFIXES = ["i'll", "i’ll", "i will", "i am going to", "i'm going to", "i’m going to", "let me"];
const NARRATION_STOP_WORDS = new Set(["i", "ll", "will", "am", "going", "to", "let", "me", "now", "once", "the", "a", "an", "with", "that", "this", "path", "then", "please"]);
const NARRATION_ACTION_WORDS = new Set(["call", "fetch", "read", "reader", "invoke", "use", "using"]);

function normalizedTextDigest(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase("en-US")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : undefined;
}

function narrationTokenHashes(value: string): ReadonlySet<string> {
  const tokens = value.toLocaleLowerCase("en-US").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens
    .filter(token => !NARRATION_STOP_WORDS.has(token))
    .map(token => NARRATION_ACTION_WORDS.has(token) ? "tool-action" : token)
    .map(token => createHash("sha256").update(token).digest("hex")));
}

function narrationsAreSimilar(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  const union = left.size + right.size - shared;
  const smaller = Math.min(left.size, right.size);
  return shared >= 2 && union > 0 && (shared / union >= 0.5 || shared / smaller >= 0.8);
}

function couldBeGenericNarration(value: string): boolean {
  const normalized = value.trimStart().toLocaleLowerCase("en-US");
  return GENERIC_PRE_TOOL_PREFIXES.some(prefix => prefix.startsWith(normalized) || normalized.startsWith(prefix));
}

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
      preToolTextBytes: 0,
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
        if (telemetry.toolCallsStarted === 0) telemetry.preToolTextBytes += bytes;
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

/**
 * Cursor external models sometimes label tool preambles as ordinary final text. Hold only the
 * bounded leading text until the first tool call proves that it is narration. A normalized repeat
 * of the previous tool round is discarded; unique text and text-only answers remain byte-exact.
 */
export function guardRepeatedPreToolText(
  events: AsyncIterable<AdapterEvent>,
  key: string,
  telemetry: TurnProgressTelemetry,
): AsyncIterable<AdapterEvent> {
  const state = conversations.get(key);
  if (!state) return events;
  return (async function* () {
    let pending: AdapterEvent[] = [];
    let pendingText = "";
    let pendingTextBytes = 0;
    let decided = false;
    const priorNarrationIsRecent = state.lastNarratedToolOrdinal !== undefined
      && telemetry.logicalCallOrdinal - state.lastNarratedToolOrdinal <= 2;
    const buffering = priorNarrationIsRecent;
    let observedLeadingText = "";
    let observedLeadingBytes = 0;

    const flushPending = function* (includeText: boolean): Generator<AdapterEvent> {
      for (const event of pending) {
        if (includeText || event.type !== "text_delta") yield event;
      }
      pending = [];
      pendingText = "";
      pendingTextBytes = 0;
    };

    for await (const event of events) {
      if (decided) {
        yield event;
        continue;
      }
      if (event.type === "text_delta") {
        const bytes = Buffer.byteLength(event.text);
        if (!buffering) {
          const candidate = observedLeadingText + event.text;
          if (observedLeadingBytes + bytes <= MAX_PRE_TOOL_TEXT_GUARD_BYTES
            && !candidate.includes("\n")
            && couldBeGenericNarration(candidate)) {
            observedLeadingText = candidate;
            observedLeadingBytes += bytes;
          } else {
            observedLeadingText = "";
            observedLeadingBytes = MAX_PRE_TOOL_TEXT_GUARD_BYTES + 1;
          }
          yield event;
          continue;
        }
        const candidate = pendingText + event.text;
        if (pendingTextBytes + bytes > MAX_PRE_TOOL_TEXT_GUARD_BYTES
          || candidate.includes("\n")
          || !couldBeGenericNarration(candidate)) {
          yield* flushPending(true);
          decided = true;
          yield event;
          continue;
        }
        pending.push(event);
        pendingText += event.text;
        pendingTextBytes += bytes;
        continue;
      }
      if (event.type === "tool_call_start") {
        const narration = buffering ? pendingText : observedLeadingText;
        const narrationBytes = buffering ? pendingTextBytes : observedLeadingBytes;
        if (narrationBytes > 0 && narrationBytes <= MAX_PRE_TOOL_TEXT_GUARD_BYTES) {
          const digest = normalizedTextDigest(narration);
          const normalizedRepeat = digest !== undefined && digest === state.lastPreToolDigest;
          const genericNarration = !narration.includes("\n") && GENERIC_PRE_TOOL_NARRATION.test(narration);
          const tokenHashes = narrationTokenHashes(narration);
          const repeatedNarration = buffering
            && genericNarration
            && state.lastNarratedToolName === event.name
            && !!state.lastPreToolTokenHashes
            && narrationsAreSimilar(tokenHashes, state.lastPreToolTokenHashes);
          const repeated = buffering && (normalizedRepeat || repeatedNarration);
          telemetry.normalizedPreToolTextRepeat = normalizedRepeat;
          telemetry.repeatedPreToolNarration = repeatedNarration;
          if (genericNarration && digest) {
            state.lastPreToolDigest = digest;
            state.lastPreToolTokenHashes = tokenHashes;
            state.lastNarratedToolName = event.name;
            state.lastNarratedToolOrdinal = telemetry.logicalCallOrdinal;
          }
          if (repeated) telemetry.suppressedRepeatedPreToolText = true;
          if (buffering) yield* flushPending(!repeated);
        }
        if (buffering && pending.length > 0) yield* flushPending(true);
        decided = true;
        yield event;
        continue;
      }
      if (event.type === "heartbeat") {
        if (buffering) pending.push(event);
        else yield event;
        continue;
      }
      if (pendingTextBytes > 0) {
        yield* flushPending(true);
        decided = true;
      }
      yield event;
      if (event.type === "done" || event.type === "incomplete" || event.type === "error") decided = true;
    }
    if (pending.length > 0) yield* flushPending(true);
  })();
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
  if (telemetry.toolCallsStarted === 0) telemetry.preToolTextBytes = 0;
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
    const digest = normalizedTextDigest(commentary);
    if (digest) {
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
