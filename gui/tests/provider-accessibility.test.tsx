import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AddProviderModal from "../src/components/AddProviderModal";
import ProviderCatalog from "../src/components/provider-catalog/ProviderCatalog";
import type { CatalogPreset } from "../src/components/provider-catalog/provider-presets";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const presets: CatalogPreset[] = [
  { id: "free-one", label: "Free One", adapter: "openai-chat", baseUrl: "https://free.test/v1", auth: "key", freeTier: true },
  { id: "claude", label: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", auth: "oauth", oauthProvider: "anthropic" },
];
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["anthropic"] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: presets });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function render(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
}

function key(target: HTMLElement, value: string) {
  target.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true }));
}

test("provider catalog tabs have stable relationships and roving keyboard focus", async () => {
  await render(
    <ProviderCatalog presets={presets} onSelectPreset={() => {}} onSelectCustom={() => {}} />,
  );

  const tablist = host.querySelector<HTMLElement>("[role='tablist']")!;
  expect(tablist.getAttribute("aria-label")).toBe("Provider categories");
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>("[role='tab']")];
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1]);
  for (const tab of tabs) {
    expect(tab.id).toBeTruthy();
    const panel = host.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
  }
  const freeId = tabs[1]!.id;

  tabs[1]!.focus();
  await act(async () => { key(tabs[1]!, "ArrowRight"); });
  expect(win.document.activeElement).toBe(tabs[2]);
  expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, -1, 0]);

  await act(async () => { key(tabs[2]!, "Home"); });
  expect(win.document.activeElement).toBe(tabs[0]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  await act(async () => { key(tabs[0]!, "End"); });
  expect(win.document.activeElement).toBe(tabs[2]);
  await act(async () => { key(tabs[2]!, "ArrowLeft"); });
  expect(win.document.activeElement).toBe(tabs[1]);
  expect(tabs[1]?.id).toBe(freeId);
});

test("provider search keeps a visible programmatic label", async () => {
  await render(
    <ProviderCatalog presets={presets} onSelectPreset={() => {}} onSelectCustom={() => {}} />,
  );

  const search = host.querySelector<HTMLInputElement>("input[type='search']");
  expect(search?.id).toBeTruthy();
  const label = host.querySelector<HTMLLabelElement>(`label[for='${search?.id}']`);
  expect(label?.textContent?.trim()).toBe("Search providers");
});

test("nested OAuth warning closes without closing or resetting Add Provider", async () => {
  await render(
    <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={() => {}} />,
  );
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });

  const clickByText = (text: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.textContent?.includes(text));
    expect(button).toBeTruthy();
    button?.click();
  };
  await act(async () => { clickByText("Claude"); });
  await act(async () => { clickByText("Log in with Claude"); });

  const dialogs = [...host.querySelectorAll<HTMLDialogElement>("dialog")];
  expect(dialogs).toHaveLength(2);
  expect(dialogs.every(dialog => dialog.open)).toBe(true);
  await act(async () => {
    dialogs[1]!.dispatchEvent(new win.Event("cancel", { cancelable: true }));
  });

  expect(host.querySelectorAll("dialog")).toHaveLength(1);
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(host.textContent).toContain("Add: Claude");
  expect(host.textContent).toContain("Log in with Claude");
});
