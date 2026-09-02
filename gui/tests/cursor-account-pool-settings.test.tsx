import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CursorAccountPoolSettings from "../src/components/provider-workspace/CursorAccountPoolSettings";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = undefined;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await testWindow.happyDOM?.close?.();
});

async function mount(accountCount = 2): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><CursorAccountPoolSettings apiBase="/proxy" accountCount={accountCount} /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
}

test("loads default-off state and requires two accounts before enabling", async () => {
  const fetchMock = mock(async () => Response.json({ enabled: false }));
  globalThis.fetch = fetchMock as typeof fetch;
  await mount(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/oauth/accounts/pool?provider=cursor");
  expect(host.textContent).toContain("Experimental and not battle-tested");
  expect(host.textContent).toContain("Add at least two Cursor OAuth accounts");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Cursor account pool (experimental)"]')?.disabled).toBe(true);
});

test("saves only provider and enabled", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ enabled: true });
    }
    return Response.json({ enabled: false });
  }) as typeof fetch;
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cursor account pool (experimental)"]')!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  expect(bodies).toEqual([{ provider: "cursor", enabled: true }]);
  expect(host.textContent).toContain("fails over for this conversation");
});

test("rolls back optimistic state when saving fails", async () => {
  globalThis.fetch = mock(async (_input, init) => init?.method === "PUT"
    ? new Response(null, { status: 500 })
    : Response.json({ enabled: false })) as typeof fetch;
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cursor account pool (experimental)"]')!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  expect(host.textContent).toContain("Cursor pool settings could not be saved");
  expect(host.textContent).toContain("Uses only the active Cursor account");
});

test("coalesces same-render rapid toggles into one persistence request", async () => {
  let writes = 0;
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") {
      writes++;
      return Response.json({ enabled: true });
    }
    return Response.json({ enabled: false });
  }) as typeof fetch;
  await mount();
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Cursor account pool (experimental)"]')!;
  await act(async () => {
    toggle.click();
    toggle.click();
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  expect(writes).toBe(1);
});

test("shows a load error and disables the toggle", async () => {
  globalThis.fetch = mock(async () => new Response(null, { status: 500 })) as typeof fetch;
  await mount();
  expect(host.textContent).toContain("Cursor pool settings could not be loaded");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Cursor account pool (experimental)"]')?.disabled).toBe(true);
});
