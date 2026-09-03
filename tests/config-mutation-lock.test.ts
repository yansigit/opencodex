import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigMutationLockError, loadConfig, saveConfig, withConfigMutationLockSync } from "../src/config";
import { CodexCredentialRefreshLockTimeoutError, getCodexAccountCredential, saveCodexAccountCredential } from "../src/codex/account-store";
import type { OcxConfig } from "../src/types";
import { ManagementRequest, managementHeaders } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "./helpers/test-budget";

let testRoot = "";
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

// A cold `bun -e` child that imports the full src/config.ts graph took longer than
// the old flat 5s caps to even start on a loaded Windows shard (main CI run
// 33721627451, attempt 1: three fails, one of them masked to "exited 143"). These
// deadlines bound startup latency, not contention: the fail-fast <1s assertion
// below still proves contention, and the budgets stay 3x under SPAWN_BUDGET_MS so
// a genuine hang fails here with the child's stderr rather than as a lane timeout.
async function waitForPath(path: string, timeoutMs = INTERNAL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child marker ${path} after ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}

async function waitForOwnedChild(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs = INTERNAL_DEADLINE_MS,
): Promise<number> {
  const result = await Promise.race([
    child.exited.then(exitCode => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (result) return result.exitCode;
  child.kill();
  await child.exited;
  const stderr = await new Response(child.stderr).text().catch(() => "");
  throw new Error(
    `Timed out waiting for owned config-lock child after ${timeoutMs}ms\nchild stderr: ${stderr}`,
  );
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-config-mutation-lock-"));
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

test("a live cross-process holder is not stolen and runtime writers fail immediately", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "holder-ready");
  const releasePath = join(testRoot, "holder-release");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    try {
      await waitForPath(readyPath);
    } catch (error) {
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    const startedAt = performance.now();
    expect(() => saveConfig(config(20200))).toThrow(ConfigMutationLockError);
    expect(() => saveCodexAccountCredential("busy-account", {
      accessToken: "busy-access",
      refreshToken: "busy-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "busy-chatgpt-account",
    })).toThrow(CodexCredentialRefreshLockTimeoutError);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(loadConfig().port).toBe(10100);
    expect(getCodexAccountCredential("busy-account")).toBeNull();
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }

  saveConfig(config(20200));
  saveCodexAccountCredential("busy-account", {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: Date.now() + 60_000,
    chatgptAccountId: "fresh-chatgpt-account",
  });
  expect(loadConfig().port).toBe(20200);
  expect(getCodexAccountCredential("busy-account")?.accessToken).toBe("fresh-access");
}, SPAWN_BUDGET_MS);

test("an abruptly exited holder releases the OS-backed transaction without stale recovery", async () => {
  saveConfig(config());
  const enteredPath = join(testRoot, "crashed-holder-entered");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(enteredPath)}, "entered");
      process.exit(0);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await waitForOwnedChild(child)).toBe(0);
  expect(existsSync(enteredPath)).toBe(true);
  expect(() => saveConfig(config(30300))).not.toThrow();
  expect(loadConfig().port).toBe(30300);
}, SPAWN_BUDGET_MS);

test("a throwing mutation releases the lock and leaves writers available", () => {
  saveConfig(config());
  expect(() => withConfigMutationLockSync(() => {
    throw new Error("mutation failed");
  })).toThrow("mutation failed");
  expect(() => saveConfig(config(50500))).not.toThrow();
  expect(loadConfig().port).toBe(50500);
});

test("management API maps config mutation lock contention to retryable 503", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "mgmt-holder-ready");
  const releasePath = join(testRoot, "mgmt-holder-release");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForPath(readyPath);
    const { handleManagementAPI } = await import("../src/server/management-api");
    const url = new URL("http://localhost/api/codex-auth/auto-switch");
    const response = await handleManagementAPI(
      new ManagementRequest(url, {
        method: "PUT",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ threshold: 50 }),
      }),
      url,
      config(),
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({
      error: "Configuration is busy; retry shortly",
      code: "CONFIG_MUTATION_LOCK_UNAVAILABLE",
    });
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }
}, SPAWN_BUDGET_MS);
