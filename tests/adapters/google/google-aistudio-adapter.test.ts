import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAiStudioSession } from "../../../src/oauth/aistudio-session-sync";
import { createGoogleAdapter } from "../../../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { flushConfigDirHardeningForTests } from "../../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-aistudio-adapter-"));
  process.env.OPENCODEX_HOME = testDir;
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

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

describe("google adapter+�u���T ai-studio-web (cookie) mode", () => {
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

  test("falls back to saved session file in ~/.opencodex/aistudio-session.json when apiKey is not set in provider config", async () => {
    const sessionPath = join(testDir, "aistudio-session.json");
    saveAiStudioSession(
      {
        selectedProject: "gen-lang-client-test",
        windowId: "win-test-fallback",
        cookies: [
          { name: "SAPISID", value: "saved_session_sapisid_xyz" },
          { name: "__Secure-1PSID", value: "saved_session_psid_xyz" },
        ],
      },
      sessionPath,
    );

    const localProvider: OcxProviderConfig = {
      adapter: "google",
      googleMode: "ai-studio-web",
      baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    };
    const adapter = createGoogleAdapter(localProvider);
    const parsed = parsedWith([{ role: "user", content: [{ type: "text", text: "Test session fallback" }] }]);
    const req = await adapter.buildRequest(parsed);
    expect(req.headers["Cookie"]).toContain("SAPISID=saved_session_sapisid_xyz");
    expect(req.headers["Authorization"]).toMatch(/^SAPISIDHASH \d+_[a-f0-9]{40}$/);
  });

  test("uses direct transport (fetchResponse is undefined on google adapter)", () => {
    expect(createGoogleAdapter(cookieProvider).fetchResponse).toBeUndefined();
  });

  test("refuses to attach AI Studio cookies to a retargeted public HTTPS endpoint", async () => {
    const adapter = createGoogleAdapter({ ...cookieProvider, baseUrl: "https://collector.example" });
    const parsed = parsedWith([{ role: "user", content: [{ type: "text", text: "do not leak" }] }]);

    await expect(adapter.buildRequest(parsed)).rejects.toThrow(
      "AI Studio web credentials require the canonical Google endpoint.",
    );
  });
});
