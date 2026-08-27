import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";

const cookieProvider: OcxProviderConfig = {
  adapter: "google",
  googleMode: "ai-studio-web",
  baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
  authKind: "key",
  apiKey: "SAPISID=test_sapisid_abc123; __Secure-1PSID=psid_val; HSID=hsid_val",
};

function parsedRequest(): OcxParsedRequest {
  return {
    modelId: "gemini-2.5-pro",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] },
  } as unknown as OcxParsedRequest;
}

function mockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("google adapter — ai-studio-web stream parsing", () => {
  test("parses standard text delta SSE stream from AI Studio", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const sseChunks = [
      'data: {"candidates": [{"content": {"parts": [{"text": "Hello "}]}}]}\n\n',
      'data: {"candidates": [{"content": {"parts": [{"text": "world!"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 2, "totalTokenCount": 6}}\n\n',
    ];

    const response = mockSseResponse(sseChunks);
    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.map((e: any) => e.text).join("")).toBe("Hello world!");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as any).usage?.inputTokens).toBe(4);
  });

  test("parses functionCall from AI Studio stream", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const sseChunks = [
      'data: {"candidates": [{"content": {"parts": [{"functionCall": {"name": "fetch_data", "args": {"id": 123}}}]}}]}\n\n',
      'data: {"candidates": [{"content": {"parts": []}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}}\n\n',
    ];

    const response = mockSseResponse(sseChunks);
    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call_start");
    expect(toolCalls.length).toBe(1);
    expect((toolCalls[0] as any).name).toBe("fetch_data");
    const toolDelta = events.find((e) => e.type === "tool_call_delta");
    expect(JSON.parse((toolDelta as any).arguments)).toEqual({ id: 123 });
  });

  test("parses non-SSE MakerSuite protobuf chunks into text deltas and completes", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const rawMakerSuite = '[[[[[[[[null,"Pong"]],"model"]]],null,[11,1,63],null,null,null,null,"token"]]]';
    const response = new Response(rawMakerSuite, {
      status: 200,
      headers: { "Content-Type": "application/json+protobuf" },
    });

    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.map((e: any) => e.text).join("")).toBe("Pong");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("parseResponse collects events into unary completed response", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const rawMakerSuite = '[[[[[[[[null,"Hello from unary"]],"model"]]],null,[11,1,63],null,null,null,null,"token"]]]';
    const response = new Response(rawMakerSuite, {
      status: 200,
      headers: { "Content-Type": "application/json+protobuf" },
    });

    const budget = createTranslatorBudget(100);
    const events = await adapter.parseResponse!(response, budget);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.map((e: any) => e.text).join("")).toBe("Hello from unary");
  });

  test("yields error event on non-SSE residual that cannot be parsed", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const invalidResidual = "SOME_UNKNOWN_FORMAT_NOT_HTML";
    const response = new Response(invalidResidual, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).message).toContain("upstream non-SSE response");
  });

  test("yields error event on non-SSE JSON error payload", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const errorJson = JSON.stringify({ error: { message: "Quota exceeded or invalid token" } });
    const response = new Response(errorJson, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).message).toBe("Quota exceeded or invalid token");
  });
  test("yields re-auth error on upstream HTML login redirect", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());

    const html = '<!doctype html><html><head><base href="https://accounts.google.com/v3/signin"></head><body>redirect</body></html>';
    const response = new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

    const budget = createTranslatorBudget(100);
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).message).toBe("Google AI Studio session expired — re-authentication required");
  });

  test("maps authentication statuses and redirects to re-authentication without exposing the body", async () => {
    for (const status of [302, 401, 403]) {
      const adapter = createGoogleAdapter(cookieProvider);
      await adapter.buildRequest(parsedRequest());
      const response = new Response("sensitive sign-in page", { status });
      const events = [];
      for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
      expect(events).toEqual([{ type: "error", message: "Google AI Studio session expired — re-authentication required" }]);
      expect(JSON.stringify(events)).not.toContain("sensitive");
    }
  });

  test("keeps rate-limit and server failures as upstream failures", async () => {
    for (const status of [429, 500]) {
      const adapter = createGoogleAdapter(cookieProvider);
      await adapter.buildRequest(parsedRequest());
      const response = new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      const events = [];
      for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
      expect(events.find((event) => event.type === "error")).toMatchObject({ message: "upstream failure" });
    }
  });

  test("detects multiline HTML before streaming line parsing", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("<!doctype html>\n<html><head>\n"));
        controller.enqueue(encoder.encode("<base href=\"https://accounts.google.com/v3/signin\">\n<body>expired</body></html>\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/html" } });
    const events = [];
    for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: "Google AI Studio session expired — re-authentication required",
    });
  });

  test("detects headerless accounts login HTML split across chunks", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("<html><head>\n<base href=\"https://accounts.google.com/v3/"));
        controller.enqueue(encoder.encode("signin\">\n</head><body>expired</body></html>\n"));
        controller.close();
      },
    }), { status: 200 });
    const events = [];
    for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: "Google AI Studio session expired — re-authentication required",
    });
  });
});
