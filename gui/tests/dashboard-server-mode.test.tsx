import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { DashboardServerSettingsPanel } from "../src/pages/dashboard-overview-panels";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;
const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  win.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function dashboard(
  configured: NonNullable<NonNullable<Dash["settings"]>["server"]>["configured"],
  credentialConfigured = true,
) {
  const saves: typeof configured[] = [];
  return {
    saves,
    props: {
      t: (key: keyof typeof en) => en[key],
      settings: {
        server: {
          configured,
          activeOrigin: "http://127.0.0.1:10100",
          credentialConfigured,
          restartRequired: false,
        },
      },
      saveServerSettings: async (next: typeof configured) => {
        saves.push(structuredClone(next));
        return {} as never;
      },
    } as unknown as Dash,
  };
}

async function render(props: Dash) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<DashboardServerSettingsPanel {...props} />);
  });
}

function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
}

test("mode toggle preserves TLS settings and generates a host-aware SSH command", async () => {
  const { props } = dashboard({
    hostname: "0.0.0.0",
    port: 10443,
    tls: {
      certFile: "/tls/cert.pem",
      keyFile: "/tls/key.pem",
      publicOrigin: "https://proxy.lan:10443",
    },
    aiStudioOrigin: null,
  });
  await render(props);

  await act(async () => { button(en["dash.serverModeLoopback"]).click(); });
  expect(button(en["dash.serverModeLoopback"]).getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("ssh -N -L 127.0.0.1:20100:127.0.0.1:10443");
  expect(host.textContent).toContain("proxy.lan");
  expect(host.textContent).toContain("http://127.0.0.1:20100/#dashboard");
  expect(host.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://opencodex.me/reference/configuration/server/#persistent-macos-ssh-tunnel");
  expect(host.querySelector("input[placeholder='/path/to/cert.pem']")).toBeNull();

  await act(async () => { button(en["dash.serverModeRemote"]).click(); });
  expect(button(en["dash.serverModeRemote"]).getAttribute("aria-pressed")).toBe("true");
  expect((host.querySelector("input[placeholder='/path/to/cert.pem']") as HTMLInputElement).value).toBe("/tls/cert.pem");
  expect((host.querySelector("input[type='url']") as HTMLInputElement).value).toBe("https://proxy.lan:10443");
});

test("remote mode requires explicit TLS values and a data-plane credential", async () => {
  const { props } = dashboard({
    hostname: "127.0.0.1",
    port: 10100,
    tls: null,
    aiStudioOrigin: null,
  }, false);
  await render(props);

  await act(async () => { button(en["dash.serverModeRemote"]).click(); });
  expect((host.querySelector("input[type='url']") as HTMLInputElement).value).toBe("");
  expect((host.querySelector("input[type='url']") as HTMLInputElement).required).toBe(true);
  expect(button(en["common.save"]).disabled).toBe(true);
  expect(host.textContent).toContain(en["dash.serverRemoteCredentialRequired"]);
  expect(host.textContent).not.toContain("10.0.0.51");
});
