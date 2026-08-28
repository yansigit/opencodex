import { describe, expect, test } from "bun:test";
import { computeFailureFingerprint } from "../src/telemetry/fingerprint";
import type { FailureEvent } from "../src/telemetry/types";

describe("computeFailureFingerprint", () => {
  test("ignores timestamps, request/session IDs, and line/column numbers", () => {
    const first: FailureEvent = {
      failureKind: "upstream_wire_error",
      provider: "openai",
      model: "gpt-5",
      signature: "Error at file.ts:12:8 request_id=req-123 session_id=s-1",
      timestamp: 1000,
      requestId: "req-123",
      sessionId: "s-1",
    };
    const second: FailureEvent = {
      ...first,
      signature: "Error at file.ts:99:42 request_id=req-999 session_id=s-9",
      timestamp: 9000,
      requestId: "req-999",
      sessionId: "s-9",
    };
    expect(computeFailureFingerprint(first)).toBe(computeFailureFingerprint(second));
    expect(computeFailureFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("changes when stable failure identity changes", () => {
    const event: FailureEvent = { failureKind: "websocket_1006", provider: "openai", model: "gpt-5", signature: "closed" };
    expect(computeFailureFingerprint(event)).not.toBe(computeFailureFingerprint({ ...event, provider: "anthropic" }));
  });
});
