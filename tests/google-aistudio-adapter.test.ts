import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const cookieProvider: OcxProviderConfig = {
  adapter: "google",
  googleMode: "ai-studio-web",
  baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
  authKind: "key",
  apiKey: "SAPISID=test_sapisid_abc123; __Secure-1PSID=psid_val; HSID=hsid_val",
};

function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return {
    modelId: "gemini-2.5-pro",
    stream: true,
    options: {},
    context: { messages, tools },
  } as unknown as OcxParsedRequest;
}

describe("google adapter — ai-studio-web (cookie) mode", () => {
  test("builds request with alkalimakersuite endpoint and SAPISIDHASH headers", async () => {
    const adapter = createGoogleAdapter(cookieProvider);
    const parsed = parsedWith([
      { role: "user", content: [{ type: "text", text: "Hello from coding agent" }] },
    ]);

    const req = await adapter.buildRequest(parsed);

    expect(req.url).toContain("alkalimakersuite-pa.clients6.google.com");
    expect(req.url).toContain("v1internal:streamGenerateContent?alt=sse");
    expect(req.headers["Authorization"]).toMatch(/^SAPISIDHASH \d+_[a-f0-9]{40}$/);
    expect(req.headers["Cookie"]).toContain("SAPISID=test_sapisid_abc123");
    expect(req.headers["Origin"]).toBe("https://aistudio.google.com");
    expect(req.headers["X-Goog-AuthUser"]).toBe("0");

    const parsedBody = JSON.parse(req.body);
    expect(parsedBody.contents).toBeDefined();
    expect(parsedBody.contents[0].parts[0].text).toBe("Hello from coding agent");
  });
});
