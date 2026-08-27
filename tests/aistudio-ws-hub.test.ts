import { describe, expect, test } from "bun:test";
import { createAiStudioRelayHub, type AiStudioRelayHub } from "../src/server/aistudio-ws-hub";

describe("AiStudioRelayHub — connection management and request multiplexing", () => {
  test("registers and unregisters browser websocket sessions", () => {
    const hub = createAiStudioRelayHub();
    expect(hub.hasActiveSessions()).toBe(false);

    const mockWs = {
      send: (data: string) => {},
      close: () => {},
    };

    hub.registerSession("sess_1", mockWs as any);
    expect(hub.hasActiveSessions()).toBe(true);
    expect(hub.getActiveSessionCount()).toBe(1);

    hub.unregisterSession("sess_1");
    expect(hub.hasActiveSessions()).toBe(false);
  });

  test("dispatches request over active websocket session and streams response chunks", async () => {
    const hub = createAiStudioRelayHub();
    const sentMessages: string[] = [];

    const mockWs = {
      send: (data: string) => {
        sentMessages.push(data);
      },
      close: () => {},
    };

    hub.registerSession("sess_1", mockWs as any);

    const dispatchPromise = hub.dispatchStream({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }),
    });

    expect(sentMessages.length).toBe(1);
    const sentMsg = JSON.parse(sentMessages[0]);
    expect(sentMsg.type).toBe("http_request");
    expect(sentMsg.id).toBeDefined();

    // Simulate browser sending back chunks
    hub.handleClientMessage("sess_1", JSON.stringify({
      id: sentMsg.id,
      type: "stream_chunk",
      payload: { data: 'data: {"candidates":[{"content":{"parts":[{"text":"Hi there!"}]}}]}\\n\\n' },
    }));

    hub.handleClientMessage("sess_1", JSON.stringify({
      id: sentMsg.id,
      type: "stream_end",
      payload: {},
    }));

    const streamResult = await dispatchPromise;
    const chunks: string[] = [];
    for await (const chunk of streamResult.chunks) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("Hi there!");
  });

  test("fails pending requests when the browser session disconnects", async () => {
    const hub = createAiStudioRelayHub();
    const mockWs = { send: (_data: string) => {}, close: () => {} };
    hub.registerSession("sess_1", mockWs as any);

    const streamResult = await hub.dispatchStream({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      method: "POST",
      body: "{}",
    });
    hub.unregisterSession("sess_1");

    await expect((async () => {
      for await (const _chunk of streamResult.chunks) {
        // consume until the disconnect error
      }
    })()).rejects.toThrow("browser session disconnected");
  });

  test("ignores response frames from a different browser session", async () => {
    const hub = createAiStudioRelayHub();
    const sentMessages: string[] = [];
    const ws = { send: (data: string) => { sentMessages.push(data); }, close: () => {} };
    hub.registerSession("sess_1", ws as any);
    hub.registerSession("sess_2", ws as any);

    const streamResult = await hub.dispatchStream({ url: "https://example.test", method: "GET" });
    const requestId = JSON.parse(sentMessages[0]!).id as string;
    const next = streamResult.chunks[Symbol.asyncIterator]().next();
    hub.handleClientMessage("sess_2", JSON.stringify({ id: requestId, type: "stream_end", payload: {} }));

    const outcome = await Promise.race([
      next.then(() => "resolved" as const),
      new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(outcome).toBe("pending");
    hub.handleClientMessage("sess_1", JSON.stringify({ id: requestId, type: "stream_end", payload: {} }));
    await expect(next).resolves.toMatchObject({ done: true });
  });

  test("aborts pending request when AbortSignal triggers", async () => {
    const hub = createAiStudioRelayHub();
    const sentMessages: string[] = [];
    const ws = { send: (data: string) => { sentMessages.push(data); }, close: () => {} };
    hub.registerSession("sess_1", ws as any);

    const controller = new AbortController();
    const streamResult = await hub.dispatchStream(
      { url: "https://example.test/stream", method: "POST" },
      controller.signal,
    );

    const initialMsg = JSON.parse(sentMessages[0]!);
    expect(initialMsg.type).toBe("http_request");

    controller.abort();

    expect(sentMessages.length).toBe(2);
    const abortMsg = JSON.parse(sentMessages[1]!);
    expect(abortMsg.type).toBe("abort");
    expect(abortMsg.id).toBe(initialMsg.id);
  });
});
