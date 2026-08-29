import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import Storage from "../src/pages/Storage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLDivElement;
let root: Root | null;

const model = {
  provider: "acme",
  id: "custom-a",
  namespaced: "acme/custom-a",
  disabled: false,
  custom: true,
  customId: "custom-row-1",
  displayName: "Custom A",
  contextWindow: 128_000,
  inputModalities: ["text"],
};
const provider = { name: "acme", liveModels: true, models: [model.id], contextWindow: 128_000 };
const storageReport = {
  codexHome: "/tmp/codex",
  generatedAt: 1,
  total: { bytes: 20, fileCount: 2 },
  buckets: [{ key: "archived_sessions", label: "Archived sessions", bytes: 20, fileCount: 2 }],
};
const cleanupPolicy = {
  enabled: false,
  trigger: { archivedBytesOver: 5 * 1024 ** 3 },
  target: { removeOldestPercent: 25 },
  schedule: "manual",
  mode: "quarantine",
};
const trashEntry = { id: "trash-1", epoch: "1-entry", fileCount: 1, bytes: 10, mode: "quarantine" };

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#models" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperty(win, "innerWidth", { configurable: true, value: 320 });
  Object.defineProperty(win, "innerHeight", { configurable: true, value: 720 });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  win.localStorage.setItem("ocx-models-collapsed:v2", "[]");
  host = document.createElement("div");
  document.body.append(host);
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  await tick();
}

async function tick(ms = 0) {
  await act(async () => {
    await new Promise<void>(resolve => win.setTimeout(resolve, ms));
  });
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  });
  await tick();
}

function cancel(dialog: HTMLDialogElement) {
  dialog.dispatchEvent(new win.Event("cancel", { cancelable: true }));
}

function modelFetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/api/models")) return Promise.resolve(Response.json([model]));
  if (url.endsWith("/api/providers")) return Promise.resolve(Response.json([provider]));
  if (url.endsWith("/api/selected-models")) return Promise.resolve(Response.json({ selected: { acme: [model.id] }, available: { acme: [model.id] } }));
  if (url.endsWith("/api/provider-context-caps")) return Promise.resolve(Response.json({ caps: {} }));
  if (url.endsWith("/api/v2")) return Promise.resolve(Response.json({ enabled: true, agentsMaxThreadsConflict: false, multiAgentMode: "default" }));
  if (url.endsWith("/api/aliases")) return Promise.resolve(Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } }));
  if (url.endsWith("/api/model-presets")) return Promise.resolve(Response.json({ providers: {} }));
  if (url.endsWith("/api/model-discovery")) return Promise.resolve(Response.json({ policy: "off", providers: {}, recentArrivals: {} }));
  if (url.endsWith("/api/shadow-call-settings")) return Promise.resolve(Response.json({ enabled: false, model: "" }));
  if (url.endsWith("/api/combos")) return Promise.resolve(Response.json({ combos: [] }));
  return Promise.resolve(new Response(null, { status: 404 }));
}

test("Models uses native dialogs, restores triggers, and keeps row tooltips informational within mobile gutters", async () => {
  sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models: [model],
    providers: [provider],
    selectedModels: { acme: [model.id] },
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  let resolveSave!: (response: Response) => void;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/custom-models/custom-row-1") && init?.method === "PUT") {
      return new Promise<Response>(resolve => { resolveSave = resolve; });
    }
    return modelFetch(input, init);
  }) as typeof fetch;
  await mount(<Models apiBase="http://localhost" />);

  const row = host.querySelector<HTMLElement>(".model-row-wrap")!;
  let rowLeft = 288;
  let rowTop = 100;
  Object.defineProperty(row, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: rowLeft, y: rowTop, left: rowLeft, top: rowTop, right: rowLeft + 32, bottom: rowTop + 32, width: 32, height: 32, toJSON() {} }),
  });
  const rowButton = row.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { rowButton.focus(); });
  let tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(tip).toBeTruthy();
  expect(tip.querySelector("button") === null).toBe(true);
  expect(tip.style.left).toBe("8px");
  expect(tip.style.maxWidth).toBe("304px");
  expect(tip.style.minWidth).toBe("304px");

  Object.defineProperty(win, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(win, "innerHeight", { configurable: true, value: 200 });
  rowLeft = 358;
  rowTop = 180;
  await act(async () => { rowButton.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true })); });
  tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(tip.style.left).toBe("8px");
  expect(tip.style.maxWidth).toBe("374px");
  expect(tip.style.maxHeight).toBe("168px");

  const edit = row.querySelector<HTMLButtonElement>('button[aria-label="Edit Custom A"]')!;
  const remove = row.querySelector<HTMLButtonElement>('button[aria-label="Delete Custom A"]')!;
  const rowActions = row.querySelector<HTMLElement>(".models-model-row-actions");
  expect(edit).toBeTruthy();
  expect(remove).toBeTruthy();
  expect(rowActions).toBeTruthy();
  expect([...rowActions!.querySelectorAll("button")]).toEqual([edit, remove]);
  await click(edit);
  let dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="models-custom-dialog-title"]')!;
  expect(dialog?.open).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => { cancel(dialog); });
  expect(host.querySelector('dialog[open][aria-labelledby="models-custom-dialog-title"]')).toBeNull();
  expect(document.activeElement).toBe(edit);

  await click(edit);
  dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="models-custom-dialog-title"]')!;
  const update = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update")!;
  await act(async () => {
    update.click();
    cancel(dialog);
    dialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
  });
  expect(dialog.open).toBe(true);
  await act(async () => { resolveSave(Response.json({ ok: true })); });
  await tick();
  expect(host.querySelector('dialog[open][aria-labelledby="models-custom-dialog-title"]')).toBeNull();
  expect(document.activeElement).toBe(edit);

  const contextTrigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Custom windows")!;
  await click(contextTrigger);
  dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="models-context-dialog-title"]')!;
  expect(dialog?.open).toBe(true);
  await act(async () => { cancel(dialog); });
  expect(document.activeElement).toBe(contextTrigger);

  const helpTrigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-label="Sub-agent"]')!;
  await click(helpTrigger);
  dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="models-v2-help-title"]')!;
  expect(dialog?.open).toBe(true);
  await act(async () => { cancel(dialog); });
  expect(document.activeElement).toBe(helpTrigger);
});

test("Storage native cleanup and restore dialogs refuse Escape and backdrop dismissal while busy", async () => {
  sessionStorage.setItem("ocx.storage.report.v1:http://localhost", JSON.stringify(storageReport));
  let resolveCleanup!: (response: Response) => void;
  let resolveRestore!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/storage/cleanup-policy")) return Response.json(cleanupPolicy);
    if (url.endsWith("/api/storage/trash")) return Response.json({ entries: [trashEntry] });
    if (url.endsWith("/api/storage/cleanup/preview")) return Response.json({ percent: 25, count: 1, bytes: 10, digest: "digest", candidates: [{ relPath: "archived.jsonl", bytes: 10 }] });
    if (url.endsWith("/api/storage/cleanup") && init?.method === "POST") return await new Promise<Response>(resolve => { resolveCleanup = resolve; });
    if (url.endsWith("/api/storage/trash/restore") && init?.method === "POST") return await new Promise<Response>(resolve => { resolveRestore = resolve; });
    if (url.endsWith("/api/storage")) return Response.json(storageReport);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await mount(<Storage apiBase="http://localhost" />);

  const preview = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Preview")!;
  await click(preview);
  let dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="storage-cleanup-confirm-title"]')!;
  expect(dialog?.open).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  const cleanup = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Quarantine")!;
  await click(cleanup);
  await act(async () => {
    cancel(dialog);
    dialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
  });
  expect(dialog.open).toBe(true);
  await act(async () => { resolveCleanup(Response.json({ ok: true, mode: "quarantine", count: 1, bytes: 10 })); });
  await tick();
  expect(host.querySelector('dialog[open][aria-labelledby="storage-cleanup-confirm-title"]')).toBeNull();
  expect(document.activeElement).toBe(preview);

  await click(host.querySelector<HTMLButtonElement>("#storage-cleanup-tab-quarantine")!);
  const restore = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Restore")!;
  await click(restore);
  dialog = host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="storage-trash-confirm-title"]')!;
  expect(dialog?.open).toBe(true);
  const confirmRestore = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Restore")!;
  await click(confirmRestore);
  await act(async () => {
    cancel(dialog);
    dialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
  });
  expect(dialog.open).toBe(true);
  await act(async () => { resolveRestore(Response.json({ ok: true, count: 1, bytes: 10 })); });
  await tick();
  expect(host.querySelector('dialog[open][aria-labelledby="storage-trash-confirm-title"]')).toBeNull();
  expect(document.activeElement).toBe(restore);
});
