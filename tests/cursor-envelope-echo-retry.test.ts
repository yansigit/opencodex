import { describe, expect, test } from "bun:test";
import { createCursorAdapter as createCursorAdapterProduction } from "../src/adapters/cursor";
import {
  CURSOR_ECHO_RETRY_CONTINUATION_TEXT,
  CursorEnvelopeEchoGuard,
  CursorEnvelopeEchoSniffer,
  CursorMidstreamEchoObserver,
  CursorReplayEnvelopeDetectedError,
  CursorRoutingCommentarySniffer,
  MAX_MIDSTREAM_SCAN_LENGTH,
} from "../src/adapters/cursor/envelope-echo";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };

const ECHO_TEXT = "[Tool Result]\n[tool_result]\ncall_id: run_cmd_0_abc\nname: run_cmd\nis_error: false\noutput:\nR1=A17\n";

function toolResultBody(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [
        { role: "user", content: "run the probe", timestamp: 1 },
        { role: "assistant", content: "Running it.", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
      ],
    },
    stream: false,
    options: {},
    _cursorConversationId: "cursor_echo_fixture",
    _cursorIdentityScope: "acct-echo",
  } as OcxParsedRequest;
}

function completedToolBody(modelId: string, isError = false): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [
        { role: "user", content: "Run STEP1, then continue.", timestamp: 1 },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call_step_1",
            name: "exec_command",
            arguments: { timeout_ms: 1_000, cmd: "printf STEP1" },
          }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_step_1",
          toolName: "exec_command",
          content: "STEP1",
          isError,
          timestamp: 3,
        },
      ],
    },
    stream: false,
    options: {},
    _cursorConversationId: "cursor_duplicate_tool_fixture",
    _cursorIdentityScope: "acct-duplicate-tool",
  } as OcxParsedRequest;
}

function parallelCompletedToolBody(modelId: string): OcxParsedRequest {
  const body = completedToolBody(modelId);
  body.context.messages = [
    { role: "user", content: "Run both probes, then continue.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "lookup", arguments: { q: "A" } },
        { type: "toolCall", id: "call_b", name: "lookup", arguments: { q: "B" } },
      ],
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call_a", toolName: "lookup", content: "A", isError: false, timestamp: 3 },
    { role: "toolResult", toolCallId: "call_b", toolName: "lookup", content: "B", isError: false, timestamp: 4 },
  ];
  return body;
}

/** First run echoes the envelope; the retry answers normally. Records each run request. */
function echoingThenHealthyTransportFactory() {
  const runRequests: CursorRunRequest[] = [];
  let attempt = 0;
  return {
    factory: (_input: unknown) => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          // Fragmented echo: marker split across deltas.
          yield { type: "text", text: "[Tool " } satisfies CursorServerMessage;
          yield { type: "text", text: "Result]\n[tool_result]\ncall_id: x" } satisfies CursorServerMessage;
          yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "STATE A17" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    }),
    runRequests,
    attempts: () => attempt,
  };
}

describe("cursor external output quarantine + corrective retry (devlog 260826 gaps 10-11)", () => {
  describe("unified streaming envelope guard", () => {
    const headers = [
      "[Tool Result]",
      "[Tool Error]",
      "[tool_result]",
      "Tool output for exec (call_id: exec_2-24a1f, is_error: false):",
      "Tool error for exec (call_id: exec_2-24a1f, is_error: true):",
    ];

    for (const header of headers) {
      test(`${header} is detected across every chunk boundary`, () => {
        for (let split = 0; split <= header.length; split++) {
          const guard = new CursorEnvelopeEchoGuard();
          expect(() => {
            guard.feed(header.slice(0, split));
            guard.feed(header.slice(split));
          }).toThrow();
        }
      });
    }

    test("leading CRLF stays quarantined and a malformed or inline neutral phrase stays visible", () => {
      const echoed = new CursorEnvelopeEchoGuard();
      expect(() => echoed.feed("\r\nTool output for exec (call_id: call_1, is_error: false):")).toThrow();

      const normal = new CursorEnvelopeEchoGuard();
      const text = "The phrase Tool output for exec is documentation.\r\n"
        + "Tool output for exec (call_id missing, is_error: false):";
      expect(normal.feed(text) + normal.finish()).toBe(text);
    });

    test("post-output detection reports a UTF-8 byte offset", () => {
      const guard = new CursorEnvelopeEchoGuard();
      expect(guard.feed("é\n")).toBe("é\n");
      try {
        guard.feed("[Tool Result]");
        throw new Error("expected replay detection");
      } catch (error) {
        expect(error).toBeInstanceOf(CursorReplayEnvelopeDetectedError);
        expect((error as CursorReplayEnvelopeDetectedError).offset).toBe(3);
      }
    });
  });

  describe("mid-stream echo observer (devlog 260828 F1/F2)", () => {
    const RUN03_SPECIMEN =
      "Step 2 produced no stdout, as expected. Next I'll cat the file.\n"
      + "[Tool Result]\n[tool_result]\ncall_id: call-c5b79188-edec-4a92\n"
      + "fc_63367283 mar-2aec-9a25-b7df-9b125bd8d1b5_0\nname: exec\nis_error: false\noutput:\n70\n84\n98\n";

    test("midstream echo after leading text is recorded with marker and offset", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Legit leading sentence.\n");
      observer.feed("[Tool Result]\ncall_id: fc_1234-abcd_0\nrest of block\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
      expect(findings[0]!.offset).toBe("Legit leading sentence.\n".length);
    });

    test("midstream corruption window flags a space-spliced mar call-id", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Leading text about progress.\n");
      observer.feed(RUN03_SPECIMEN);
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.callIdCorrupt).toBe(true);
    });

    test("clean call-id lines do not flag corruption", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Leading text.\n");
      observer.feed("[Tool Result]\n[tool_result]\ncall_id: call-1\nfc_63367283-2aec-9a25_1\noutput:\nok\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.callIdCorrupt).toBe(false);
    });

    test("a marker fragmented across delta boundaries still fires", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("prose first\n[Tool Res");
      observer.feed("ult]\ncall_id: fc_9 mar-broken_0\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
      expect(findings[0]!.callIdCorrupt).toBe(true);
    });

    test("a mid-line marker mention does not fire", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("first line\nThe string [Tool Result] appeared in the transcript I reviewed.\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("a turn-start marker belongs to the prefix sniffer, not the observer", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("[Tool Result]\ncall_id: fc_1 mar-2_0\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("indentation beyond the 128-char line cap disarms that line", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("first\n" + " ".repeat(200) + "[Tool Result]\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("scanning disarms past the cumulative cap but keeps prior findings", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("lead\n[Tool Result]\ncall_id: clean_0\n");
      const filler = "x".repeat(64 * 1024);
      for (let fed = 0; fed <= MAX_MIDSTREAM_SCAN_LENGTH; fed += filler.length) observer.feed(filler + "\n");
      observer.feed("late\n[Tool Error]\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
    });
  });

    test("midstream replay is discarded and fails closed after legitimate text", async () => {
        const LEAD = "Progressing through the steps now.\n";
        const factory = () => ({
          async *run() {
            yield { type: "text", text: LEAD } satisfies CursorServerMessage;
            yield { type: "text", text: "[Tool Result]\ncall_id: fc_9 mar-broken_0\n" } satisfies CursorServerMessage;
            yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
          },
          writeClient() {},
        });
        const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
        const events: AdapterEvent[] = [];
        await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
        expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(LEAD);
        expect(events.find(event => event.type === "error")).toMatchObject({
          code: "cursor_replay_envelope_detected",
          retryable: false,
        });
    });

  test("sniffer: marker split across deltas is detected; divergent text flushes", () => {
    const echo = new CursorEnvelopeEchoSniffer();
    expect(echo.feed("[Tool ").kind).toBe("hold");
    expect(echo.feed("Result]").kind).toBe("echo");

    const normal = new CursorEnvelopeEchoSniffer();
    expect(normal.feed("[Tool ").kind).toBe("hold");
    expect(normal.feed("Belt] is a phrase").kind).toBe("flush");

    const plain = new CursorEnvelopeEchoSniffer();
    expect(plain.feed("STATE A17").kind).toBe("flush");

    const whitespace = new CursorEnvelopeEchoSniffer();
    expect(whitespace.feed("\n  [tool_result]").kind).toBe("echo");

    const neutral = new CursorEnvelopeEchoSniffer();
    expect(neutral.feed("Tool output for exec (call_id: exec_2-24a1f, ").kind).toBe("hold");
    expect(neutral.feed("is_error: false):").kind).toBe("echo");
  });

  test("neutral K3 replay envelope retries without leaking the screenshot payload", async () => {
    let attempt = 0;
    const recoveries: string[] = [];
    const factory = () => ({
      async *run() {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "text", text: "Tool output for exec (call_id: exec_2-24a1f, is_error: false):\n" } satisfies CursorServerMessage;
          yield { type: "text", text: "invoked: exec with {secret payload}" } satisfies CursorServerMessage;
        } else {
          yield { type: "text", text: "continued safely" } satisfies CursorServerMessage;
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(
      toolResultBody("cursor/kimi-k3"),
      { headers: new Headers(), onAdapterRetry: recovery => recoveries.push(recovery) },
      event => events.push(event),
    );
    expect(attempt).toBe(2);
    expect(recoveries).toEqual(["cursor-envelope-echo"]);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("continued safely");
  });

  test("an exact successful tool invocation is quarantined and retried before it reaches the client", async () => {
    let attempt = 0;
    const recoveries: string[] = [];
    const factory = () => ({
      async *run() {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "tool_call_start", id: "duplicate", name: "exec_command" } satisfies CursorServerMessage;
          yield { type: "tool_call_delta", arguments: "{\"cmd\":\"printf STEP1\"," } satisfies CursorServerMessage;
          yield { type: "tool_call_delta", arguments: "\"timeout_ms\":1000}" } satisfies CursorServerMessage;
          yield { type: "tool_call_end", id: "duplicate" } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "ALLDONE" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(
      completedToolBody("cursor/grok-4.6"),
      { headers: new Headers(), onAdapterRetry: recovery => recoveries.push(recovery) },
      event => events.push(event),
    );

    expect(attempt).toBe(2);
    expect(recoveries).toEqual(["cursor-duplicate-tool-call"]);
    expect(events.map(event => event.type)).not.toContain("tool_call_start");
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("ALLDONE");
  });

  test("an exact parameterless tool invocation is quarantined without an argument delta", async () => {
    let attempt = 0;
    const recoveries: string[] = [];
    const body = completedToolBody("cursor/grok-4.6");
    const assistant = body.context.messages[1];
    if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant tool-call fixture");
    }
    const priorCall = assistant.content[0];
    if (!priorCall || priorCall.type !== "toolCall") throw new Error("expected prior tool call");
    priorCall.name = "refresh_status";
    priorCall.arguments = {};
    const priorResult = body.context.messages[2];
    if (priorResult?.role !== "toolResult") throw new Error("expected prior tool result");
    priorResult.toolName = "refresh_status";

    const factory = () => ({
      async *run() {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "tool_call_start", id: "duplicate-empty", name: "refresh_status" } satisfies CursorServerMessage;
          yield { type: "tool_call_end", id: "duplicate-empty" } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "ALLDONE" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(
      body,
      { headers: new Headers(), onAdapterRetry: recovery => recoveries.push(recovery) },
      event => events.push(event),
    );

    expect(attempt).toBe(2);
    expect(recoveries).toEqual(["cursor-duplicate-tool-call"]);
    expect(events.map(event => event.type)).not.toContain("tool_call_start");
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("ALLDONE");
  });

  test("an exact repeat of either call in the preceding parallel batch is quarantined", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "tool_call_start", id: "duplicate-a", name: "lookup" } satisfies CursorServerMessage;
          yield { type: "tool_call_delta", arguments: "{\"q\":\"A\"}" } satisfies CursorServerMessage;
          yield { type: "tool_call_end", id: "duplicate-a" } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "ALLDONE" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(
      parallelCompletedToolBody("cursor/grok-4.6"),
      { headers: new Headers() },
      event => events.push(event),
    );

    expect(attempt).toBe(2);
    expect(events.map(event => event.type)).not.toContain("tool_call_start");
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("ALLDONE");
  });

  test("same tool with different arguments remains visible and does not retry", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "tool_call_start", id: "next", name: "exec_command" } satisfies CursorServerMessage;
        yield { type: "tool_call_delta", arguments: "{\"cmd\":\"printf STEP2\",\"timeout_ms\":1000}" } satisfies CursorServerMessage;
        yield { type: "tool_call_end", id: "next" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(completedToolBody("cursor/grok-4.6"), { headers: new Headers() }, event => events.push(event));

    expect(attempt).toBe(1);
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_call_end")).toHaveLength(1);
  });

  test("a failed prior tool result does not arm duplicate-call recovery", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "tool_call_start", id: "retry-failed", name: "exec_command" } satisfies CursorServerMessage;
        yield { type: "tool_call_delta", arguments: "{\"cmd\":\"printf STEP1\",\"timeout_ms\":1000}" } satisfies CursorServerMessage;
        yield { type: "tool_call_end", id: "retry-failed" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(completedToolBody("cursor/grok-4.6", true), { headers: new Headers() }, event => events.push(event));

    expect(attempt).toBe(1);
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
  });

  test("an exact duplicate after a local side effect fails closed without a corrective resend", async () => {
    let attempt = 0;
    const recoveries: string[] = [];
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "local_side_effect" } satisfies CursorServerMessage;
        yield { type: "tool_call_start", id: "unsafe-duplicate", name: "exec_command" } satisfies CursorServerMessage;
        yield { type: "tool_call_delta", arguments: "{\"cmd\":\"printf STEP1\",\"timeout_ms\":1000}" } satisfies CursorServerMessage;
        yield { type: "tool_call_end", id: "unsafe-duplicate" } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(
      completedToolBody("cursor/grok-4.6"),
      { headers: new Headers(), onAdapterRetry: recovery => recoveries.push(recovery) },
      event => events.push(event),
    );

    expect(attempt).toBe(1);
    expect(recoveries).toEqual([]);
    expect(events.find(event => event.type === "error")).toMatchObject({
      code: "cursor_duplicate_completed_tool_call",
      retryable: false,
    });
    expect(events.map(event => event.type)).not.toContain("tool_call_start");
  });

  test("routing-commentary sniffer catches fragmented invented fallback but not legitimate Shell prose", () => {
    const hallucination = new CursorRoutingCommentarySniffer();
    expect(hallucination.feed("Shell 경로는 또 같은 문구로 ").kind).toBe("hold");
    expect(hallucination.feed("차단됐으니, 통과가 확인된 ").kind).toBe("hold");
    expect(hallucination.feed("exec_command 경로로 읽겠습니다.").kind).toBe("hallucination");

    const multiToolClaim = new CursorRoutingCommentarySniffer();
    expect(multiToolClaim.feed("Read와 Grep이 모두 blocked 상태입니다.").kind).toBe("hallucination");

    const multiline = new CursorRoutingCommentarySniffer();
    expect(multiline.feed("Shell was blocked.\n").kind).toBe("hold");
    expect(multiline.feed("Switching to exec_command.").kind).toBe("hallucination");

    const legitimate = new CursorRoutingCommentarySniffer();
    expect(legitimate.feed("Shell is unavailable on this operating system.").kind).toBe("hold");
    expect(legitimate.finish().kind).toBe("flush");

    const contextFree = new CursorRoutingCommentarySniffer();
    expect(contextFree.feed("The request was blocked and redirected to exec_command.").kind).toBe("hold");
    expect(contextFree.finish().kind).toBe("flush");
  });

  test("external tool-result echo retries once with the corrective action text and no leaked envelope", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(text).not.toContain("[Tool Result]");
    expect(events.some(e => e.type === "done")).toBe(true);
    // Retry request carries the corrective continuation and a rotated conversation id.
    expect(runRequests).toHaveLength(2);
    expect(runRequests[1]?.echoRetryContinuationText).toBe(CURSOR_ECHO_RETRY_CONTINUATION_TEXT);
    expect(runRequests[1]?.conversationId).not.toBe(runRequests[0]?.conversationId);
  });

  test("double echo fails with an error instead of looping", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(2);
    const errors = events.filter(e => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).not.toContain("[Tool Result]");
  });

  test("normal external continuation is unaffected (single attempt, text intact)", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: "[note] leading bracket but " } satisfies CursorServerMessage;
        yield { type: "text", text: "not an envelope" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("[note] leading bracket but not an envelope");
  });

  test("external model terminal tokens are removed at done without touching inline mentions", async () => {
    const factory = () => ({
      async *run() {
        yield { type: "text", text: "Use `<eos>` literally.\nanswer\n<|eot_" } satisfies CursorServerMessage;
        yield { type: "text", text: "id|>\n" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/grok-4.6"), { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("Use `<eos>` literally.\nanswer\n");
  });

  test("plain user turns (no trailing toolResult) never arm the sniffer", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_plain",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toContain("[Tool Result]");
  });

  test("user-action round with a replayed toolResult in history arms the sniffer and retries", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: {
        messages: [
          { role: "user", content: "run the probe", timestamp: 1 },
          { role: "assistant", content: "Running it.", timestamp: 2 },
          { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
          { role: "assistant", content: "STATE A17", timestamp: 4 },
          { role: "user", content: "Round 2. continue", timestamp: 5 },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_user_round",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });

  test("code-mode routing commentary that invents a blocked native Shell is quarantined and retried", async () => {
    let attempt = 0;
    const runRequests: CursorRunRequest[] = [];
    const factory = () => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          yield {
            type: "text",
            text: "`Shell` 경로는 또 같은 문구로 차단됐으니, 통과가 확인된 `exec_command` 경로로 읽겠습니다.",
          } satisfies CursorServerMessage;
        } else {
          yield { type: "text", text: "READ_OK" } satisfies CursorServerMessage;
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const body = {
      modelId: "cursor/kimi-k3-1m",
      context: {
        messages: [{ role: "user", content: "Read the file and report its first line.", timestamp: 1 }],
        tools: [{
          name: "exec",
          description: "Run JavaScript code to orchestrate nested tool calls.",
          parameters: {},
          freeform: true,
        }],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_routing_commentary",
      _cursorIdentityScope: "acct-routing-commentary",
    } as OcxParsedRequest;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(attempt).toBe(2);
    expect(text).toBe("READ_OK");
    expect(text).not.toContain("Shell");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });
});
