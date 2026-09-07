import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests, useClientResource } from "../src/client-resource";
import { fetchDashboardOverview } from "../src/pages/dashboard-core-poll";
import Providers from "../src/pages/Providers";
import AddProviderModal from "../src/components/AddProviderModal";
import Dashboard from "../src/pages/Dashboard";
import { useDashboardData } from "../src/pages/use-dashboard-data";
import { useProvidersFetch } from "../src/pages/use-providers-fetch";

const API_BASE = "http://localhost";
const globals = ["document", "window", "navigator", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  clearClientResourceStoresForTests();
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error(`waitFor timed out body=${document.body.textContent}`);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 10)); });
  }
}

test("overview resource retains data across a failed poll and recovers on retry", async () => {
  let attempt = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/healthz") || url.endsWith("/api/providers")) {
      if (attempt === 1) return new Response("offline", { status: 503 });
      return Response.json(url.endsWith("/healthz")
        ? { status: "ok", version: attempt ? "2" : "1", uptime: 10 }
        : [{ name: "openai", adapter: "openai", baseUrl: "https://api.openai.com/v1", hasApiKey: false }]);
    }
    return Response.json({});
  }) as typeof fetch;

  function Probe() {
    const resource = useClientResource("dashboard-resilience-test", signal => fetchDashboardOverview(API_BASE, signal));
    return (
      <button
        type="button"
        hidden
        data-testid="overview-resource-probe"
        data-version={resource.data?.health?.version ?? ""}
        data-error={String(resource.error !== undefined)}
        onClick={() => { void resource.refresh(); }}
      />
    );
  }
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<Probe />);
  });
  const probe = container.querySelector<HTMLButtonElement>('[data-testid="overview-resource-probe"]')!;
  await waitFor(() => probe.dataset.version !== "");
  expect(probe.dataset.version).toBe("1");

  attempt = 1;
  await act(async () => { probe.click(); });
  await waitFor(() => probe.dataset.error === "true");
  expect(probe.dataset.version).toBe("1");

  attempt = 2;
  await act(async () => { probe.click(); });
  await waitFor(() => probe.dataset.version === "2");
  expect(probe.dataset.error).toBe("false");
});

test("Providers exposes an inline retry when config cold-start fails", async () => {
  let configCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/config")) { configCalls += 1; return new Response("offline", { status: 503 }); }
    if (url.endsWith("/api/oauth/providers")) return Response.json({ providers: [] });
    if (url.includes("/api/provider-presets")) return Response.json({ providers: [] });
    if (url.includes("/api/usage")) return Response.json({ providers: [] });
    return Response.json({});
  }) as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<LanguageProvider><Providers apiBase={API_BASE} /></LanguageProvider>);
  });
  await waitFor(() => configCalls > 0);
  expect(win.document.body.textContent).toContain("Failed to load config");
  expect(win.document.body.textContent?.match(/Failed to load config/g)?.length).toBe(1);
  expect([...win.document.body.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
  const retry = [...win.document.body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry");
  await act(async () => { retry?.click(); });
  await waitFor(() => configCalls >= 2);
  await act(async () => { retry?.click(); });
  await waitFor(() => configCalls >= 3);
});

test("Providers keeps cached content and clears the config failure after a successful retry", async () => {
  let configCalls = 0;
  const config = { port: 10100, defaultProvider: "openai", providers: {
    openai: { adapter: "openai", baseUrl: "https://api.openai.com/v1", authMode: "key", hasApiKey: false },
  } };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/config")) {
      configCalls += 1;
      return configCalls === 1 ? new Response("offline", { status: 503 }) : Response.json(config);
    }
    if (url.endsWith("/api/oauth/providers")) return Response.json({ providers: [] });
    if (url.includes("/api/provider-presets")) return Response.json({ providers: [] });
    if (url.includes("/api/usage")) return Response.json({ providers: [] });
    if (url.includes("/api/selected-models")) return Response.json({ models: {} });
    if (url.includes("/api/codex-auth")) return Response.json({ accounts: [], mode: "single" });
    return Response.json({});
  }) as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.append(container);
  // The page's session seed is the content that must survive the failed refresh.
  win.sessionStorage.setItem(`ocx.providers.config.v1:${API_BASE}`, JSON.stringify(config));
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<LanguageProvider><Providers apiBase={API_BASE} /></LanguageProvider>);
  });
  await waitFor(() => configCalls > 0);
  expect(container.textContent).toContain("OpenAI");
  expect(win.document.body.textContent?.match(/Failed to load config/g)?.length).toBe(1);
  const retry = [...win.document.body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry");
  expect(retry).toBeTruthy();
  await act(async () => { retry?.click(); });
  await waitFor(() => configCalls >= 2 && !win.document.body.textContent?.includes("Failed to load config"));
  expect(container.textContent).toContain("OpenAI");
});

test("Providers ignores an older config failure after a newer retry succeeds", async () => {
  let resolveFirst!: (response: Response) => void;
  let resolveSecond!: (response: Response) => void;
  let configRequest = 0;
  const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
  const second = new Promise<Response>(resolve => { resolveSecond = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/config")) return configRequest++ === 0 ? first : second;
    return Response.json({ providers: [] });
  }) as typeof fetch;
  function Probe() {
    const [config, setConfig] = useState<import("../src/pages/providers-shared").ProvidersConfig | null>(null);
    const [failed, setFailed] = useState(false);
    const { fetchConfig } = useProvidersFetch({
      apiBase: API_BASE,
      setConfig,
      setOauthProviders: () => {},
      setOauthStatus: () => {},
      invalidateProviderQuotas: () => {},
      setConfigLoadFailed: setFailed,
    });
    return (
      <button
        type="button"
        hidden
        data-testid="providers-fetch-probe"
        data-config={config === null ? "empty" : "loaded"}
        data-failed={String(failed)}
        onClick={() => { void fetchConfig(); }}
      />
    );
  }
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<Probe />);
  });
  const probe = container.querySelector<HTMLButtonElement>('[data-testid="providers-fetch-probe"]')!;
  await act(async () => {
    probe.click();
    probe.click();
  });
  await act(async () => {
    resolveSecond(Response.json({ port: 1, defaultProvider: "openai", providers: {} }));
    await second;
  });
  await waitFor(() => probe.dataset.config === "loaded" && probe.dataset.failed === "false");
  await act(async () => {
    resolveFirst(new Response("offline", { status: 503 }));
    await first;
  });
  await act(async () => { await Promise.resolve(); });
  expect(probe.dataset.failed).toBe("false");
});

test("Dashboard retains rendered overview content through failure and clears reconnecting after recovery", async () => {
  let failed = false;
  let version = "1";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/healthz") || url.endsWith("/api/providers")) {
      if (failed) return new Response("offline", { status: 503 });
      return Response.json(url.endsWith("/healthz")
        ? { status: "ok", version, uptime: 10 }
        : [{ name: "openai", adapter: "openai", baseUrl: "https://api.openai.com/v1", hasApiKey: false }]);
    }
    if (url.endsWith("/api/startup-health")) return Response.json({ status: "protected" });
    if (url.endsWith("/api/sidecar-settings")) return Response.json({ webSearch: { model: "", enabled: false }, vision: { model: "", enabled: false } });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/settings")) return Response.json({ codexAutoStart: false, port: 1, hostname: "localhost" });
    if (url.endsWith("/api/usage?range=30d")) return Response.json({ summary: { requests: 0, totalTokens: 0, coverageRatio: 0 }, providers: [] });
    if (url.endsWith("/api/diagnostics/project-config")) return Response.json({ grouped: [] });
    if (url.endsWith("/api/models")) return Response.json([]);
    return Response.json({});
  }) as typeof fetch;
  function Harness() {
    const { retryOverview } = useDashboardData(API_BASE);
    return (
      <>
        <button
          type="button"
          hidden
          data-testid="dashboard-overview-retry"
          onClick={() => { void retryOverview(); }}
        />
        <Dashboard apiBase={API_BASE} />
      </>
    );
  }
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  const retryOverview = container.querySelector<HTMLButtonElement>('[data-testid="dashboard-overview-retry"]')!;
  await waitFor(() => container.textContent?.includes("Online") === true && container.textContent?.includes("1") === true);
  failed = true;
  await act(async () => { retryOverview.click(); });
  await waitFor(() => container.textContent?.includes("Connection interrupted") === true);
  expect(container.textContent).toContain("Version1");
  expect(container.textContent).toContain("1");
  failed = false;
  version = "2";
  await act(async () => { retryOverview.click(); });
  await waitFor(() => container.textContent?.includes("2") === true && !container.textContent?.includes("Connection interrupted"));
});

test("Dashboard keeps the full cannot-connect state for a cold overview failure", async () => {
  let overviewCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/healthz") || url.endsWith("/api/providers")) {
      overviewCalls += 1;
      return new Response("offline", { status: 503 });
    }
    if (url.endsWith("/api/startup-health")) return Response.json({ status: "protected" });
    if (url.endsWith("/api/sidecar-settings")) return Response.json({ webSearch: { model: "", enabled: false }, vision: { model: "", enabled: false } });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/settings")) return Response.json({ codexAutoStart: false, port: 1, hostname: "localhost" });
    return Response.json({});
  }) as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<LanguageProvider><Dashboard apiBase={API_BASE} /></LanguageProvider>);
  });
  await waitFor(() => container.textContent?.includes("Cannot connect to proxy") === true);
  expect(container.textContent).toContain("ocx start");
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry");
  expect(retry).toBeTruthy();
  await act(async () => { retry?.click(); });
  await waitFor(() => overviewCalls >= 4);
});

test("Add Provider distinguishes preset failure from an empty search and keeps Custom Provider", async () => {
  let presetCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/provider-presets")) {
      presetCalls += 1;
      return presetCalls === 1 ? new Response("offline", { status: 503 }) : Response.json({ providers: [{ id: "retry-provider", label: "Retry Provider", adapter: "openai-chat", baseUrl: "https://example.com/v1", auth: "key", freeTier: true }] });
    }
    if (url.includes("/api/oauth/providers")) return Response.json({ providers: [] });
    if (url.includes("/api/usage")) return Response.json({ providers: [] });
    return Response.json({});
  }) as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<LanguageProvider><AddProviderModal apiBase={API_BASE} existingNames={[]} onClose={() => {}} onAdded={() => {}} /></LanguageProvider>);
  });
  await waitFor(() => container.textContent?.includes("Could not load provider catalog.") === true);
  expect(container.textContent).toContain("Add a custom one");
  expect(container.textContent).not.toContain("No match.");
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry");
  expect(retry).toBeTruthy();
  await act(async () => { retry?.click(); });
  await waitFor(() => presetCalls >= 2 && container.textContent?.includes("Retry Provider") === true);
  expect(container.textContent).not.toContain("Could not load provider catalog.");
});
