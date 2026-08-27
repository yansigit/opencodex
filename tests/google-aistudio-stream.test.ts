import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalAiStudioRelayHub.reset();
});

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
  function responsesConfig(apiKey?: string): OcxConfig {
    return {
      port: 0,
      defaultProvider: "google-aistudio",
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
          defaultModel: "gemini-2.5-pro",
          models: ["gemini-2.5-pro"],
          liveModels: false,
          requestPacing: { enabled: false },
          ...(apiKey === undefined ? {} : { apiKey }),
        },
      },
    } as OcxConfig;
  }

  function responsesRequest(): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "google-aistudio/gemini-2.5-pro", input: "hello", stream: false }),
    });
  }

  test("Responses errors use AI Studio redaction for auth and HTML bodies", async () => {
    for (const status of [401, 403]) {
      globalThis.fetch = (async () => new Response(
        `<!doctype html><html><body>secret-${status}</body></html>`,
        { status, headers: { "content-type": "text/html" } },
      )) as typeof fetch;
      const response = await handleResponses(responsesRequest(), responsesConfig("SAPISID=test"), { model: "", provider: "" });
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(body).toContain("Google AI Studio session expired — re-authentication required");
      expect(body).not.toContain("secret-");
      expect(body).not.toContain("<html");
    }
  });

  test("Responses HTML rate limits and server failures retain status classification", async () => {
    for (const status of [429, 500]) {
      globalThis.fetch = (async () => new Response(
        `<!doctype html><html><body>secret-${status}</body></html>`,
        { status, headers: { "content-type": "text/html" } },
      )) as typeof fetch;
      const response = await handleResponses(responsesRequest(), responsesConfig("SAPISID=test"), { model: "", provider: "" });
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(body).not.toContain("re-authentication");
      expect(body).not.toContain("secret-");
      expect(body).not.toContain("<html");
    }
  });

  test("Responses exposes an AI Studio sign-in redirect instead of following it", async () => {
    let redirect: RequestInit["redirect"];
    let requestSent = false;
    globalAiStudioRelayHub.registerSession("relay", { send() {}, close() {} } as any);
    globalThis.fetch = (async (_input, init) => {
      requestSent = true;
      redirect = init?.redirect;
      return new Response("redirect body", {
        status: 302,
        headers: { "content-type": "text/html", location: "https://accounts.google.com/v3/signin" },
      });
    }) as typeof fetch;

    const response = await handleResponses(responsesRequest(), responsesConfig("SAPISID=test"), { model: "", provider: "" });
    const body = await response.text();
    expect(requestSent).toBe(true);
    expect(redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(body).toContain("Google AI Studio session expired — re-authentication required");
  });

  test("Responses maps missing AI Studio credentials to authentication_error", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("unexpected", { status: 200 });
    }) as typeof fetch;
    const response = await handleResponses(responsesRequest(), responsesConfig(), { model: "", provider: "" });
    const body = await response.json() as { error?: { type?: string; message?: string } };
    expect(response.status).toBe(401);
    expect(body.error?.type).toBe("authentication_error");
    expect(body.error?.message).toContain("re-authentication required");
    expect(fetchCalled).toBe(false);
  });

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

  test("detects HTML login responses before SSE parsing", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());
    const response = new Response("<html>\n<body>login\n</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    const events = [];
    for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
    expect(events).toContainEqual({ type: "error", message: "Google AI Studio session expired — re-authentication required" });
  });

  test("detects a sign-in redirect split across chunks", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    await adapter.buildRequest(parsedRequest());
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("<html><head>\n"));
        controller.enqueue(encoder.encode("<base href=\"https://accounts.google.com/v3/signin\">\n</head></html>"));
        controller.close();
      },
    }), { status: 200 });
    const events = [];
    for await (const event of adapter.parseStream(response, createTranslatorBudget(100))) events.push(event);
    expect(events).toContainEqual({ type: "error", message: "Google AI Studio session expired — re-authentication required" });
  });
});
