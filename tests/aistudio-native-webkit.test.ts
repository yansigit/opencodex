import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAiStudioNativeDaemon, getAiStudioNativeDaemonSourcePath, isNativeWebKitSupported } from "../src/oauth/aistudio-native-daemon";

describe("Google AI Studio Native Hardened WebKit Daemon", () => {
  test("native webkit platform support detection on macOS", () => {
    expect(isNativeWebKitSupported()).toBe(process.platform === "darwin");
  });

  test("main.swift contains hardened security configurations", () => {
    const swiftPath = getAiStudioNativeDaemonSourcePath();
    expect(existsSync(swiftPath)).toBe(true);

    const code = readFileSync(swiftPath, "utf-8");
    // 1. Zero-window headless (no Dock icon)
    expect(code).toContain("setActivationPolicy(.prohibited)");
    // 2. Desktop Safari masking
    expect(code).toContain("Version/18.3 Safari/605.1.15");
    // 3. Storage isolation
    expect(code).toContain("WKWebsiteDataStore");
    // 4. Navigation sandbox
    expect(code).toContain("decidePolicyFor navigationAction");
    // 5. UserScript injection connecting to local opencodex ws hub
    expect(code).toContain("WKUserScript");
    expect(code).toContain("/v1/ws/aistudio");
    expect(code).toContain("posixPermissions");
    expect(code).toContain("JSONSerialization.data(withJSONObject:");
    expect(code).toContain("cMap[\"domain\"]");
  });

  test.skipIf(process.platform !== "darwin")("swiftc compiles main.swift successfully", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "aistudio-test-"));
    const outBin = join(outDir, "daemon");
    const binPath = await buildAiStudioNativeDaemon(outBin);
    expect(existsSync(binPath)).toBe(true);
  }, 30_000);
});
