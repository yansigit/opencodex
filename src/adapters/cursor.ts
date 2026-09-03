import { createHash } from "node:crypto";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { cursorExecDeniedMessage, cursorRequestDeclaresFullAccess } from "./cursor/exec-policy";
import { isCursorBenignCancelError, isCursorInvalidArgumentError, isCursorOverflowRemintCandidate, isCursorRootEnvelopeError, safeCursorErrorMessage, type CursorSizeContext } from "./cursor/cursor-errors";
import { cursorCheckpointModelAffinityId, inferCursorContextWindow, isCursorExternalWireModel } from "./cursor/discovery";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import {
  createCursorRequest,
  cursorClientThreadOwner,
  cursorCoveredPrefixDigest,
  cursorInstructionDigest,
  cursorRequestEmitsFastVariant,
} from "./cursor/request-builder";
import {
  createLiveCursorTransport,
  CursorMissingCredentialError,
  rekeyCursorContextUsage,
  resolveCursorToken,
  capturedCursorCheckpointBytes,
} from "./cursor/live-transport";
import {
  commitCursorCheckpoint,
  cursorCheckpointRefHash,
  invalidateCursorCheckpoint,
} from "./cursor/checkpoint-store";
import { debugProviderDiagnostic } from "../lib/debug";
import { createAdapterTierMetadata } from "../providers/fastwire";
import { estimateTokens } from "../lib/token-estimate";
import {
  cursorOverflowRemintScopeKey,
  markCursorOverflowSurfaced,
  recordCursorOverflowRemint,
  rememberCursorThreadConversation,
  shouldSkipCursorOverflowRemint,
  shouldSurfaceCursorOverflowFirst,
} from "./cursor/thread-continuity";
import { runCursorTurnWithRetry } from "./cursor/transport-retry";
import { cursorRequestHasShellAlias, cursorRequestUsesCodeMode } from "./cursor/tool-definitions";
import {
  CURSOR_DUPLICATE_TOOL_RETRY_CONTINUATION_TEXT,
  CURSOR_ECHO_RETRY_CONTINUATION_TEXT,
  CURSOR_ROUTING_COMMENTARY_RETRY_TEXT,
  CursorDuplicateCompletedToolCallError,
  CursorEnvelopeEchoGuard,
  CursorReplayEnvelopeDetectedError,
  CursorRoutingCommentaryError,
  CursorRoutingCommentarySniffer,
  CursorToolResultEchoError,
} from "./cursor/envelope-echo";
import { CursorTerminalTokenSanitizer } from "./cursor/terminal-token";
import {
  createDisabledCursorTransport,
  CursorTransportDisabledError,
  type CursorTransportFactory,
} from "./cursor/transport";

export const CURSOR_API_URL = "https://api2.cursor.sh";

export {
  CURSOR_EXEC_CASES_DENIED,
  cursorExecDeniedMessage,
  type CursorDeniedExecCase,
} from "./cursor/exec-policy";

const CURSOR_TRANSPORT_DISABLED_MESSAGE = [
  "An explicit disabled Cursor transport was injected.",
  "Production Cursor requests use live transport when a Cursor access token is configured.",
].join(" ");

export interface CursorAdapterDeps {
  createTransport?: CursorTransportFactory;
  kv?: CursorKvStore;
  /** Test seam: observe/replace context-usage rekeying on conversation-id rotation. */
  rekeyContextUsage?: (fromConversationId: string, toConversationId: string) => void;
}

function canonicalToolArguments(value: unknown): string | undefined {
  const seen = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) throw new TypeError("cyclic tool arguments");
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(normalize);
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    } finally {
      seen.delete(candidate);
    }
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return undefined;
  }
}

function latestSuccessfulToolInvocations(parsed: OcxParsedRequest): Array<{ name: string; arguments: string }> {
  const results = [];
  for (let index = parsed.context.messages.length - 1; index >= 0; index--) {
    const message = parsed.context.messages[index];
    if (message?.role !== "toolResult") break;
    if (!message.isError) results.push(message);
  }
  if (results.length === 0) return [];

  const invocations: Array<{ name: string; arguments: string }> = [];
  for (const result of results) {
    for (let index = parsed.context.messages.length - results.length - 1; index >= 0; index--) {
      const message = parsed.context.messages[index];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const call = message.content.find(part => part.type === "toolCall" && part.id === result.toolCallId);
      if (call?.type !== "toolCall") continue;
      const serialized = canonicalToolArguments(call.arguments);
      if (serialized !== undefined) {
        invocations.push({ name: namespacedToolName(call.namespace, call.name), arguments: serialized });
      }
      break;
    }
  }
  return invocations;
}

function safeCursorTransportError(err: unknown, sizeContext?: CursorSizeContext): string {
  if (err instanceof CursorTransportDisabledError) return CURSOR_TRANSPORT_DISABLED_MESSAGE;
  if (err instanceof CursorMissingCredentialError) {
    return "Cursor live transport is enabled, but no Cursor access token is configured. Set provider.apiKey or OPENCODEX_CURSOR_TEST_TOKEN.";
  }
  // A locally raised envelope rejection is already safe, specific, and actionable: it was composed
  // here from our own measurements and contains no upstream text. Passing it through
  // `safeCursorErrorMessage` would collapse it to the bare label "Cursor invalid request" (it
  // matches the "invalid"/"exceeds" keyword branch) and discard the counts that tell the operator
  // which limit was hit and by how much.
  if (isCursorRootEnvelopeError(err)) {
    return err instanceof Error ? `Cursor invalid request: ${err.message}` : "Cursor invalid request";
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (message) return safeCursorErrorMessage(message, sizeContext);
  return "Cursor upstream error: transport failed before completion.";
}

/**
 * Size prior for bare resource_exhausted classification (devlog 260): a rough input
 * estimate over the outgoing text vs the model's context window. Only used to keep
 * SMALL requests on the 429 class — unknown/large stays on the overflow mapping.
 */
function cursorRequestSizeContext(request: { modelId: string; system: string[]; messages: { content: string }[] }): CursorSizeContext {
  const text = [...request.system, ...request.messages.map(message => message.content)].join("\n");
  return {
    estimatedInputTokens: estimateTokens(text, request.modelId),
    contextWindow: inferCursorContextWindow(request.modelId),
  };
}

function assertCursorRequestSupported(parsed: OcxParsedRequest): void {
  if (parsed.options.textFormat !== undefined || parsed._structuredOutput === true) {
    throw new Error("Cursor does not support structured output");
  }
}

export function createCursorAdapter(provider: OcxProviderConfig, deps: CursorAdapterDeps = {}): ProviderAdapter {
  return {
    name: "cursor",

    validateRequest: assertCursorRequestSupported,

    // Cursor emits Fast as a model variant, so the generic "no field emitted" fallback in
    // adapters/registry.ts would report every Fast turn as downgraded. This recomputes the
    // variant from the same pure inputs the builder uses: tierLogForRunTurn runs BEFORE
    // runTurn, and createCursorRequest mints conversation ids, so rebuilding it here would
    // describe a request that was never sent.
    tierLogForRunTurn(parsed) {
      const fast = cursorRequestEmitsFastVariant(parsed);
      return createAdapterTierMetadata(
        parsed.options.tierObservation,
        parsed.options.tierDecision,
        fast ? "cursor-variant" : null,
        fast ? "fast" : null,
      );
    },

    buildRequest() {
      return {
        url: provider.baseUrl || CURSOR_API_URL,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Cursor adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(_parsed, incoming, emit) {
      assertCursorRequestSupported(_parsed);
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Cursor turn was aborted before start." });
        return;
      }
      // Captured after createCursorRequest so the catch block can apply the bare-RE
      // size prior (devlog 260) even though `request` is scoped inside the try.
      let requestSizeContext: CursorSizeContext | undefined;
      let diagnosticRequest: { modelId: string; conversationId: string } | undefined;
      try {
        const makeTransport = deps.createTransport ?? createLiveCursorTransport;
        const kv = deps.kv ?? createCursorKvStore({}, incoming.translatorBudget);
        const rekeyContextUsage = deps.rekeyContextUsage ?? rekeyCursorContextUsage;
        // Namespace thread→conversation derivation by the authenticated Cursor credential so
        // shared-proxy tenants with different Cursor accounts cannot collide on a parent thread id.
        // Prefer an already-set auth scope (e.g. Codex pool account) when present.
        if (!_parsed._cursorIdentityScope) {
          try {
            const token = resolveCursorToken(provider, incoming.headers);
            _parsed._cursorIdentityScope = createHash("sha256")
              .update("ocx:cursor:acct:")
              .update(token)
              .digest("hex")
              .slice(0, 16);
          } catch {
            /* Missing credential is handled by the live transport path below. */
          }
        }
        const inheritedCheckpointRef = _parsed._providerContinuation?.cursor?.checkpointRef;
        const previousConversationId = _parsed._cursorConversationId;
        let request = createCursorRequest(_parsed);
        requestSizeContext = cursorRequestSizeContext(request);
        // The builder may derive a stable provider id from the client thread when Responses state
        // is unavailable. Rekey only existing state; there is nothing to migrate on a fresh turn,
        // and isolated helper/compaction turns must never inherit or donate the parent's usage state.
        if (
          previousConversationId
          && request.conversationId !== previousConversationId
          && _parsed._cursorIsolateConversation !== true
        ) {
          rekeyContextUsage(previousConversationId, request.conversationId);
        }
        _parsed._cursorConversationId = request.conversationId;
        let emittedOutput = false;
        let replayUnsafe = false;
        const lastRawIsToolResult = _parsed.context.messages.at(-1)?.role === "toolResult";
        let completedNormally = false;
        let lastTransport: { captured?: Uint8Array } | undefined;
        let emittedClientTool = false;
        // Ordering proof for tool-suspended checkpoints: true only when the newest captured
        // checkpoint bytes arrived AFTER the turn emitted a client tool call, i.e. upstream
        // serialized its suspended-on-tool-call state. Only that snapshot can safely resume
        // with the covered-prefix + trailing-toolResult path (devlog 260826 050).
        let capturedAfterClientTool = false;

        const commitCapturedCheckpoint = (activeRequest: ReturnType<typeof createCursorRequest>): void => {
          const toolSuspendedCommit =
            emittedClientTool
            && capturedAfterClientTool
            && isCursorExternalWireModel(activeRequest.modelId);
          if (
            replayUnsafe
            || (emittedClientTool && !toolSuspendedCommit)
            || activeRequest.contextUsageStoreCheckpoints === false
            || !lastTransport?.captured
            || lastTransport.captured.byteLength === 0
          ) {
            // Refusal diagnostics (devlog 260826 050/080): name the exact guard so a live
            // missing_ref chain can be attributed without instrumented rebuilds.
            debugProviderDiagnostic("cursor", "checkpoint-commit-refused", {
              replayUnsafe,
              emittedClientTool,
              capturedAfterClientTool,
              externalModel: isCursorExternalWireModel(activeRequest.modelId),
              storeCheckpoints: activeRequest.contextUsageStoreCheckpoints !== false,
              capturedBytes: lastTransport?.captured?.byteLength ?? 0,
            });
            return;
          }
          const previousRef = _parsed._providerContinuation?.cursor?.checkpointRef;
          const coveredMessageCount = _parsed.context.messages.length;
          const checkpointRef = commitCursorCheckpoint({
            conversationId: activeRequest.conversationId,
            identityScope: _parsed._cursorIdentityScope,
            modelId: cursorCheckpointModelAffinityId(activeRequest.modelId),
            checkpointBytes: lastTransport.captured,
            coveredMessageCount,
            prefixDigest: cursorCoveredPrefixDigest(_parsed, coveredMessageCount),
            systemDigest: cursorInstructionDigest(_parsed),
          });
          if (!checkpointRef) return;
          if (previousRef && previousRef !== checkpointRef) invalidateCursorCheckpoint(previousRef);
          _parsed._providerContinuation = {
            ...(_parsed._providerContinuation ?? {}),
            cursor: {
              ...(_parsed._providerContinuation?.cursor ?? {}),
              conversationId: activeRequest.conversationId,
              // A tool-suspended checkpoint is only usable by the immediate trailing-toolResult
              // continuation; the request-builder guard keys on checkpointUsable=false for that.
              checkpointUsable: !toolSuspendedCommit,
              checkpointRef,
            },
          };
          debugProviderDiagnostic("cursor", "checkpoint-continuation", {
            mode: activeRequest.continuationMode ?? "full-replay",
            conversationHash: activeRequest.conversationId.slice(0, 16),
            checkpointRefHash: cursorCheckpointRefHash(checkpointRef),
            checkpointBytes: lastTransport.captured.byteLength,
            wireModel: activeRequest.modelId,
            ...(toolSuspendedCommit ? { toolSuspended: true } : {}),
          });
        };

        const runOnce = async (activeRequest: ReturnType<typeof createCursorRequest>) => {
          diagnosticRequest = activeRequest;
          const effort = _parsed.options.reasoning;
          const isHeavyReasoning = effort === "high"
            || effort === "max"
            || effort === "xhigh"
            || activeRequest.modelId.includes("grok-4.6")
            || activeRequest.modelId.includes("kimi-k3")
            || activeRequest.modelId.includes("opus-4-8");
          const heartbeatOnlyMs = isHeavyReasoning ? 300_000 : 180_000;
          // Envelope echo quarantine (devlog 260826 gap-10): external full-replay continuations
          // whose trailing input is a tool result sometimes ECHO the replayed "[Tool Result]"
          // envelope as assistant text (kimi-k3 ~30-40% of multi-round probes). Hold the first
          // text deltas until they provably diverge from the markers; a completed marker turns
          // the turn into a retryable semantic failure BEFORE any client-visible delta escapes.
          // Armed for ANY external turn whose replayed history contains a tool result — echo
          // priming was observed live on user-action rounds too (the envelope lives in the
          // flattened history regardless of which role ends the input).
          const armEchoSniffer =
            isCursorExternalWireModel(activeRequest.modelId)
            && (_parsed.context.messages ?? []).some(message => message.role === "toolResult");
          const echoGuard = armEchoSniffer ? new CursorEnvelopeEchoGuard() : undefined;
          const terminalSanitizer = isCursorExternalWireModel(activeRequest.modelId)
            ? new CursorTerminalTokenSanitizer()
            : undefined;
          const completedInvocations = isCursorExternalWireModel(activeRequest.modelId)
            ? latestSuccessfulToolInvocations(_parsed)
            : [];
          let duplicateToolCandidate: { events: AdapterEvent[]; name: string; arguments: string } | undefined;
          const armRoutingCommentarySniffer =
            isCursorExternalWireModel(activeRequest.modelId)
            && (
              cursorRequestUsesCodeMode(activeRequest.tools, activeRequest.toolChoice)
              || cursorRequestHasShellAlias(activeRequest.tools)
            );
          const routingCommentarySniffer = armRoutingCommentarySniffer
            ? new CursorRoutingCommentarySniffer()
            : undefined;
          let guardHeld: AdapterEvent[] = [];
          const emitTextObserved = (event: AdapterEvent): void => emit(event);
          const releaseGuardHeld = () => {
            for (const held of guardHeld) {
              if (held.type !== "heartbeat") emittedOutput = true;
              emitTextObserved(held);
            }
            guardHeld = [];
          };
          const guardsSettled = () => !routingCommentarySniffer || routingCommentarySniffer.settled;
          const handleRoutedText = (safe: string, phase?: Extract<AdapterEvent, { type: "text_delta" }>["phase"]): void => {
            if (!safe) return;
            const event: Extract<AdapterEvent, { type: "text_delta" }> = { type: "text_delta", text: safe, ...(phase ? { phase } : {}) };
            if (!guardsSettled()) {
              guardHeld.push(event);
              const decision = routingCommentarySniffer!.feed(safe);
              if (decision.kind === "hallucination") {
                guardHeld = [];
                throw new CursorRoutingCommentaryError();
              }
              if (guardsSettled()) releaseGuardHeld();
              return;
            }
            emittedOutput = true;
            emitTextObserved(event);
          };
          const handleText = (text: string, phase?: Extract<AdapterEvent, { type: "text_delta" }>["phase"]): void => {
            let envelopeSafe: string;
            try {
              envelopeSafe = echoGuard?.feed(text) ?? text;
            } catch (error) {
              handleRoutedText(terminalSanitizer?.flush(false) ?? "", phase);
              throw error;
            }
            handleRoutedText(terminalSanitizer?.feed(envelopeSafe) ?? envelopeSafe, phase);
          };
          const finishTextGuards = (terminal: boolean): void => {
            const envelopeTail = echoGuard?.finish() ?? "";
            const sanitizedTail = terminalSanitizer
              ? terminalSanitizer.feed(envelopeTail) + terminalSanitizer.flush(terminal)
              : envelopeTail;
            handleRoutedText(sanitizedTail);
          };
          await runCursorTurnWithRetry(
            makeTransport,
            {
              provider,
              headers: incoming.headers,
              translatorBudget: incoming.translatorBudget,
              requestDeclaresFullAccess: cursorRequestDeclaresFullAccess(activeRequest),
              sessionId: activeRequest.conversationId,
              streamHeartbeatOnlyFailMs: heartbeatOnlyMs,
              ...(incoming.providerFetch ? { fetch: incoming.providerFetch } : {}),
            },
            activeRequest,
            incoming.abortSignal,
            (message, activeTransport) => {
              if (incoming.abortSignal?.aborted) {
                emit({ type: "error", message: "Cursor turn was aborted." });
                return;
              }
              if (message.type === "local_side_effect") replayUnsafe = true;
              if (message.type === "done") completedNormally = true;
              const captureAfterEvents = (): void => {
                const captured = capturedCursorCheckpointBytes(activeTransport);
                if (!captured) return;
                if (captured !== lastTransport?.captured) capturedAfterClientTool = emittedClientTool;
                lastTransport = { captured };
              };
              const events = mapCursorServerMessage(message, {
                kv,
                writeClient: clientMessage => {
                  void activeTransport.writeClient(clientMessage);
                },
              });
              // A done event commits the latest checkpoint while it is processed, so sample the
              // transport first. Tool completion is sampled after admission below: that ordering
              // distinguishes an actually emitted tool from a quarantined duplicate candidate.
              if (message.type === "done") captureAfterEvents();
              const processEvent = (event: AdapterEvent): void => {
                if (event.type === "text_delta") {
                  handleText(event.text, event.phase);
                  return;
                }
                if (event.type !== "thinking_delta" && event.type !== "heartbeat") {
                  finishTextGuards(event.type === "done");
                }
                if (!guardsSettled()) {
                  if (event.type === "thinking_delta" || event.type === "heartbeat") {
                    // Reasoning before first text stays ordered; liveness still passes through.
                    if (event.type === "thinking_delta") {
                      guardHeld.push(event);
                      return;
                    }
                  } else {
                    const routingDecision = routingCommentarySniffer?.finish();
                    if (routingDecision?.kind === "hallucination") {
                      guardHeld = [];
                      throw new CursorRoutingCommentaryError();
                    }
                    releaseGuardHeld();
                  }
                }
                if (event.type !== "heartbeat") emittedOutput = true;
                if (event.type === "tool_call_end") emittedClientTool = true;
                if (event.type === "done") {
                  commitCapturedCheckpoint(activeRequest);
                  const inheritedCursor = _parsed._providerContinuation?.cursor;
                  const isolatedOrCompaction =
                    _parsed._cursorIsolateConversation === true
                    || activeRequest.contextUsageStoreCheckpoints === false;
                  const providerState = inheritedCursor
                    ? {
                        cursor: isolatedOrCompaction
                          ? {
                              conversationId: activeRequest.conversationId,
                              ...(inheritedCursor.checkpointUsable !== undefined
                                ? { checkpointUsable: inheritedCursor.checkpointUsable }
                                : {}),
                            }
                          : { ...inheritedCursor, conversationId: activeRequest.conversationId },
                      }
                    : undefined;
                  emit(providerState ? { ...event, providerState } : event);
                } else {
                  emitTextObserved(event);
                }
              };
              if (
                message.type === "tool_call_start"
                && completedInvocations.some(invocation => message.name === invocation.name)
              ) {
                duplicateToolCandidate = { events: [...events], name: message.name, arguments: "" };
                captureAfterEvents();
                return;
              }
              if (duplicateToolCandidate) {
                duplicateToolCandidate.events.push(...events);
                if (message.type === "tool_call_delta") {
                  duplicateToolCandidate.arguments += message.arguments;
                  captureAfterEvents();
                  return;
                }
                if (message.type === "tool_call_end") {
                  let currentArguments: string | undefined;
                  try {
                    currentArguments = canonicalToolArguments(
                      JSON.parse(duplicateToolCandidate.arguments.trim() || "{}"),
                    );
                  } catch {
                    currentArguments = undefined;
                  }
                  if (completedInvocations.some(invocation =>
                    invocation.name === duplicateToolCandidate?.name && invocation.arguments === currentArguments
                  )) {
                    duplicateToolCandidate = undefined;
                    throw new CursorDuplicateCompletedToolCallError();
                  }
                }
                const held = duplicateToolCandidate.events;
                duplicateToolCandidate = undefined;
                for (const heldEvent of held) processEvent(heldEvent);
                captureAfterEvents();
                return;
              }
              for (const event of events) processEvent(event);
              captureAfterEvents();
            },
            {
              enabled: incoming.replayTransientFailures === true,
              replayBudget: incoming.replayBudget,
              onRetry: recovery => incoming.onAdapterRetry?.(recovery),
            },
          );
          // A successful transport EOF is also a terminal boundary. Normally Cursor emits
          // `done`, making this a no-op; this additionally flushes an incomplete candidate
          // unchanged and strips a complete terminal-only token on a clean bare EOF.
          finishTextGuards(true);
        };

        const overflowRemintBaseId = _parsed._clientThreadId
          ? undefined
          : (previousConversationId ?? _parsed._cursorConversationId);

        const remintConversationId = (failedConversationId: string) => {
          lastTransport = undefined;
          _parsed._cursorConversationId = undefined;
          const next = createCursorRequest(_parsed, { forceFreshConversation: true });
          rekeyContextUsage(failedConversationId, next.conversationId);
          _parsed._cursorConversationId = next.conversationId;
          const threadOwner = cursorClientThreadOwner(_parsed);
          if (threadOwner && _parsed._cursorIsolateConversation !== true) {
            rememberCursorThreadConversation(
              threadOwner,
              next.conversationId,
              _parsed._cursorIdentityScope,
            );
          }
          return next;
        };
        const claimAdapterRetry = (kind: import("../usage/log").AttemptRecoveryKind): boolean => {
          if (incoming.replayBudget && incoming.replayBudget.remaining <= 0) return false;
          if (incoming.replayBudget) incoming.replayBudget.remaining -= 1;
          incoming.onAdapterRetry?.(kind);
          return true;
        };

        for (;;) {
          try {
            await runOnce(request);
            break;
          } catch (err) {
          const outputGuardRetryText =
            err instanceof CursorToolResultEchoError
              ? CURSOR_ECHO_RETRY_CONTINUATION_TEXT
              : err instanceof CursorDuplicateCompletedToolCallError
                ? CURSOR_DUPLICATE_TOOL_RETRY_CONTINUATION_TEXT
              : err instanceof CursorRoutingCommentaryError
                ? CURSOR_ROUTING_COMMENTARY_RETRY_TEXT
                : undefined;
          // One-shot corrective retry for guarded external output (devlog 260826 gap-10/11).
          // The quarantine guarantees no client-visible delta escaped, so a fresh-conversation
          // retry is safe. A second rejection propagates as an error rather than looping.
          if (
            outputGuardRetryText
            && !emittedOutput
            && !replayUnsafe
            && !incoming.abortSignal?.aborted
            && claimAdapterRetry(
              err instanceof CursorToolResultEchoError
                ? "cursor-envelope-echo"
                : err instanceof CursorDuplicateCompletedToolCallError
                  ? "cursor-duplicate-tool-call"
                  : "cursor-routing-commentary",
            )
          ) {
            debugProviderDiagnostic(
              "cursor",
              err instanceof CursorToolResultEchoError
                ? "envelope-echo-retry"
                : err instanceof CursorDuplicateCompletedToolCallError
                  ? "duplicate-tool-call-retry"
                : "routing-commentary-retry",
              {
              wireModel: request.modelId,
              conversationHash: cursorCheckpointRefHash(request.conversationId),
              ...(err instanceof CursorToolResultEchoError
                ? { dialect: err.dialect, offset: err.offset }
                : {}),
              },
            );
            const echoedConversationId = request.conversationId;
            lastTransport = undefined;
            _parsed._cursorConversationId = undefined;
            request = {
              ...createCursorRequest(_parsed, { forceFreshConversation: true }),
              echoRetryContinuationText: outputGuardRetryText,
            };
            rekeyContextUsage(echoedConversationId, request.conversationId);
            _parsed._cursorConversationId = request.conversationId;
            const echoThreadOwner = cursorClientThreadOwner(_parsed);
            if (echoThreadOwner && _parsed._cursorIsolateConversation !== true) {
              rememberCursorThreadConversation(
                echoThreadOwner,
                request.conversationId,
                _parsed._cursorIdentityScope,
              );
            }
            await runOnce(request);
            break;
          } else {
            const overflowRemintSafe =
              !lastRawIsToolResult
              && !emittedOutput
              && !replayUnsafe
              && request.contextUsageStoreCheckpoints !== false
              && !incoming.abortSignal?.aborted;
            const overflowScopeKey = cursorOverflowRemintScopeKey(
              _parsed,
              overflowRemintBaseId ?? request.conversationId,
            );
            if (
              overflowScopeKey
              && overflowRemintSafe
              && isCursorOverflowRemintCandidate(err, requestSizeContext)
            ) {
              if (shouldSkipCursorOverflowRemint(overflowScopeKey)) throw err;
              if (shouldSurfaceCursorOverflowFirst(overflowScopeKey)) {
                markCursorOverflowSurfaced(overflowScopeKey);
                throw err;
              }
              if (!recordCursorOverflowRemint(overflowScopeKey)) throw err;
              if (!claimAdapterRetry("cursor-overflow-remint")) throw err;
              if (inheritedCheckpointRef) invalidateCursorCheckpoint(inheritedCheckpointRef);
              request = remintConversationId(request.conversationId);
              continue;
            }

            // One-shot fallback for external-model Connect invalid_argument before any
            // non-heartbeat output. Retries apply only to safe plain-user turns; tool-result
            // resumes, local exec/MCP side effects, and already-emitted output fail closed.
            if (
              !isCursorInvalidArgumentError(err)
              || !isCursorExternalWireModel(request.modelId)
              || lastRawIsToolResult
              || emittedOutput
              || replayUnsafe
              || incoming.abortSignal?.aborted
            ) {
              throw err;
            }
            if (!claimAdapterRetry("cursor-invalid-argument")) throw err;
            request = remintConversationId(request.conversationId);
            await runOnce(request);
            break;
          }
        }
        }
        if (
          request.checkpointInvalidationReason
          && request.checkpointInvalidationReason !== "missing_ref"
        ) {
          invalidateCursorCheckpoint(inheritedCheckpointRef);
          debugProviderDiagnostic("cursor", "checkpoint-invalidated", {
            reason: request.checkpointInvalidationReason,
          });
        } else if (!completedNormally && request.checkpointInvalidationReason) {
          debugProviderDiagnostic("cursor", "checkpoint-invalidated", {
            reason: request.checkpointInvalidationReason,
          });
        }
        if (
          _parsed._cursorIsolateConversation === true
          || request.contextUsageStoreCheckpoints === false
        ) {
          const inherited = _parsed._providerContinuation?.cursor;
          if (inherited) {
            const { checkpointRef: _ignoredCheckpointRef, ...cursorWithoutCheckpointRef } = inherited;
            _parsed._providerContinuation = {
              ...(_parsed._providerContinuation ?? {}),
              cursor: cursorWithoutCheckpointRef,
            };
          }
        }
      } catch (err) {
        if (isCursorBenignCancelError(err)) return;
        if (err instanceof CursorReplayEnvelopeDetectedError) {
          debugProviderDiagnostic("cursor", "replay-envelope-detected", {
            wireModel: diagnosticRequest?.modelId ?? _parsed.modelId,
            ...(diagnosticRequest
              ? { conversationHash: cursorCheckpointRefHash(diagnosticRequest.conversationId) }
              : {}),
            dialect: err.dialect,
            offset: err.offset,
          });
        }
        const partialUsage = (err as { partialUsage?: import("../types").OcxUsage }).partialUsage;
        emit({
          type: "error",
          message: isTranslatorBudgetExceededError(err)
            ? "upstream translation buffer exceeded the safe limit"
            : safeCursorTransportError(err, requestSizeContext),
          ...(isTranslatorBudgetExceededError(err)
            ? { status: 502, errorType: "upstream_error", code: "translation_buffer_limit" }
            : {}),
          ...(err instanceof CursorReplayEnvelopeDetectedError
            ? { status: 502, errorType: "upstream_error", code: err.code, retryable: false }
            : {}),
          ...(err instanceof CursorDuplicateCompletedToolCallError
            ? { status: 502, errorType: "upstream_error", code: err.code, retryable: false }
            : {}),
          // A local envelope rejection is a client error with a stable code, and the caller needs
          // that code to distinguish "this conversation cannot be sent" from a transient upstream
          // fault. Without this the class was flattened to a bare message and the code was lost.
          ...(isCursorRootEnvelopeError(err)
            ? { status: 400, errorType: "invalid_request_error", code: "cursor_root_envelope_limit", retryable: false }
            : {}),
          ...(partialUsage ? { usage: partialUsage } : {}),
        });
      }
    },
  };
}
