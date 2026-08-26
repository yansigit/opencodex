import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";

const relayProvider: OcxProviderConfig = {
  adapter: "google",
  googleMode: "ai-studio-web",
  baseUrl: "https://generativelanguage.googleapis.com",
  authKind: "key",
};

describe("google adapter — websocket browser relay integration", () => {
  test("routes stream generation through connected browser websocket", async () => {
    const adapter = createGoogleAdapter(relayProvider);
    const sentMessages: string[] = [];

    const mockWs = {
      send: (data: string) => {
        sentMessages.push(data);
      },
      close: () => {},
    };

    globalAiStudioRelayHub.registerSession("browser_tab_1", mockWs as any);

    const parsed: OcxParsedRequest = {
      modelId: "gemini-3.7-flash",
      stream: true,
      options: {},
      context: { messages: [{ role: "user", content: [{ type: "text", text: "Hello AI Studio" }] }] },
    } as unknown as OcxParsedRequest;

    const req = await adapter.buildRequest(parsed);
    expect(req.url).toContain("streamGenerateContent");

    // Simulate browser sending back chunks
    setTimeout(() => {
      if (sentMessages.length > 0) {
        const msg = JSON.parse(sentMessages[0]);
        globalAiStudioRelayHub.handleClientMessage("browser_tab_1", JSON.stringify({
          id: msg.id,
          type: "stream_chunk",
          payload: { data: 'data: {"candidates":[{"content":{"parts":[{"text":"Hello from AI Studio web!"}]}}]}\\n\\n' },
        }));
        globalAiStudioRelayHub.handleClientMessage("browser_tab_1", JSON.stringify({
          id: msg.id,
          type: "stream_end",
          payload: {},
        }));
      }
    }, 5);

    globalAiStudioRelayHub.unregisterSession("browser_tab_1");
  });
});
