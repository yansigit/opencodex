import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { SectionTabs } from "../src/components/section-tabs";
import { sectionAnchorId } from "../src/section-anchors";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const observers: Array<{ callback: IntersectionObserverCallback; nodes: Element[] }> = [];
const OriginalIntersectionObserver = globalThis.IntersectionObserver;

function emitIntersecting(id: string) {
  for (const record of observers) {
    const target = record.nodes.find(node => node.id === id);
    if (!target) continue;
    record.callback([{
      isIntersecting: true,
      target,
      boundingClientRect: { top: 100 } as DOMRectReadOnly,
    } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observers.length = 0;

  class MockIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    #callback: IntersectionObserverCallback;
    #nodes: Element[] = [];

    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback;
      observers.push({ callback: this.#callback.bind(this), nodes: this.#nodes });
    }

    observe(node: Element) {
      this.#nodes.push(node);
    }

    unobserve(node: Element) {
      this.#nodes = this.#nodes.filter(n => n !== node);
    }

    disconnect() {
      this.#nodes = [];
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: MockIntersectionObserver,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: OriginalIntersectionObserver,
  });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function sectionLink(container: HTMLElement, label: string): HTMLAnchorElement {
  const found = Array.from(container.querySelectorAll("a.page-tab"))
    .find(link => (link.textContent ?? "").includes(label));
  if (!found) throw new Error(`section link not found: ${label}`);
  return found as HTMLAnchorElement;
}

test("clicking Coverage ignores intermediate scroll-spy updates until Coverage is visible", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const items = [
    { id: "overview", label: "Overview" },
    { id: "models", label: "Models" },
    { id: "providers", label: "Providers" },
    { id: "coverage", label: "Coverage" },
  ];

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <>
        <SectionTabs scope="usage" items={items} ariaLabel="Usage sections" />
        {items.map(item => (
          <div key={item.id} id={sectionAnchorId("usage", item.id)}>{item.label}</div>
        ))}
      </>,
    );
  });

  expect(sectionLink(container, "Overview").className).toContain("page-tab--active");

  await act(async () => {
    sectionLink(container, "Coverage").click();
  });
  expect(sectionLink(container, "Coverage").className).toContain("page-tab--active");

  // Smooth scroll passes Models/Providers; without a lock the spy would steal the highlight.
  await act(async () => {
    emitIntersecting(sectionAnchorId("usage", "models"));
    emitIntersecting(sectionAnchorId("usage", "providers"));
  });
  expect(sectionLink(container, "Coverage").className).toContain("page-tab--active");
  expect(sectionLink(container, "Models").className).not.toContain("page-tab--active");
  expect(sectionLink(container, "Providers").className).not.toContain("page-tab--active");

  await act(async () => {
    emitIntersecting(sectionAnchorId("usage", "coverage"));
  });
  expect(sectionLink(container, "Coverage").className).toContain("page-tab--active");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("renders labelled in-page navigation without tab semantics", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const items = [
    { id: "overview", label: "Overview" },
    { id: "models", label: "Models" },
  ];
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<SectionTabs scope="usage" items={items} ariaLabel="Usage sections" />);
  });

  const nav = container.querySelector("nav[aria-label='Usage sections']");
  expect(nav).toBeTruthy();
  expect(nav?.querySelectorAll("[role='tab'], [role='tabpanel']")).toHaveLength(0);
  const links = [...(nav?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
  expect(links.map(link => link.getAttribute("href"))).toEqual([
    `#${sectionAnchorId("usage", "overview")}`,
    `#${sectionAnchorId("usage", "models")}`,
  ]);
  expect(links[0]?.getAttribute("aria-current")).toBe("location");
  expect(links[1]?.hasAttribute("aria-current")).toBe(false);

  await act(async () => { root.unmount(); });
  container.remove();
});
