import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
import { handleManagementAPI } from "../../src/server/management-api";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function makeCodexConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

describe("Codex account pool strategy management API", () => {
  const TEST_DIR = join(import.meta.dir, ".tmp-account-pool-mgmt-codex");
  let previousOpencodexHome: string | undefined;

  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    removeTreeWithRetry(TEST_DIR);
  });

  test("GET /api/codex-auth/active surfaces strategy defaults", async () => {
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "quota",
      accountPoolStickyLimit: 1,
    });
  });

  test("GET /api/codex-auth/active surfaces configured strategy", async () => {
    const config = makeCodexConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid strategy", async () => {
    for (const bad of ["weighted", "", 1, null, "Quota"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid stickyLimit", async () => {
    for (const bad of [0, 101, 1.5, "2", null, Number.NaN]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyLimit: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy accepts valid values and mutates runtime", async () => {
    const config = makeCodexConfig();
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 7 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      ok: true,
      accountPoolStrategy: "fill-first",
      accountPoolStickyLimit: 7,
    });
    expect(config.accountPoolStrategy).toBe("fill-first");
    expect(config.accountPoolStickyLimit).toBe(7);
  });

  test("PATCH /api/codex-auth/pool-strategy accepts round-robin", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "round-robin", stickyLimit: 2 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.accountPoolStrategy).toBe("round-robin");
    expect(config.accountPoolStickyLimit).toBe(2);
  });

  test("PUT rejects invalid stickyLimit without mutating a valid strategy in the same body", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 0 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(400);
    expect(config.accountPoolStrategy).toBe("quota");
    expect(config.accountPoolStickyLimit).toBe(1);
  });

  test("PUT /api/codex-auth/pool-strategy rejects non-object JSON bodies with 400", async () => {
    for (const raw of ["null", "[]", "\"round-robin\"", "1"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
      expect(await resp!.json()).toMatchObject({ error: "body must be an object" });
    }
  });
});
describe("Anthropic account pool strategy management API", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;

  function baseConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
      },
    } as OcxConfig;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-pool-mgmt-codex-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-mgmt-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(baseConfig());
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      anthropic: {
        activeAccountId: "aaaa1111",
        accounts: [
          { id: "aaaa1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "a@example.com", accountId: "acct-1" } },
        ],
      },
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
  });

  test("GET /api/oauth/accounts/pool surfaces strategy defaults", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        strategy: "quota",
        stickyLimit: 1,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid strategy", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "weighted",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects non-object JSON bodies with 400", async () => {
    const server = startServer(0);
    try {
      for (const raw of ["null", "[]", "\"round-robin\""]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "body must be an object" });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid stickyLimit", async () => {
    const server = startServer(0);
    try {
      for (const bad of [0, 101, 2.5]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "anthropic",
            enabled: false,
            stickyLimit: bad,
          }),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool accepts strategy and stickyLimit; GET reflects them", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          autoSwitchThreshold: 70,
          strategy: "round-robin",
          stickyLimit: 4,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true,
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT without strategy fields preserves previously saved strategy", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "fill-first",
          stickyLimit: 9,
        }),
      });
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: false,
          autoSwitchThreshold: 50,
        }),
      });
      expect(put.status).toBe(200);
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: false,
        autoSwitchThreshold: 50,
        strategy: "fill-first",
        stickyLimit: 9,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH with provider+strategy omits enabled and keeps current enabled", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "quota",
        }),
      });
      const patch = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          strategy: "round-robin",
        }),
      });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({
        ok: true,
        enabled: true,
        strategy: "round-robin",
      });
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        strategy: "round-robin",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("GET returns quotaWindow five-hour by default", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ quotaWindow: "five-hour" });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT persists each valid quotaWindow value", async () => {
    const server = startServer(0);
    try {
      for (const quotaWindow of ["weekly", "max-utilization", "five-hour"]) {
        const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow }),
        });
        expect(put.status).toBe(200);
        expect(await put.json()).toMatchObject({ ok: true, quotaWindow });

        const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
        expect(await get.json()).toMatchObject({ quotaWindow });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT rejects invalid quotaWindow with 400", async () => {
    const server = startServer(0);
    try {
      for (const bad of ["monthly", "", "Weekly", 1, null]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow: bad }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error: "quotaWindow must be one of: five-hour, weekly, max-utilization",
        });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT without quotaWindow preserves the existing value", async () => {
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow: "weekly" }),
      });
      expect(first.status).toBe(200);

      const second = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enabled: false, autoSwitchThreshold: 55 }),
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ quotaWindow: "weekly" });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: false,
        autoSwitchThreshold: 55,
        quotaWindow: "weekly",
      });
    } finally {
      await server.stop(true);
    }
  });
  test("the inert marker describes strategy/threshold only, never enabled", async () => {
    // `inert: true` used to read as "the whole DTO changes nothing". That stopped being true
    // when reactive and proactive activation were split: `enabled: false` still refuses the
    // pre-dispatch account preference, it just can no longer refuse 429 rotation. A dashboard
    // reading `inert` as covering `enabled` would render a live control as decorative.
    const source = await Bun.file("src/oauth/pool-settings-capability.ts").text();
    const start = source.indexOf("autoSwitchThreshold: number | null;");
    const marker = source.slice(start, source.indexOf("inert: true;", start));
    expect(marker).toContain("strategy");
    expect(marker).toContain("autoSwitchThreshold");
    expect(marker).toContain("enabled");
  });
});

describe("generic OAuth pool-settings contract (#695)", () => {
  let previousHome: string | undefined;
  let testDir = "";
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-generic-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "deepseek-key-fixture" },
      },
    } as OcxConfig);
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
  });

  test("GET/PUT round-trip for a generic OAuth provider; api-key providers and bad values get 400", async () => {
    const server = startServer(0);
    try {
      const absent = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(absent.status).toBe(200);
      expect(await absent.json()).toEqual({ provider: "google-antigravity", kind: "generic", enabled: null, strategy: null, autoSwitchThreshold: null, inert: true });

      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", strategy: "fill-first", autoSwitchThreshold: 90, enabled: true }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, strategy: "fill-first", autoSwitchThreshold: 90, enabled: true, inert: true });
      const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf8"));
      expect(saved.providers["google-antigravity"].oauthAccountFailover).toEqual({ enabled: true, strategy: "fill-first", autoSwitchThreshold: 90 });

      for (const body of [
        { provider: "google-antigravity", strategy: "weighted" },
        { provider: "google-antigravity", autoSwitchThreshold: 101 },
        { provider: "google-antigravity", stickyLimit: 3 },
        { provider: "deepseek", strategy: "quota" },
      ]) {
        const bad = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        expect(bad.status).toBe(400);
      }
      expect((await fetch(new URL("/api/oauth/accounts/pool?provider=deepseek", server.url))).status).toBe(400);

      const clear = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", strategy: null, autoSwitchThreshold: null }),
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toMatchObject({ strategy: null, autoSwitchThreshold: null, enabled: true });
    } finally {
      await server.stop(true);
    }
  });
});

describe("Cursor account pool management API", () => {
  let testDir = "";
  let previousHome: string | undefined;

  function cursorBaseConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "cursor",
      providers: {
        cursor: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          authMode: "oauth",
        },
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "deepseek-key-fixture",
        },
      },
    } as OcxConfig;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-cursor-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(cursorBaseConfig());
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
  });

  function writeCursorAuthStore(
    accounts: Array<{
      id: string;
      alias?: string;
      access?: string;
      refresh?: string;
      expires?: number;
      needsReauth?: boolean;
    }>,
  ) {
    writeFileSync(
      join(testDir, "auth.json"),
      JSON.stringify({
        cursor: {
          activeAccountId: accounts[0]?.id ?? "",
          accounts: accounts.map((a) => ({
            id: a.id,
            ...(a.alias ? { alias: a.alias } : {}),
            credential: {
              access: a.access ?? "access-token-fixture",
              refresh: a.refresh ?? "refresh-token-fixture",
              expires: a.expires ?? 9999999999999,
            },
            ...(a.needsReauth ? { needsReauth: true } : {}),
          })),
        },
      }),
      { mode: 0o600 },
    );
  }

  function recursiveScanForSecrets(obj: unknown, forbidden: string[]) {
    if (!obj) return;
    if (typeof obj === "string") {
      for (const secret of forbidden) {
        expect(obj).not.toContain(secret);
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        recursiveScanForSecrets(item, forbidden);
      }
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        for (const secret of forbidden) {
          expect(k).not.toContain(secret);
        }
        recursiveScanForSecrets(v, forbidden);
      }
    }
  }

  test("defaults: omission defaults to disabled and returns aggregateStatus disabled", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        provider: "cursor",
        enabled: false,
        status: "disabled",
        aggregateStatus: "disabled",
        accounts: [],
      });
    } finally {
      await server.stop(true);
    }
  });

  test("strict: rejects knobs, accountId, and non-boolean enabled in PUT/PATCH", async () => {
    const server = startServer(0);
    try {
      // Rejects knobs
      for (const body of [
        { provider: "cursor", enabled: true, autoSwitchThreshold: 80 },
        { provider: "cursor", enabled: true, strategy: "quota" },
        { provider: "cursor", enabled: true, stickyLimit: 1 },
        { provider: "cursor", enabled: true, quotaWindow: "five-hour" },
      ]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "cursor pool does not support knobs" });
      }

      // Rejects accountId
      for (const body of [
        { provider: "cursor", enabled: true, accountId: "acc-1" },
        { provider: "cursor", enabled: true, id: "acc-1" },
        { provider: "cursor", enabled: true, account: "acc-1" },
      ]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "cursor pool toggle does not accept account ID" });
      }

      // Rejects non-boolean enabled
      for (const val of ["true", 1, null, {}, []]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "cursor", enabled: val }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "enabled must be a boolean" });
      }

      // Rejects unknown unexpected fields
      const resUnknown = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true, extraKey: "unexpected" }),
      });
      expect(resUnknown.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("undersized: reports undersized when enabled: true but fewer than 2 usable accounts exist", async () => {
    writeCursorAuthStore([]);
    const server = startServer(0);
    try {
      let put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        provider: "cursor",
        enabled: true,
        aggregateStatus: "undersized",
        accounts: [],
      });

      // 1 usable account
      writeCursorAuthStore([{ id: "acc-1", access: "token-1" }]);
      let get = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({
        provider: "cursor",
        enabled: true,
        aggregateStatus: "undersized",
        accounts: [{ ordinal: 1, usable: true }],
      });

      // 2 accounts but one is expired (expires in past)
      writeCursorAuthStore([
        { id: "acc-1", access: "token-1", expires: 9999999999999 },
        { id: "acc-2", access: "token-2", expires: 100 },
      ]);
      get = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        aggregateStatus: "undersized",
        accounts: [
          { ordinal: 1, usable: true },
          { ordinal: 2, usable: false },
        ],
      });

      // 2 accounts but one has needsReauth: true
      writeCursorAuthStore([
        { id: "acc-1", access: "token-1", expires: 9999999999999 },
        { id: "acc-2", access: "token-2", expires: 9999999999999, needsReauth: true },
      ]);
      get = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        aggregateStatus: "undersized",
        accounts: [
          { ordinal: 1, usable: true },
          { ordinal: 2, usable: false },
        ],
      });

      // 2 usable accounts -> ready!
      writeCursorAuthStore([
        { id: "acc-1", access: "token-1", expires: 9999999999999 },
        { id: "acc-2", access: "token-2", expires: 9999999999999 },
      ]);
      get = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        aggregateStatus: "ready",
        status: "ready",
        accounts: [
          { ordinal: 1, usable: true },
          { ordinal: 2, usable: true },
        ],
      });
    } finally {
      await server.stop(true);
    }
  });

  test("auth: requires authenticated mutation principal, rejecting unauthenticated or unauthorized principals", async () => {
    const server = startServer(0);
    try {
      // Unauthenticated on the wire (no auth header) -> 401
      const unauth = await globalThis.fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true }),
      });
      expect(unauth.status).toBe(401);

      // Authenticated with admin-token through managementFetch -> 200
      const auth = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true }),
      });
      expect(auth.status).toBe(200);
      expect(await auth.json()).toMatchObject({ ok: true, enabled: true });

      // Direct dispatch checks for mutation principal rules
      const config = cursorBaseConfig();
      const url = new URL("http://127.0.0.1:10100/api/oauth/accounts/pool");
      const makeReq = () => new Request(url, {
        method: "PUT",
        headers: { host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true }),
      });

      // Unauthorized mutation principals -> 403
      for (const unauthorized of [undefined, "local-read-capability", "gui-pair-capability"] as const) {
        const res = await handleManagementAPI(makeReq(), url, config, {}, unauthorized);
        expect(res?.status).toBe(403);
        expect(await res?.json()).toMatchObject({ error: "unauthorized mutation principal" });
      }

      // Authorized mutation principals -> 200
      for (const authorized of ["admin-token", "gui-session"] as const) {
        const res = await handleManagementAPI(makeReq(), url, config, {}, authorized);
        expect(res?.status).toBe(200);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("persistence failure: handles persistence error gracefully without leaking secrets and preserves unrelated config", async () => {
    const config = cursorBaseConfig();
    const url = new URL("http://127.0.0.1:10100/api/oauth/accounts/pool");
    const failingDeps = {
      saveConfigPreservingClaudeCode: () => {
        throw new Error("Simulated disk I/O failure");
      },
    };
    const req = new Request(url, {
      method: "PUT",
      headers: { host: "127.0.0.1:10100", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "cursor", enabled: true }),
    });
    const res = await handleManagementAPI(req, url, config, failingDeps, "admin-token");
    expect(res?.status).toBe(500);
    const body = await res?.json();
    expect(body).toMatchObject({ error: "failed to persist cursor pool configuration" });
    expect(JSON.stringify(body)).not.toContain("Simulated disk I/O failure");

    // Unrelated config sections preserved
    expect(config.providers.deepseek).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "deepseek-key-fixture",
    });
  });

  test("recursive secret-ID scan: never exposes account IDs, JWTs, emails, tokens, or raw secrets", async () => {
    const secretId1 = "acc_super_secret_id_11111";
    const secretId2 = "acc_super_secret_id_22222";
    const secretJwt = ["ey", "JhbGciOi", "JIUzI1NiI", "sinR5cCI6Ik", "pXVCJ9.sensitive_payload_bytes.signature"].join("");
    const secretRefresh = "rt_secret_refresh_token_99999";
    const secretEmail = "secret_dev_user@example.com";

    writeCursorAuthStore([
      { id: secretId1, access: secretJwt, refresh: secretRefresh, alias: "Dev Account" },
      { id: secretId2, access: "access-token-2", refresh: "refresh-token-2", alias: "Prod Account" },
    ]);
    const server = startServer(0);
    try {
      const getRes = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(getRes.status).toBe(200);
      const getRaw = await getRes.text();
      const getJson = JSON.parse(getRaw);

      const secrets = [secretId1, secretId2, secretJwt, secretRefresh, secretEmail, "sensitive_payload_bytes"];
      for (const secret of secrets) {
        expect(getRaw).not.toContain(secret);
      }
      recursiveScanForSecrets(getJson, secrets);

      for (const acc of getJson.accounts) {
        expect(acc).not.toHaveProperty("id");
        expect(acc).not.toHaveProperty("accountId");
        expect(acc).not.toHaveProperty("token");
        expect(acc).not.toHaveProperty("access");
        expect(acc).not.toHaveProperty("email");
        expect(acc).toHaveProperty("ordinal");
        expect(acc).toHaveProperty("alias");
        expect(acc).toHaveProperty("usable");
      }

      const putRes = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", enabled: true }),
      });
      expect(putRes.status).toBe(200);
      const putRaw = await putRes.text();
      const putJson = JSON.parse(putRaw);
      for (const secret of secrets) {
        expect(putRaw).not.toContain(secret);
      }
      recursiveScanForSecrets(putJson, secrets);
      for (const acc of putJson.accounts) {
        expect(acc).not.toHaveProperty("id");
        expect(acc).not.toHaveProperty("accountId");
        expect(acc).not.toHaveProperty("token");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("alias stability: preserves valid aliases and falls back safely to stable ordinals", async () => {
    writeCursorAuthStore([
      { id: "acc-1", access: "tok-1", alias: "Primary Machine" },
      { id: "acc-2", access: "tok-2" },
      { id: "acc-3", access: "tok-3", alias: "Invalid\x00Control\x07Chars" },
      { id: "acc-4", access: "tok-4", alias: "A".repeat(81) },
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.accounts).toEqual([
        { ordinal: 1, alias: "Primary Machine", usable: true },
        { ordinal: 2, alias: "Account 2", usable: true },
        { ordinal: 3, alias: "Account 3", usable: true },
        { ordinal: 4, alias: "Account 4", usable: true },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});
