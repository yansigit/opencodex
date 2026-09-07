import { describe, it, expect } from "bun:test";
import { join, resolve } from "node:path";
import {
  ACTIONLINT_VERSION,
  ACTIONLINT_SHA256,
  ACTIONLINT_BASE_URL,
  resolveAsset,
  getCacheDir,
  getCacheKey,
  getBinaryPath,
  computeSha256,
  verifySha256,
  getOverrideBinary,
} from "../../scripts/ci/actionlint";

describe("actionlint runner", () => {
  it("pins version to 1.7.12", () => {
    expect(ACTIONLINT_VERSION).toBe("1.7.12");
    expect(ACTIONLINT_BASE_URL).toBe("https://github.com/rhysd/actionlint/releases/download/v1.7.12");
  });

  it("hardcodes official SHA-256 for supported archives", () => {
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_darwin_amd64.tar.gz"]).toBe("5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644");
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_darwin_arm64.tar.gz"]).toBe("aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f");
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_linux_amd64.tar.gz"]).toBe("8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8");
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_linux_arm64.tar.gz"]).toBe("325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6");
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_windows_amd64.zip"]).toBe("6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9");
    expect(ACTIONLINT_SHA256["actionlint_1.7.12_windows_arm64.zip"]).toBe("cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41");
    expect(Object.keys(ACTIONLINT_SHA256).length).toBe(6);
  });

  it("resolves asset for supported darwin/linux/windows arch", () => {
    const darwinArm = resolveAsset("darwin", "arm64");
    expect(darwinArm.filename).toBe("actionlint_1.7.12_darwin_arm64.tar.gz");
    expect(darwinArm.url).toContain("actionlint_1.7.12_darwin_arm64.tar.gz");
    expect(darwinArm.sha256.length).toBe(64);

    const darwinX64 = resolveAsset("darwin", "x64");
    expect(darwinX64.filename).toBe("actionlint_1.7.12_darwin_amd64.tar.gz");

    const linuxX64 = resolveAsset("linux", "x64");
    expect(linuxX64.filename).toBe("actionlint_1.7.12_linux_amd64.tar.gz");

    const linuxArm = resolveAsset("linux", "arm64");
    expect(linuxArm.filename).toBe("actionlint_1.7.12_linux_arm64.tar.gz");

    const winX64 = resolveAsset("win32", "x64");
    expect(winX64.filename).toBe("actionlint_1.7.12_windows_amd64.zip");

    const winArm = resolveAsset("win32", "arm64");
    expect(winArm.filename).toBe("actionlint_1.7.12_windows_arm64.zip");
  });

  it("throws on unsupported platform/arch", () => {
    expect(() => resolveAsset("freebsd", "x64")).toThrow(/unsupported/);
    expect(() => resolveAsset("linux", "ppc64")).toThrow(/unsupported/);
    expect(() => resolveAsset("darwin", "x64")).not.toThrow();
  });

  it("derives cache dir safely under .tmp", () => {
    const dir = getCacheDir("/tmp/myroot");
    expect(dir).toBe(resolve("/tmp/myroot", ".tmp", "actionlint", "v1.7.12"));
    expect(getCacheDir()).toContain(join(".tmp", "actionlint", "v1.7.12"));
  });

  it("derives binary path with platform suffix and .exe on windows", () => {
    expect(getBinaryPath("/root", "darwin", "arm64")).toBe(join(resolve("/root", ".tmp/actionlint/v1.7.12"), "darwin-arm64", "actionlint"));
    expect(getBinaryPath("/root", "linux", "x64")).toContain(join("linux-amd64", "actionlint"));
    expect(getBinaryPath("/root", "win32", "x64")).toContain(join("windows-amd64", "actionlint.exe"));
    expect(getBinaryPath("/root", "win32", "arm64")).toContain(join("windows-arm64", "actionlint.exe"));
  });

  it("verifies SHA-256 correctly", () => {
    const data = new TextEncoder().encode("hello actionlint");
    const hex = computeSha256(data);
    expect(verifySha256(data, hex)).toBe(true);
    expect(verifySha256(data, "0".repeat(64))).toBe(false);
    // tampered data fails
    const tampered = new TextEncoder().encode("hello actionlint!");
    expect(verifySha256(tampered, hex)).toBe(false);
  });

  it("supports ACTIONLINT_BIN override", () => {
    const orig = process.env.ACTIONLINT_BIN;
    try {
      process.env.ACTIONLINT_BIN = "  /tmp/custom/actionlint  ";
      expect(getOverrideBinary()).toBe(resolve("/tmp/custom/actionlint"));
      delete process.env.ACTIONLINT_BIN;
      expect(getOverrideBinary()).toBeNull();
      process.env.ACTIONLINT_BIN = "   ";
      expect(getOverrideBinary()).toBeNull();
    } finally {
      if (orig === undefined) delete process.env.ACTIONLINT_BIN;
      else process.env.ACTIONLINT_BIN = orig;
    }
  });

  it("limits the copilot permission compatibility ignores to affected workflows", async () => {
    const content = await Bun.file(".github/actionlint.yaml").text();
    expect(content).toContain(".github/workflows/enforce-issue-quality.yml:");
    expect(content).toContain(".github/workflows/issue-triage.yml:");
    expect(content).not.toContain(".github/workflows/**/*:");
  });

  it("runner invocation always includes shellcheck disable (source check)", async () => {
    const src = await Bun.file("scripts/ci/actionlint.ts").text();
    expect(src).toContain('"-shellcheck="');
    expect(src).toContain('"-pyflakes="');
    expect(src).toContain("ACTIONLINT_BIN");
    expect(src).toContain("verifySha256");
    expect(src).toContain("5b44c3bc");
  });
});
