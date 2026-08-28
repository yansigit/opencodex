import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  win = new Window({ url: "http://localhost/#integrations/grok" });
  const fetchMock = async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/grok")) {
      return json({
        configPath: "/tmp/grok.json",
        present: true,
        baseUrl: "http://localhost:11434",
        models: [{ id: "grok-4", alias: "grok" }],
        candidates: [{ id: "grok-4", native: true, contextWindow: 131072 }],
        excluded: [],
      });
    }
    return json({});
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    fetch: { configurable: true, value: fetchMock },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  await win.happyDOM?.close?.();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function tab(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=tab]"))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`missing ${label} tab`);
  return button;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`missing ${label} button`);
  return match;
}

test("a lazy Integration workspace stays mounted with its draft while hidden", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const [{ createRoot }, { LanguageProvider }, { default: Integrations }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/Integrations"),
  ]);
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Integrations apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });

  await act(async () => { button("Expand all").click(); });
  const modelSwitch = document.querySelector<HTMLButtonElement>(".grok-model-row .switch")!;
  await act(async () => { modelSwitch.click(); });
  const grokPanel = document.querySelector<HTMLElement>("#integrations-panel-grok")!;
  expect(modelSwitch.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    tab("Codex CLI").click();
    await new Promise(resolve => win.setTimeout(resolve, 10));
  });
  expect(grokPanel.hidden).toBe(true);

  await act(async () => {
    tab("Grok Build").click();
    await new Promise(resolve => win.setTimeout(resolve, 10));
  });
  expect(document.querySelector("#integrations-panel-grok")).toBe(grokPanel);
  expect(document.querySelector(".grok-model-row .switch")?.getAttribute("aria-pressed")).toBe("false");
});
