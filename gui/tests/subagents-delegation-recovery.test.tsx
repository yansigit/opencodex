import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; init?: RequestInit }> = [];
let recoveryServer = { enabled: false, model: null as string | null };
let pendingRecoveryPut: { body: unknown; resolve: (value: Response) => void } | null = null;

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
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
  recoveryServer = { enabled: false, model: null };
  pendingRecoveryPut = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/v2") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { agentTaskRecovery?: { enabled: boolean; model: string | null } };
          if (body.agentTaskRecovery) {
            if (pendingRecoveryPut === null) {
              recoveryServer = { ...body.agentTaskRecovery };
              return response({ ok: true, agentTaskRecovery: recoveryServer });
            }
            return new Promise<Response>(resolve => { pendingRecoveryPut.resolve = resolve; }) as unknown as Response;
          }
          return response({ ok: true });
        }
        return response({
          enabled: true,
          multiAgentMode: "v2",
          keepNativeChatGptOnV1: false,
          multiAgentModeHintText: null,
          v2NativeParentOverride: { enabled: false, model: null, active: false },
          v2RoutedDelegationBridge: false,
          agentTaskRecovery: recoveryServer,
        });
      }
      if (path === "/api/subagent-models") return response({ available: [], chosen: [] });
      if (path === "/api/injection-model") return response({ available: injectionAvailable, efforts: [] });
      return response({});
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

const injectionAvailable = [
  { provider: "openai", model: "gpt-5.6-luna", namespaced: "gpt-5.6-luna" },
  { provider: "openai", model: "gpt-5.4-mini", namespaced: "gpt-5.4-mini" },
  { provider: "anthropic", model: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5" },
  { provider: "openrouter", model: "gpt-5.6-luna-alias", namespaced: "openrouter/gpt-5.6-luna-alias", canonical: true },
];

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(apiBase = "") {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

function recoverySelect(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Recovery model (default: gpt-5.6-luna)"]');
  if (!button) throw new Error("Recovery model select not found");
  return button;
}

function recoverySwitch(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => candidate.getAttribute("aria-label") === "Recover Encrypted V2 Tasks");
  if (!button) throw new Error("Recovery switch not found");
  return button as HTMLButtonElement;
}

function recoveryOptions(): HTMLButtonElement[] {
  return [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

function recoveryPuts(): Array<{ enabled: boolean; model: string | null }> {
  return requests
    .filter(row => row.url.endsWith("/api/v2") && row.init?.method === "PUT")
    .map(row => (JSON.parse(String(row.init?.body ?? "{}")) as { agentTaskRecovery?: { enabled: boolean; model: string | null } }).agentTaskRecovery)
    .filter(Boolean);
}

test("renders the recovery model as a shared, labelled Select with the default first and canonical native models only", async () => {
  await mount();

  const trigger = recoverySelect();
  expect(trigger.getAttribute("role")).toBe("combobox");
  const switchButton = recoverySwitch();
  expect(switchButton.getAttribute("aria-pressed")).toBe("false");
  await act(async () => { trigger.click(); });
  const options = recoveryOptions();
  expect(options[0]?.textContent).toBe("Model default (gpt-5.6-luna)");
  const labels = options.map(option => option.textContent ?? "");
  expect(labels.some(label => label.includes("gpt-5.6-luna"))).toBe(true);
  expect(labels.some(label => label.includes("gpt-5.4-mini"))).toBe(true);
  expect(labels.join(" ")).not.toContain("claude-sonnet-5");
  expect(labels.join(" ")).not.toContain("gpt-5.6-luna-alias");
});

test("shows a stale saved model before the canonical rows", async () => {
  recoveryServer = { enabled: true, model: "legacy-gpt-4" };
  await mount();

  await act(async () => { recoverySelect().click(); });
  const options = recoveryOptions();
  expect(options[0]?.textContent).toBe("Model default (gpt-5.6-luna)");
  expect(options[1]?.textContent).toBe("legacy-gpt-4");
});

test("is controlled while a save is in flight", async () => {
  await mount();

  await act(async () => {
    pendingRecoveryPut = { body: null, resolve: () => {} };
    recoverySwitch().click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(recoverySelect().disabled).toBe(true);
  expect(recoverySwitch().disabled).toBe(true);

  await act(async () => {
    if (pendingRecoveryPut) {
      pendingRecoveryPut.resolve(response({ ok: true, agentTaskRecovery: { enabled: true, model: null } }));
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(recoverySelect().disabled).toBe(false);
});

test("letter keys inside the open select never save and never move focus", async () => {
  await mount();

  const trigger = recoverySelect();
  trigger.focus();
  await act(async () => { trigger.click(); });
  expect(recoveryOptions().length).toBeGreaterThan(0);
  await act(async () => {
    trigger.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  });
  expect(testWindow.document.activeElement).toBe(trigger);
  expect(recoveryOptions().length).toBeGreaterThan(0);
  expect(recoveryPuts()).toEqual([]);
});

test("an actual selection sends exactly one save", async () => {
  recoveryServer = { enabled: false, model: null };
  await mount();

  await act(async () => { recoverySelect().click(); });
  const option = recoveryOptions().find(candidate => candidate.textContent?.includes("gpt-5.4-mini"));
  expect(option).toBeTruthy();
  await act(async () => { option!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

  expect(recoveryPuts()).toEqual([{ enabled: false, model: "gpt-5.4-mini" }]);
});
