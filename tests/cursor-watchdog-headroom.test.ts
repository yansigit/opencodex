import { describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../src/adapters/cursor";
import type { CursorTransport, CursorTransportFactoryInput } from "../src/adapters/cursor/transport";
import type { OcxParsedRequest } from "../src/types";

describe("Cursor watchdog headroom for heavy reasoning and standard models", () => {
  test("heavy reasoning models configure 300s heartbeat-only watchdog headroom", async () => {
    let observedInput: CursorTransportFactoryInput | undefined;
    const makeTransport = (input: CursorTransportFactoryInput): CursorTransport => {
      observedInput = input;
      return {
        async *run() {
          yield { type: "done" };
        },
        writeClient() {},
      };
    };

    const adapter = createCursorAdapter(
      { adapter: "cursor", baseUrl: "https://example.com" },
      { createTransport: makeTransport },
    );

    const parsed: OcxParsedRequest = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      options: { reasoning: "high" },
    } as unknown as OcxParsedRequest;

    await adapter.runTurn(parsed, { headers: new Headers() } as any, () => {});

    expect(observedInput?.streamHeartbeatOnlyFailMs).toBe(300_000);
  });

  test("standard models configure at least 180s heartbeat-only watchdog headroom", async () => {
    let observedInput: CursorTransportFactoryInput | undefined;
    const makeTransport = (input: CursorTransportFactoryInput): CursorTransport => {
      observedInput = input;
      return {
        async *run() {
          yield { type: "done" };
        },
        writeClient() {},
      };
    };

    const adapter = createCursorAdapter(
      { adapter: "cursor", baseUrl: "https://example.com" },
      { createTransport: makeTransport },
    );

    const parsed: OcxParsedRequest = {
      modelId: "cursor/composer-2.5",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      options: {},
    } as unknown as OcxParsedRequest;

    await adapter.runTurn(parsed, { headers: new Headers() } as any, () => {});

    expect(observedInput?.streamHeartbeatOnlyFailMs).toBe(180_000);
  });
});

