import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAiStudioNativeDaemon, getAiStudioNativeDaemonSourcePath, isNativeWebKitSupported, runAiStudioNativeLogin } from "../../../src/oauth/aistudio-native-daemon";
import { getAiStudioSessionPath, loadAiStudioSession, saveAiStudioSession } from "../../../src/oauth/aistudio-session-sync";
import { flushConfigDirHardeningForTests } from "../../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let testRoot = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(tmpdir(), "aistudio-native-test-"));
  process.env.OPENCODEX_HOME = join(testRoot, "opencodex-home");
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testRoot);
});

function outputPath(command: string[]): string {
  const index = command.indexOf("--session-output");
  expect(index).toBeGreaterThan(0);
  const path = command[index + 1];
  expect(path).toBeDefined();
  return path!;
}

const validSession = (value: string) => ({
  selectedProject: "p",
  windowId: "w",
  cookies: [{ name: "SAPISID", value }],
});

describe("Google AI Studio Native Hardened WebKit Daemon", () => {
  test("native webkit platform support detection on macOS", () => {
    expect(isNativeWebKitSupported()).toBe(process.platform === "darwin");
  });

  test("main.swift contains hardened security configurations", () => {
    const swiftPath = getAiStudioNativeDaemonSourcePath();
    expect(existsSync(swiftPath)).toBe(true);

    const code = readFileSync(swiftPath, "utf-8");
    // Native login is a visible WebKit session; there is no headless relay.
    expect(code).not.toContain("setActivationPolicy(.prohibited)");
    // 2. Desktop Safari masking
    expect(code).toContain("Version/18.3 Safari/605.1.15");
    // 3. Storage isolation
    expect(code).toContain("websiteDataStore");
    // 4. Navigation sandbox
    expect(code).toContain("decidePolicyFor navigationAction");
    expect(code).not.toContain("WKUserScript");
    expect(code).not.toContain("/v1/ws/aistudio");
    expect(code).toContain("posixPermissions");
    expect(code).toContain("--session-output");
    expect(code).not.toContain("homeDirectoryForCurrentUser");
    expect(code).toContain("0o700");
    expect(code).toContain("JSONSerialization.data(withJSONObject:");
    expect(code).toContain("cMap.domain");
    expect(code).toContain("exit(2)");
    expect(code).toContain("exit(1)");
  });

  test("awaited native login validates the saved session before success", async () => {
    const sessionPath = join(testRoot, "aistudio-session.json");
    saveAiStudioSession(validSession("stale"), sessionPath);
    let stagingPath = "";
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      sessionPath,
      spawn: command => {
        stagingPath = outputPath(command);
        writeFileSync(stagingPath, JSON.stringify(validSession("fresh")), { mode: 0o600 });
        return { exited: Promise.resolve(0), kill() {} };
      },
    });
    expect(result).toEqual({ kind: "authenticated", sessionPath });
    expect(loadAiStudioSession(sessionPath)?.cookies[0]?.value).toBe("fresh");
    expect(stagingPath).not.toBe(sessionPath);
    expect(existsSync(stagingPath)).toBe(false);
  });

  test("native login uses the configured OpenCodex home and republishes the invocation output", async () => {
    const expectedPath = getAiStudioSessionPath();
    let stagingPath = "";
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      spawn: command => {
        stagingPath = outputPath(command);
        expect(stagingPath).not.toBe(expectedPath);
        writeFileSync(stagingPath, JSON.stringify(validSession("custom-home")), { mode: 0o600 });
        return { exited: Promise.resolve(0), kill() {} };
      },
    });
    expect(result).toEqual({ kind: "authenticated", sessionPath: expectedPath });
    expect(expectedPath.startsWith(process.env.OPENCODEX_HOME!)).toBe(true);
    expect(loadAiStudioSession(expectedPath)?.cookies[0]?.value).toBe("custom-home");
    expect(existsSync(stagingPath)).toBe(false);
  });

  test("native login rejects a stale destination when this invocation produced no output", async () => {
    const sessionPath = join(testRoot, "stale-session.json");
    saveAiStudioSession(validSession("stale"), sessionPath);
    let stagingPath = "";
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      sessionPath,
      spawn: command => {
        stagingPath = outputPath(command);
        return { exited: Promise.resolve(0), kill() {} };
      },
    });
    expect(result).toEqual({ kind: "failed", error: "Native login completed without a valid AI Studio session" });
    expect(loadAiStudioSession(sessionPath)?.cookies[0]?.value).toBe("stale");
    expect(existsSync(stagingPath)).toBe(false);
  });

  test("native login reports unsupported on non-macOS platforms", async () => {
    const result = await runAiStudioNativeLogin({ platform: "linux" });
    expect(result).toEqual({ kind: "unsupported" });
  });

  test("native login reports failure for non-zero exit codes", async () => {
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      spawn: () => ({ exited: Promise.resolve(1), kill() {} }),
    });
    expect(result).toEqual({ kind: "failed", error: "Native AI Studio login failed (exit code 1)" });
  });

  test("native login reports failure when exit 0 leaves an invalid session", async () => {
    const sessionPath = join(testRoot, "aistudio-session.json");
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      sessionPath,
      spawn: command => {
        writeFileSync(outputPath(command), JSON.stringify({ selectedProject: "p", windowId: "w", cookies: [] }), { mode: 0o600 });
        return { exited: Promise.resolve(0), kill() {} };
      },
    });
    expect(result).toEqual({ kind: "failed", error: "Native login completed without a valid AI Studio session" });
  });

  test("native login returns cancellation and terminates an aborted child", async () => {
    let killed = false;
    const controller = new AbortController();
    const resultPromise = runAiStudioNativeLogin({
      platform: "darwin",
      signal: controller.signal,
      spawn: () => ({ exited: new Promise<number>(resolve => setTimeout(() => resolve(2), 1)), kill: () => { killed = true; } }),
    });
    controller.abort();
    expect(await resultPromise).toEqual({ kind: "cancelled" });
    expect(killed).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("swiftc compiles main.swift successfully", async () => {
    const outDir = join(testRoot, "build");
    mkdirSync(outDir);
    const outBin = join(outDir, "daemon");
    const binPath = await buildAiStudioNativeDaemon(outBin);
    expect(existsSync(binPath)).toBe(true);
  }, 60_000);
});
