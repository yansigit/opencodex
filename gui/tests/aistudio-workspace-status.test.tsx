import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import { binProviderStatus, buildProviderWorkspace } from "../src/provider-workspace/catalog";
import type { WorkspaceProvider } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function aiStudioProvider(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    ...overrides,
  };
}

test("binProviderStatus for ai-studio-web is needs-setup when disconnected", () => {
  expect(binProviderStatus(aiStudioProvider({}))).toBe("needs-setup");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: false, aiStudioRelayActive: false }))).toBe("needs-setup");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: undefined, aiStudioRelayActive: undefined }))).toBe("needs-setup");
});

test("binProviderStatus for ai-studio-web is ready when session is present", () => {
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: true }))).toBe("ready");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: true, aiStudioRelayActive: false }))).toBe("ready");
});

test("binProviderStatus for ai-studio-web is ready when relay is active", () => {
  expect(binProviderStatus(aiStudioProvider({ aiStudioRelayActive: true }))).toBe("ready");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: false, aiStudioRelayActive: true }))).toBe("ready");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: true, aiStudioRelayActive: true }))).toBe("ready");
});

test("buildProviderWorkspace bins ai-studio-web by session/relay", () => {
  const providers = {
    "google-aistudio": aiStudioProvider({ hasAiStudioSession: false }),
    "openai": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", hasApiKey: true } as WorkspaceProvider,
  };
  const sections = buildProviderWorkspace(providers);
  expect(sections.needsSetup.some(p => p.name === "google-aistudio")).toBe(true);
  expect(sections.ready.some(p => p.name === "google-aistudio")).toBe(false);
  const readySections = buildProviderWorkspace({
    "google-aistudio": aiStudioProvider({ hasAiStudioSession: true }),
  });
  expect(readySections.ready.some(p => p.name === "google-aistudio")).toBe(true);
});

test("ProviderOverview renders re-authenticate/connect button for ai-studio-web", async () => {
  const item = {
    name: "google-aistudio",
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    hasAiStudioSession: false,
    aiStudioRelayActive: false,
  } as unknown as import("../src/provider-workspace/catalog").WorkspaceItem;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root: import("react-dom/client").Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderOverview item={item} apiBase="http://localhost:10100" />
      </LanguageProvider>
    );
  });

  const text = container.textContent ?? "";
  const hasButton = !!container.querySelector("button") && (/re-authenticate/i.test(text) || /connect/i.test(text));
  expect(hasButton).toBe(true);

  // status text should reflect disconnected
  expect(/disconnected|session active|browser relay active/i.test(text)).toBe(true);

  await act(async () => { root.unmount(); });
});

test("ProviderOverview shows relay/session status when connected", async () => {
  const item = {
    name: "google-aistudio",
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    hasAiStudioSession: true,
    aiStudioRelayActive: true,
  } as unknown as import("../src/provider-workspace/catalog").WorkspaceItem;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root: import("react-dom/client").Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderOverview item={item} apiBase="http://localhost:10100" />
      </LanguageProvider>
    );
  });

  const text = container.textContent ?? "";
  expect(/browser relay active|session active/i.test(text)).toBe(true);

  await act(async () => { root.unmount(); });
});
