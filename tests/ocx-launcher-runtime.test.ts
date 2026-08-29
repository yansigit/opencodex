import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundledBunPath } from "../src/lib/bun-runtime";
import { killProxy } from "../src/lib/process-control";
import { OPENAI_PROVIDER_TIER_VERSION } from "../src/types";

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = spawnSync("node", ["--version"], {
  stdio: "ignore",
  windowsHide: true,
}).status === 0;
const runnable = process.platform === "win32" && nodeAvailable;

type Health = {
  status: string;
  service: string;
  pid: number;
  port: number;
};

type WindowsProcessIdentity = {
  pid: number;
  parentPid: number;
  executablePath: string;
  creationDate: string;
};

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
    });
  });
}

async function healthAt(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    const body = await response.json() as Health;
    return body?.status === "ok"
      && body.service === "opencodex"
      && Number.isSafeInteger(body.pid)
      && body.pid > 0
      && body.port === port
      ? body
      : null;
  } catch {
    return null;
  }
}

async function waitForHealth(
  port: number,
  deadlineMs: number,
  launcher: ChildProcess,
): Promise<Health | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) return null;
    const health = await healthAt(port);
    if (health) return health;
    await Bun.sleep(200);
  }
  return null;
}

function windowsProcessIdentity(pid: number): WindowsProcessIdentity | null {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -ne $p) { $p | Select-Object ProcessId, ParentProcessId, ExecutablePath, CreationDate | ConvertTo-Json -Compress }`,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`could not inspect process identity: ${result.stderr.trim()}`);
  if (!result.stdout.trim()) return null;
  const value = JSON.parse(result.stdout) as {
    ProcessId?: number;
    ParentProcessId?: number;
    ExecutablePath?: string;
    CreationDate?: string;
  };
  if (
    !Number.isSafeInteger(value.ProcessId)
    || !Number.isSafeInteger(value.ParentProcessId)
    || typeof value.ExecutablePath !== "string"
    || typeof value.CreationDate !== "string"
  ) {
    throw new Error("process identity response was incomplete");
  }
  return {
    pid: value.ProcessId!,
    parentPid: value.ParentProcessId!,
    executablePath: value.ExecutablePath,
    creationDate: value.CreationDate,
  };
}

function canonicalWindowsPath(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase();
  } catch {
    return resolve(path).toLowerCase();
  }
}

function sameWindowsPath(actual: string, expected: string): boolean {
  return canonicalWindowsPath(actual) === canonicalWindowsPath(expected);
}

function sameProcess(actual: WindowsProcessIdentity | null, expected: WindowsProcessIdentity): boolean {
  return actual !== null
    && actual.pid === expected.pid
    && actual.creationDate === expected.creationDate
    && sameWindowsPath(actual.executablePath, expected.executablePath);
}

function captureWindowsProcessIdentity(pid: number): WindowsProcessIdentity {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const identity = windowsProcessIdentity(pid);
      if (identity) return identity;
    } catch (error) {
      lastError = error;
    }
    Bun.sleepSync(100);
  }
  throw new Error(`could not capture process identity for PID ${pid}: ${String(lastError ?? "process not found")}`);
}

function inspectWindowsProcessIdentity(pid: number): WindowsProcessIdentity | null {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return windowsProcessIdentity(pid);
    } catch (error) {
      lastError = error;
      Bun.sleepSync(100);
    }
  }
  throw lastError;
}

function removeTree(path: string): void {
  // Windows can retain the copied executable's image handle briefly after
  // taskkill returns. Retry only transient fixture-cleanup errors, with a cap.
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(code)) throw error;
      lastError = error;
      Bun.sleepSync(200);
    }
  }
  throw lastError;
}

async function effectiveRuntime(override: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-"));
  let port: number | null = null;
  let launcher: ChildProcess | null = null;
  let launcherPid: number | null = null;
  let ownedLauncher: WindowsProcessIdentity | null = null;
  let ownedProxy: WindowsProcessIdentity | null = null;
  let runtimePath: string | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    port = await freePort();
    launcher = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
      stdio: "ignore",
      windowsHide: true,
      env: isolatedLauncherEnv(root, override),
    });
    if (!launcher.pid) throw new Error("Node launcher has no process id");
    launcherPid = launcher.pid;
    ownedLauncher = captureWindowsProcessIdentity(launcherPid);

    const health = await waitForHealth(port, 25_000, launcher);
    if (!health) throw new Error("proxy did not become healthy");
    const identity = windowsProcessIdentity(health.pid);
    if (!identity || identity.parentPid !== launcher.pid) {
      throw new Error("health PID is not the spawned Node launcher's direct Bun child");
    }
    ownedProxy = identity;
    runtimePath = identity.executablePath;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors: string[] = [];
  let launcherTreeStopped = false;

  // Prefer the creation-time/path identity. If the initial CIM capture failed,
  // the live ChildProcess handle and its PID are still positive ownership of
  // this test's launcher, so terminate that exact process tree as a fallback.
  if (ownedLauncher) {
    try {
      if (sameProcess(inspectWindowsProcessIdentity(ownedLauncher.pid), ownedLauncher)) {
        killProxy(ownedLauncher.pid);
        launcherTreeStopped = true;
      }
    } catch (error) {
      cleanupErrors.push(`launcher cleanup failed: ${String(error)}`);
    }
  }
  if (!launcherTreeStopped && launcher && launcherPid && launcher.exitCode === null && launcher.signalCode === null) {
    try {
      killProxy(launcherPid);
      launcherTreeStopped = true;
    } catch (error) {
      cleanupErrors.push(`launcher tree fallback failed: ${String(error)}`);
    }
  }

  // The launcher tree kill normally removes the Bun child. Retain the
  // identity-verified proxy fallback in case the launcher exited first.
  if (ownedProxy) {
    try {
      if (sameProcess(inspectWindowsProcessIdentity(ownedProxy.pid), ownedProxy)) {
        killProxy(ownedProxy.pid);
      }
    } catch (error) {
      cleanupErrors.push(`proxy cleanup failed: ${String(error)}`);
    }
  }

  // Inspection failures are reported, but never prevent the remaining
  // process checks or fixture cleanup from running.
  for (const [label, identity] of [
    ["launcher", ownedLauncher],
    ["proxy", ownedProxy],
  ] as const) {
    if (!identity) continue;
    try {
      if (sameProcess(inspectWindowsProcessIdentity(identity.pid), identity)) {
        cleanupErrors.push(`owned ${label} PID ${identity.pid} remained after bounded cleanup`);
      }
    } catch (error) {
      cleanupErrors.push(`${label} cleanup verification failed: ${String(error)}`);
    }
  }
  if (port !== null) {
    const lingeringProxy = await healthAt(port);
    if (lingeringProxy) {
      cleanupErrors.push(`OpenCodex proxy PID ${lingeringProxy.pid} remained on owned port ${port}`);
    }
  }
  try {
    removeTree(root);
  } catch (error) {
    cleanupErrors.push(`fixture cleanup failed: ${String(error)}`);
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) console.error(`additional cleanup errors: ${cleanupErrors.join("; ")}`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  if (!runtimePath) throw new Error("proxy runtime path was not captured");
  return runtimePath;
}

function isolatedLauncherEnv(root: string, override: string): NodeJS.ProcessEnv {
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  const grokHome = join(root, "grok");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCODEX_HOME: opencodexHome,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    OPENCODEX_BUN_PATH: override,
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

type FirstStartupCleanupDeps = {
  probe: typeof healthAt;
  kill: (pid: number) => void;
  remove: (path: string) => void;
};

async function cleanupFirstStartup(
  root: string,
  configDir: string,
  launcher: ChildProcess | null,
  health: Health | null,
  deps: FirstStartupCleanupDeps = { probe: healthAt, kill: killProxy, remove: removeTree },
): Promise<void> {
  const errors: string[] = [];
  if (health) {
    let owned = false;
    try {
      const runtime = JSON.parse(readFileSync(join(configDir, "runtime-port.json"), "utf8")) as { pid?: number; port?: number };
      const pid = Number(readFileSync(join(configDir, "ocx.pid"), "utf8").trim());
      owned = pid === health.pid && runtime.pid === health.pid && runtime.port === health.port;
    } catch { /* clean shutdown removes runtime ownership state */ }
    if (owned) try {
      const live = await deps.probe(health.port);
      if (live?.pid === health.pid) deps.kill(health.pid);
    } catch (error) {
      errors.push(`proxy cleanup: ${String(error)}`);
    }
  }
  if (launcher?.pid && launcher.exitCode === null && launcher.signalCode === null) {
    try { deps.kill(launcher.pid); } catch (error) { errors.push(`launcher cleanup: ${String(error)}`); }
  }
  try { deps.remove(root); } catch (error) { errors.push(`root cleanup: ${String(error)}`); }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

test("first-start cleanup attempts every owned resource when one cleanup step fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-launcher-cleanup-"));
  const configDir = join(root, "opencodex");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "runtime-port.json"), JSON.stringify({ pid: 11, port: 10100 }));
  writeFileSync(join(configDir, "ocx.pid"), "11");
  const calls: string[] = [];
  const launcher = { pid: 22, exitCode: null, signalCode: null } as ChildProcess;
  const error = await cleanupFirstStartup(root, configDir, launcher, {
    status: "ok", service: "opencodex", pid: 11, port: 10100,
  }, {
    probe: async () => ({ status: "ok", service: "opencodex", pid: 11, port: 10100 }),
    kill: pid => { calls.push(`kill:${pid}`); throw new Error(`${pid} kill failed`); },
    remove: path => { calls.push(`remove:${path}`); throw new Error("remove failed"); },
  }).then(() => null, cause => cause as Error);
  expect(calls).toEqual(["kill:11", "kill:22", `remove:${root}`]);
  expect(error?.message).toContain("11 kill failed");
  expect(error?.message).toContain("22 kill failed");
  expect(error?.message).toContain("remove failed");
  removeTree(root);
});

test("first-start cleanup never hard-kills a health PID without matching isolated runtime state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-launcher-ownership-"));
  const configDir = join(root, "opencodex");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "runtime-port.json"), JSON.stringify({ pid: 99, port: 10100 }));
  writeFileSync(join(configDir, "ocx.pid"), "99");
  const killed: number[] = [];
  await cleanupFirstStartup(root, configDir, null, {
    status: "ok", service: "opencodex", pid: 11, port: 10100,
  }, {
    probe: async () => ({ status: "ok", service: "opencodex", pid: 11, port: 10100 }),
    kill: pid => { killed.push(pid); },
    remove: removeTree,
  });
  expect(killed).toEqual([]);
});

describe.skipIf(!nodeAvailable)("ocx npm launcher first startup", () => {
  test("preserves an existing six-provider registry when startup defaults are saved", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-first-start-"));
    const env = { ...isolatedLauncherEnv(root, process.execPath), CI: "1" };
    const configPath = join(env.OPENCODEX_HOME!, "config.json");
    const providers = {
      openai: { adapter: "openai-chat", baseUrl: "https://openai.example.test/v1" },
      anthropic: { adapter: "openai-chat", baseUrl: "https://anthropic.example.test/v1" },
      google: { adapter: "openai-chat", baseUrl: "https://google.example.test/v1" },
      grok: { adapter: "openai-chat", baseUrl: "https://grok.example.test/v1" },
      deepseek: { adapter: "openai-chat", baseUrl: "https://deepseek.example.test/v1" },
      ollama: { adapter: "openai-chat", baseUrl: "https://ollama.example.test/v1" },
    };
    let launcher: ChildProcess | null = null;
    let health: Health | null = null;
    try {
      const port = await freePort();
      writeFileSync(configPath, JSON.stringify({
        port,
        openaiProviderTierVersion: OPENAI_PROVIDER_TIER_VERSION,
        providers,
        defaultProvider: "openai",
      }, null, 2));
      launcher = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
        env,
        stdio: "ignore",
        windowsHide: true,
      });
      health = await waitForHealth(port, 25_000, launcher);
      if (!health) throw new Error("proxy did not become healthy through bin/ocx.mjs");

      const during = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(during.subagentModels).toBeArray();
      expect(Object.keys(during.providers as object)).toEqual(Object.keys(providers));
      expect(during.providers).toEqual(providers);
      expect(during.defaultProvider).toBe("openai");

      const stopped = spawnSync("node", [BIN_OCX, "stop"], {
        env,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      expect(stopped.status).toBe(0);
      expect(await waitForExit(launcher, 15_000)).toBe(true);

      const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(after.providers as object)).toEqual(Object.keys(providers));
      expect(after.providers).toEqual(providers);
      expect(after.defaultProvider).toBe("openai");
    } finally {
      await cleanupFirstStartup(root, env.OPENCODEX_HOME!, launcher, health);
    }
  }, 120_000);
});

describe.skipIf(!nodeAvailable)("ocx npm launcher relative Bun override", () => {
  test("resolves a valid bare relative override before spawning", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-relative-"));
    try {
      const overrideName = `custom-bun${process.platform === "win32" ? ".exe" : ""}`;
      const override = join(root, overrideName);
      copyFileSync(process.execPath, override);
      chmodSync(override, 0o755);

      const result = spawnSync("node", [BIN_OCX, "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: isolatedLauncherEnv(root, overrideName),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("OPENCODEX_BUN_PATH is missing");
    } finally {
      removeTree(root);
    }
  }, 60_000);

  test("warns without exposing the rejected override path before bundled fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-invalid-"));
    try {
      const overrideName = `stub-bun${process.platform === "win32" ? ".exe" : ""}`;
      writeFileSync(join(root, overrideName), "not a Bun executable", "utf8");

      const result = spawnSync("node", [BIN_OCX, "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: isolatedLauncherEnv(root, overrideName),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("OPENCODEX_BUN_PATH is missing, unreadable, or not a complete Bun binary");
      expect(result.stderr).not.toContain(root);
    } finally {
      removeTree(root);
    }
  }, 60_000);
});

describe.skipIf(!runnable)("ocx npm launcher effective Bun runtime", () => {
  test("uses a valid OPENCODEX_BUN_PATH for the actual proxy process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-copy-"));
    try {
      const override = join(root, "override-bun.exe");
      copyFileSync(process.execPath, override);
      expect(sameWindowsPath(await effectiveRuntime(override), override)).toBe(true);
    } finally {
      removeTree(root);
    }
  }, 120_000);

  test("falls back to bundled Bun for a sub-1MB override stub", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-stub-"));
    try {
      const stub = join(root, "stub-bun.exe");
      writeFileSync(stub, "not a Bun executable", "utf8");
      const bundled = bundledBunPath();
      expect(bundled).not.toBeNull();
      expect(sameWindowsPath(await effectiveRuntime(stub), bundled!)).toBe(true);
    } finally {
      removeTree(root);
    }
  }, 120_000);
});
