import { describe, expect, test } from "bun:test";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";

describe("google-aistudio live model discovery via bridge", () => {
  test("dispatches GET /v1beta/models over bridge and parses model list", async () => {
    const sentMessages: string[] = [];
    const mockWs = {
      send: (data: string) => {
        sentMessages.push(data);
      },
      close: () => {},
    };

    globalAiStudioRelayHub.registerSession("discovery_tab", mockWs as any);

    const dispatchPromise = globalAiStudioRelayHub.dispatchStream({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      method: "GET",
    });

    expect(sentMessages.length).toBe(1);
    const msg = JSON.parse(sentMessages[0]);
    expect(msg.payload.url).toContain("v1beta/models");
    expect(msg.payload.method).toBe("GET");

    // Simulate browser sending back models JSON
    const sampleModelsJson = JSON.stringify({
      models: [
        { name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      ],
    });

    globalAiStudioRelayHub.handleClientMessage("discovery_tab", JSON.stringify({
      id: msg.id,
      type: "http_response",
      payload: { body: sampleModelsJson, status: 200 },
    }));

    const res = await dispatchPromise;
    let body = "";
    for await (const chunk of res.chunks) {
      body += chunk;
    }

    const parsed = JSON.parse(body);
    expect(parsed.models.length).toBe(2);
    expect(parsed.models[0].name).toBe("models/gemini-3.7-flash");

    globalAiStudioRelayHub.unregisterSession("discovery_tab");
  });
});
