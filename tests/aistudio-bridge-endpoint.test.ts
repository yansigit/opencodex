import { describe, expect, test } from "bun:test";
import { getAiStudioBridgeHtml, getAiStudioUserScript } from "../src/server/aistudio-ws-hub";

describe("aistudio bridge HTTP endpoint", () => {
  test("contains valid HTML and websocket bridge script", async () => {
    const req = new Request("http://127.0.0.1:4000/aistudio/bridge");
    expect(req.url).toContain("/aistudio/bridge");
    const html = getAiStudioBridgeHtml(10100);
    expect(html).toContain("Google AI Studio Bridge");
    expect(html).toContain("bridge.user.js");
    expect(html).toContain("ws://127.0.0.1:10100/v1/ws/aistudio");
  });
  test("user script endpoint", async () => {
    const req = new Request("http://127.0.0.1:4000/aistudio/bridge.user.js");
    expect(req.url).toContain("/aistudio/bridge.user.js");
    const userScript = getAiStudioUserScript(10100);
    expect(userScript).toContain("@match        https://aistudio.google.com/*");
    expect(userScript).toContain("ws://127.0.0.1:10100/v1/ws/aistudio");
    expect(userScript).toContain('credentials: "include"');
  });
});
