import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAiStudioNativeDaemon, getAiStudioNativeDaemonSourcePath, isNativeWebKitSupported, runAiStudioNativeLogin } from "../src/oauth/aistudio-native-daemon";

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
    expect(code).toContain("JSONSerialization.data(withJSONObject:");
    expect(code).toContain("cMap.domain");
    expect(code).toContain("exit(2)");
    expect(code).toContain("exit(1)");
  });

  test("awaited native login validates the saved session before success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aistudio-login-session-"));
    const sessionPath = join(dir, "aistudio-session.json");
    await Bun.write(sessionPath, JSON.stringify({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "ok" }] }));
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      sessionPath,
      spawn: () => ({ exited: Promise.resolve(0), kill() {} }),
    });
    expect(result).toEqual({ kind: "authenticated", sessionPath });
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
    const dir = mkdtempSync(join(tmpdir(), "aistudio-login-invalid-"));
    const sessionPath = join(dir, "aistudio-session.json");
    await Bun.write(sessionPath, JSON.stringify({ selectedProject: "p", windowId: "w", cookies: [] }));
    const result = await runAiStudioNativeLogin({
      platform: "darwin",
      sessionPath,
      spawn: () => ({ exited: Promise.resolve(0), kill() {} }),
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
    const outDir = mkdtempSync(join(tmpdir(), "aistudio-test-"));
    const outBin = join(outDir, "daemon");
    const binPath = await buildAiStudioNativeDaemon(outBin);
    expect(existsSync(binPath)).toBe(true);
  }, 30_000);
});
