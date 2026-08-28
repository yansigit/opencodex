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
  "confirm",
  "alert",
  "IS_REACT_ACT_ENVIRONMENT",
  "__APP_VERSION__",
] as const;

let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;
let scrollCalls = 0;

function restore(key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  win = new Window({ url: "http://localhost/#dashboard" });
  scrollCalls = 0;
  Object.defineProperties(win, {
    matchMedia: {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    },
    scrollTo: { configurable: true, value: () => { scrollCalls += 1; } },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => win.setTimeout(() => callback(0), 0),
    },
  });
  const fetchMock = async () => new Response("{}", {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    fetch: { configurable: true, value: fetchMock },
    confirm: { configurable: true, value: () => false },
    alert: { configurable: true, value: () => undefined },
    __APP_VERSION__: { configurable: true, value: "test" },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  await win.happyDOM?.close?.();
  for (const key of globals) restore(key, previous[key]);
});

async function mountApp() {
  const host = document.createElement("div");
  document.body.append(host);
  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/App"),
  ]);
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><App /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 30)); });
}

function nav(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`missing ${label} navigation`);
  return button;
}

test("a deliberate top-level route change owns title, scroll, focus, announcement, and motion", async () => {
  await mountApp();
  expect(document.title).toBe("Dashboard — opencodex");
  expect(scrollCalls).toBe(0);

  await act(async () => { nav("Providers").click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 30)); });

  const main = document.querySelector("main");
  const live = document.querySelector(".route-announcement");
  expect(document.title).toBe("Providers — opencodex");
  expect(scrollCalls).toBe(1);
  expect(document.activeElement).toBe(main);
  expect(live?.getAttribute("aria-live")).toBe("polite");
  expect(live?.textContent).toBe("Providers");
  expect(document.querySelector(".main-inner")?.classList.contains("route-enter")).toBe(true);

  await act(async () => {
    win.location.hash = "models";
    win.dispatchEvent(new win.HashChangeEvent("hashchange"));
  });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 30)); });

  expect(document.title).toBe("Models — opencodex");
  expect(scrollCalls).toBe(2);
  expect(document.activeElement).toBe(main);
  expect(live?.textContent).toBe("Models");
  expect(document.querySelector(".main-inner")?.classList.contains("route-enter")).toBe(false);
});

test("only Escape restores mobile-drawer focus; navigation leaves focus on main", async () => {
  await mountApp();
  const menu = document.querySelector<HTMLButtonElement>(".mobile-topbar .menu-toggle")!;

  await act(async () => { menu.click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 210)); });
  expect(document.activeElement?.id).toBe("app-sidebar");

  await act(async () => { win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" })); });
  expect(document.activeElement).toBe(menu);

  await act(async () => { menu.click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 210)); });
  await act(async () => { nav("Providers").click(); });
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 30)); });

  expect(document.activeElement).toBe(document.querySelector("main"));
});
