import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ErrorBoundary from "../src/components/ErrorBoundary";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("shows the failed page and recovers when Reload resets the boundary", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;
  let shouldThrow = true;

  function Page() {
    if (shouldThrow) throw new Error("render exploded");
    return <p>Recovered page</p>;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(
      <ErrorBoundary
        pageName="Providers"
        title="Page failed to load"
        message="Try again."
        detailsLabel="Error"
        reloadLabel="Reload"
      >
        <Page />
      </ErrorBoundary>,
    );
  });

  expect(container.textContent).toContain("Providers: Page failed to load");
  expect(container.textContent).toContain("render exploded");

  shouldThrow = false;
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
  });

  expect(container.textContent).toContain("Recovered page");
  expect(container.textContent).not.toContain("render exploded");

  await act(async () => {
    root.unmount();
  });
});

test("delegates Reload when a lazy chunk needs a full-page retry", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let reloads = 0;

  function FailedChunk() {
    throw new Error("Importing a module script failed");
  }

  const root = createRoot(container);
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    await act(async () => {
      root.render(
        <ErrorBoundary
          pageName="Providers"
          title="Page failed to load"
          message="Try again."
          detailsLabel="Error"
          reloadLabel="Reload"
          onReload={() => { reloads += 1; }}
        >
          <FailedChunk />
        </ErrorBoundary>,
      );
    });

    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(reloads).toBe(1);
    expect(container.textContent).toContain("Importing a module script failed");
  } finally {
    console.error = previousConsoleError;
    await act(async () => root.unmount());
  }
});
