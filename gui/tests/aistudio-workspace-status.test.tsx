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

test("binProviderStatus for ai-studio-web is needs-setup when no session or auth state", () => {
  expect(binProviderStatus(aiStudioProvider({}))).toBe("needs-setup");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: false }))).toBe("needs-setup");
});

test("binProviderStatus for ai-studio-web is ready when session is present", () => {
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: true }))).toBe("ready");
});

test("binProviderStatus exposes four auth states", () => {
  expect(binProviderStatus(aiStudioProvider({ aiStudioAuthState: "connected" }))).toBe("ready");
  expect(binProviderStatus(aiStudioProvider({ aiStudioAuthState: "checking" }))).toBe("ready");
  expect(binProviderStatus(aiStudioProvider({ aiStudioAuthState: "needs_reauth" }))).toBe("needs-setup");
  expect(binProviderStatus(aiStudioProvider({ aiStudioAuthState: "unsupported" }))).toBe("needs-setup");
});

test("binProviderStatus ignores leftover relay state", () => {
  expect(binProviderStatus(aiStudioProvider({ aiStudioRelayActive: true } as WorkspaceProvider))).toBe("needs-setup");
  expect(binProviderStatus(aiStudioProvider({ hasAiStudioSession: false, aiStudioRelayActive: true } as WorkspaceProvider))).toBe("needs-setup");
});

test("buildProviderWorkspace bins ai-studio-web by session/auth state", () => {
  const providers = {
    "google-aistudio": aiStudioProvider({ hasAiStudioSession: false }),
    "openai": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", hasApiKey: true } as WorkspaceProvider,
  };
  const sections = buildProviderWorkspace(providers);
  expect(sections.needsSetup.some(p => p.name === "google-aistudio")).toBe(true);
  expect(sections.ready.some(p => p.name === "google-aistudio")).toBe(false);
  const readySections = buildProviderWorkspace({
    "google-aistudio": aiStudioProvider({ aiStudioAuthState: "connected" }),
  });
  expect(readySections.ready.some(p => p.name === "google-aistudio")).toBe(true);
});

async function renderOverview(
  item: import("../src/provider-workspace/catalog").WorkspaceItem,
  extra?: { onRefreshConfig?: () => void | Promise<void> },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ProviderOverview item={item} apiBase="http://localhost:10100" onRefreshConfig={extra?.onRefreshConfig} />
      </LanguageProvider>
    );
  });
  return { container, root };
}

async function flushUi(): Promise<void> {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

function checkingItem() {
  return {
    name: "google-aistudio",
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    aiStudioAuthState: "checking",
  } as unknown as import("../src/provider-workspace/catalog").WorkspaceItem;
}

function needsReauthItem() {
  return {
    name: "google-aistudio",
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    aiStudioAuthState: "needs_reauth",
  } as unknown as import("../src/provider-workspace/catalog").WorkspaceItem;
}

test("ProviderOverview renders connect CTA for needs-reauth", async () => {
  const { container, root } = await renderOverview(needsReauthItem());
  const text = container.textContent ?? "";
  expect(/reauthentication required/i.test(text)).toBe(true);
  expect(/connect/i.test(text)).toBe(true);
  expect(/browser relay/i.test(text)).toBe(false);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview shows connected auth status without relay wording", async () => {
  const item = {
    name: "google-aistudio",
    adapter: "google",
    baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
    googleMode: "ai-studio-web",
    hasAiStudioSession: true,
    aiStudioAuthState: "connected",
  } as unknown as import("../src/provider-workspace/catalog").WorkspaceItem;

  const { container, root } = await renderOverview(item);
  const text = container.textContent ?? "";
  expect(/connected/i.test(text)).toBe(true);
  expect(/browser relay/i.test(text)).toBe(false);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview auto-tests once while checking", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/providers/test")) {
      return new Response(JSON.stringify({ applicable: true, ok: true, message: "ok" }), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { root } = await renderOverview(checkingItem());
  await flushUi();
  expect(calls.filter(url => url.includes("/api/providers/test")).length).toBe(1);
  expect(calls.some(url => url.includes("/aistudio/bridge"))).toBe(false);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview auto-test success shows connected and hides connect CTA", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/providers/test")) {
      return new Response(JSON.stringify({ ok: true, authState: "connected", message: "AI Studio session verified" }), { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const { container, root } = await renderOverview(checkingItem());
  await flushUi();
  const text = container.textContent ?? "";
  expect(/connected/i.test(text)).toBe(true);
  expect(/checking session/i.test(text)).toBe(false);
  expect(container.querySelector("button.btn-primary")).toBeNull();
  expect(/browser relay/i.test(text)).toBe(false);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview auto-test reauth error shows connect CTA without connected success", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/providers/test")) {
      return new Response(JSON.stringify({ ok: false, error: "Session expired or missing — re-authentication required" }), { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const { container, root } = await renderOverview(checkingItem());
  await flushUi();
  const text = container.textContent ?? "";
  expect(/reauthentication required/i.test(text)).toBe(true);
  expect(container.querySelector("button.btn-primary")).toBeTruthy();
  expect(/connected/i.test(text)).toBe(false);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview native login success refreshes config and shows connected", async () => {
  const refreshCalls: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/aistudio/login/native")) {
      return new Response(JSON.stringify({ ok: true, sessionPath: "/tmp/session.json" }), { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const { container, root } = await renderOverview(needsReauthItem(), {
    onRefreshConfig: () => { refreshCalls.push(1); },
  });
  const button = container.querySelector("button.btn-primary") as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  await flushUi();
  const text = container.textContent ?? "";
  expect(/connected/i.test(text)).toBe(true);
  expect(/reauthenticated successfully/i.test(text)).toBe(true);
  expect(container.querySelector("button.btn-primary")).toBeNull();
  expect(refreshCalls.length).toBe(1);
  await act(async () => { root.unmount(); });
});

test("ProviderOverview native login shows a nested server error for a non-2xx response", async () => {
  const serverError = "Native AI Studio login failed (exit code 1)";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/aistudio/login/native")) {
      return new Response(JSON.stringify({
        ok: false,
        error: { message: serverError, type: "native_login_failed", code: "native_login_failed" },
      }), { status: 500 });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const { container, root } = await renderOverview(needsReauthItem());
  const button = container.querySelector("button.btn-primary") as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  await flushUi();
  expect(container.textContent).toContain(serverError);
  expect(container.textContent).not.toContain("Reauthenticated successfully");
  await act(async () => { root.unmount(); });
});

test("ProviderOverview abort/cancel does not show success", async () => {
  let abortSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    abortSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  const { container, root } = await renderOverview(needsReauthItem());
  const button = container.querySelector("button.btn-primary") as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  await act(async () => { abortSignal?.dispatchEvent(new Event("abort")); });
  await flushUi();
  const text = container.textContent ?? "";
  expect(/reauthenticated successfully/i.test(text)).toBe(false);
  await act(async () => { root.unmount(); });
});
