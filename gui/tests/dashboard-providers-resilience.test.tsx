import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests, useClientResource } from "../src/client-resource";
import { fetchDashboardOverview } from "../src/pages/dashboard-core-poll";
import Providers from "../src/pages/Providers";
import AddProviderModal from "../src/components/AddProviderModal";
import Dashboard from "../src/pages/Dashboard";

const API_BASE = "http://localhost";
const globals = ["document", "window", "navigator", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  clearClientResourceStoresForTests();
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error(`waitFor timed out current=${JSON.stringify((globalThis as { __probe?: unknown }).__probe)}`);
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

  const probe: { current: ReturnType<typeof useClientResource<Awaited<ReturnType<typeof fetchDashboardOverview>>>> | null } = { current: null };
  function Probe() {
    probe.current = useClientResource("dashboard-resilience-test", signal => fetchDashboardOverview(API_BASE, signal));
    return null;
  }
  const container = win.document.createElement("div");
  win.document.body.append(container);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    root.render(<Probe />);
  });
  await waitFor(() => probe.current?.data !== undefined);
  expect(probe.current?.data?.health?.version).toBe("1");

  attempt = 1;
  await act(async () => { probe.current?.refresh(); });
  await waitFor(() => probe.current?.error !== undefined);
  expect(probe.current?.data?.health.version).toBe("1");

  attempt = 2;
  await act(async () => { probe.current?.refresh(); });
  await waitFor(() => probe.current?.data?.health.version === "2");
  expect(probe.current?.error).toBeUndefined();
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
  expect([...win.document.body.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
  const retry = [...win.document.body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry");
  await act(async () => { retry?.click(); });
  await waitFor(() => configCalls >= 2);
  await act(async () => { retry?.click(); });
  await waitFor(() => configCalls >= 3);
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/provider-presets")) return new Response("offline", { status: 503 });
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
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
});
