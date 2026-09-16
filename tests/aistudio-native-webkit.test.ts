import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAiStudioNativeDaemon,
  getAiStudioNativeDaemonSourcePath,
  isNativeWebKitSupported,
  runAiStudioNativeLogin,
} from "../src/oauth/aistudio-native-daemon";

describe("Google AI Studio Native Hardened WebKit Daemon", () => {
  test("native webkit platform support detection on macOS", () => {
    expect(isNativeWebKitSupported()).toBe(process.platform === "darwin");
  });

  test("runAiStudioNativeLogin is unsupported off macOS without a test spawn", async () => {
    const result = await runAiStudioNativeLogin({ platform: "linux" });
    expect(result).toEqual({ kind: "unsupported" });
  });

  test("runAiStudioNativeLogin authenticates after exit 0 and a valid session", async () => {
    const result = await runAiStudioNativeLogin({
      platform: "linux",
      spawn: () => ({ exited: Promise.resolve(0) }),
      loadSession: () => ({ selectedProject: "p", windowId: "w", cookies: [{ name: "SAPISID", value: "ok" }] }),
      sessionPath: "/tmp/aistudio-session.json",
    });
    expect(result).toEqual({ kind: "authenticated", sessionPath: "/tmp/aistudio-session.json" });
  });

  test("runAiStudioNativeLogin maps exit 2 to cancelled", async () => {
    const result = await runAiStudioNativeLogin({
      spawn: () => ({ exited: Promise.resolve(2) }),
    });
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("runAiStudioNativeLogin maps exit 1 to failed", async () => {
    const result = await runAiStudioNativeLogin({
      spawn: () => ({ exited: Promise.resolve(1) }),
    });
    expect(result.kind).toBe("failed");
  });

  test("runAiStudioNativeLogin rejects a missing harvested session", async () => {
    const result = await runAiStudioNativeLogin({
      spawn: () => ({ exited: Promise.resolve(0) }),
      loadSession: () => null,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("valid session");
  });

  test("runAiStudioNativeLogin kills the child when aborted", async () => {
    const killed: string[] = [];
    const controller = new AbortController();
    let release!: (code: number) => void;
    const pending = new Promise<number>((resolve) => { release = resolve; });
    const running = runAiStudioNativeLogin({
      spawn: () => ({
        exited: pending,
        kill: () => { killed.push("kill"); release(2); },
      }),
      signal: controller.signal,
    });
    controller.abort();
    expect(await running).toEqual({ kind: "cancelled" });
    expect(killed).toEqual(["kill"]);
  });

  test("main.swift is login-only with window-close cancellation", () => {
    const swiftPath = getAiStudioNativeDaemonSourcePath();
    expect(existsSync(swiftPath)).toBe(true);
    const code = readFileSync(swiftPath, "utf-8");
    expect(code).toContain("Version/18.3 Safari/605.1.15");
    expect(code).toContain("WKWebsiteDataStore");
    expect(code).toContain("posixPermissions");
    expect(code).toContain("JSONSerialization.data(withJSONObject:");
    expect(code).toContain("windowWillClose");
    expect(code).toContain("exit(2)");
    expect(code).toContain("exit(0)");
    expect(code).toContain("exit(1)");
    expect(code).not.toContain("/v1/ws/aistudio");
    expect(code).not.toContain("XMLHttpRequest");
    expect(code).not.toContain("setActivationPolicy(.prohibited)");
  });

  test.skipIf(process.platform !== "darwin")("swiftc compiles main.swift successfully", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "aistudio-test-"));
    const outBin = join(outDir, "daemon");
    const binPath = await buildAiStudioNativeDaemon(outBin);
    expect(existsSync(binPath)).toBe(true);
  }, 30_000);
});
