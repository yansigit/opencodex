import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Behavioural contract for the denser Subagents workspace: five-slot cap,
 * add/remove via the rail, and the exact save request.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "confirm", "alert", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];
let available: string[] = [];
let chosen: string[] = [];
let injectionModel = "";
let catalogState: "fresh" | "stale" | "not_running" | "unknown" | undefined;
let rosterAfterRefresh: string[] | null = null;
let subagentCatalogReads = 0;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  available = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"];
  chosen = [];
  injectionModel = "";
  catalogState = undefined;
  rosterAfterRefresh = null;
  subagentCatalogReads = 0;
  clearClientResourceStoresForTests();
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
  Object.defineProperty(globalThis, "alert", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/injection-model")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ model: injectionModel, effort: "high", available: available.map(model => ({ provider: "openai", model, namespaced: model })) }),
          json: async () => ({ model: injectionModel, effort: "high", available: available.map(model => ({ provider: "openai", model, namespaced: model })) }),
        } as unknown as Response;
      }
      if (String(url).includes("/api/system/codex-restart")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            stateBefore: "stale",
            synced: true,
            requested: [123],
            stopped: [123],
            surviving: [],
            failed: [],
            code: "stopped",
          }),
        } as unknown as Response;
      }
      const isSubagentCatalog = String(url).includes("/api/subagent-models");
      const refreshed = isSubagentCatalog && rosterAfterRefresh !== null && subagentCatalogReads++ > 0;
      const roster = refreshed ? rosterAfterRefresh : available;
      const body = JSON.stringify({ available: roster, chosen: refreshed ? [] : chosen, ...(catalogState ? { catalogState: { state: catalogState } } : {}) });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => ({ available, chosen }),
      } as unknown as Response;
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  clearClientResourceStoresForTests();
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase="" />
      </LanguageProvider>,
    );
  });
  // Subagents defers its initial load through setTimeout(0), so a macrotask flush is required.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

/** Picker add/remove toggles use the advertised override labels. */
function addToggle(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button"))
    .find((b) => (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to advertised overrides`));
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Advertised-list remove only. */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".swi-featured-actions button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? "")) as unknown as HTMLButtonElement[];
}

test("renders one featured list and one picker, never the same list twice", async () => {
  await mount();
  expect(container.querySelector(".subagents-workspace-shell")).toBeTruthy();
  // Four stacked sections: roles, featured roster, model picker, then delegation settings.
  expect(container.querySelectorAll(".subagents-workspace-section").length).toBe(4);
  // The rail listed the featured models a second time, which read as a rendering bug.
  expect(container.querySelector(".subagents-workspace-rail")).toBeNull();
  const featuredHeadings = Array.from(container.querySelectorAll(".swi-featured-title"))
    .map(node => node.textContent?.trim());
  expect(featuredHeadings.filter(text => text === "Advertised overrides").length).toBe(1);
});

test("caps featured selections at five", async () => {
  await mount();

  // Six models available, six clicks — only five may land.
  for (const id of available) {
    const toggle = addToggle(id);
    if (!toggle.disabled) {
      await act(async () => { toggle.click(); });
    }
  }

  expect(removeButtons().length).toBe(5);
  expect(container.textContent).toContain("5/5");
  // The sixth add toggle is disabled rather than silently appended.
  expect(addToggle(available[5]!).disabled).toBe(true);

  // The cap lives in TWO places: the disabled attribute above (presentation) and the
  // state guard in toggle(). Force a click past the disabled attribute so a weakened
  // state guard cannot hide behind the UI check.
  await act(async () => { addToggle(available[5]!).dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
  expect(removeButtons().length).toBe(5);

  // And save must never ship more than five.
  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
  await act(async () => { save!.click(); });
  const put = requests.find((r) => r.init?.method === "PUT");
  expect(JSON.parse(String(put!.init!.body)).models.length).toBe(5);
});

test("saves the featured order with PUT and the models payload", async () => {
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  await act(async () => { addToggle("a-2").click(); });

  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
  expect(save).toBeDefined();
  await act(async () => { save!.click(); });

  const put = requests.find((r) => r.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(put!.url).toContain("/api/subagent-models");
  expect(put!.init?.body).toBe(JSON.stringify({ models: ["a-1", "a-2"] }));
});

test("marks the preferred model and lets Prefer update it without changing roster order", async () => {
  injectionModel = "a-2";
  await mount();
  await act(async () => { addToggle("a-1").click(); });
  expect(container.textContent).toContain("Preferred");
  const prefer = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Prefer");
  expect(prefer).toBeTruthy();
  await act(async () => { prefer!.click(); });
  const patch = requests.find(row => row.init?.method === "PUT" && String(row.url).includes("/api/injection-model"));
  expect(JSON.parse(String(patch!.init!.body))).toEqual({ model: "a-1", effort: "high" });
  expect(removeButtons().map(button => button.getAttribute("aria-label"))).toEqual(["Remove a-1"]);
});

test("stale catalog shows the existing restart control and refreshes the roster after restart", async () => {
  catalogState = "stale";
  available = ["stale-model"];
  rosterAfterRefresh = ["fresh-model"];

  await mount();
  expect(container.textContent).toContain("Stale");
  const restart = container.querySelector<HTMLButtonElement>(".codex-stale-banner button");
  expect(restart).toBeTruthy();

  await act(async () => { restart!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

  expect(requests.some(request => request.url.includes("/api/system/codex-restart"))).toBe(true);
  expect(requests.filter(request => request.url.includes("/api/subagent-models") && !request.init?.method).length).toBeGreaterThan(1);
  expect(container.textContent).toContain("fresh-model");
  expect(container.textContent).not.toContain("stale-model");
});
