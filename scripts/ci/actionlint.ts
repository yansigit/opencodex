import { existsSync, mkdirSync, rmSync, renameSync, chmodSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export const ACTIONLINT_VERSION = "1.7.12";
export const ACTIONLINT_BASE_URL = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;

// Hardcoded official SHA-256 from https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_checksums.txt
// Verified 2026-03-30 release assets. Do not update without re-verifying upstream checksums.
export const ACTIONLINT_SHA256: Record<string, string> = {
  "actionlint_1.7.12_darwin_amd64.tar.gz": "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  "actionlint_1.7.12_darwin_arm64.tar.gz": "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  "actionlint_1.7.12_linux_amd64.tar.gz": "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  "actionlint_1.7.12_linux_arm64.tar.gz": "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
  "actionlint_1.7.12_windows_amd64.zip": "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
  "actionlint_1.7.12_windows_arm64.zip": "cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41",
};

type PlatformInfo = { filename: string; sha256: string; url: string };

export function resolveAsset(platform: string, arch: string): PlatformInfo {
  let key: string;
  if (platform === "darwin" && arch === "x64") key = "actionlint_1.7.12_darwin_amd64.tar.gz";
  else if (platform === "darwin" && arch === "arm64") key = "actionlint_1.7.12_darwin_arm64.tar.gz";
  else if (platform === "linux" && arch === "x64") key = "actionlint_1.7.12_linux_amd64.tar.gz";
  else if (platform === "linux" && arch === "arm64") key = "actionlint_1.7.12_linux_arm64.tar.gz";
  else if (platform === "win32" && arch === "x64") key = "actionlint_1.7.12_windows_amd64.zip";
  else if (platform === "win32" && arch === "arm64") key = "actionlint_1.7.12_windows_arm64.zip";
  else throw new Error(`unsupported platform/arch: ${platform}/${arch} (supported: darwin x64/arm64, linux x64/arm64, win32 x64/arm64)`);
  const sha256 = ACTIONLINT_SHA256[key];
  if (!sha256) throw new Error(`missing SHA-256 for ${key}`);
  return { filename: key, sha256, url: `${ACTIONLINT_BASE_URL}/${key}` };
}

export function getCurrentAsset(): PlatformInfo {
  return resolveAsset(process.platform, process.arch);
}

export function getCacheDir(root = process.cwd()): string {
  return resolve(root, ".tmp", "actionlint", `v${ACTIONLINT_VERSION}`);
}

export function getCacheKey(platform: string, arch: string): string {
  // Normalize to cache directory name
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-amd64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-amd64";
  if (platform === "win32") return arch === "arm64" ? "windows-arm64" : "windows-amd64";
  return `${platform}-${arch}`;
}

export function getBinaryPath(root = process.cwd(), platform = process.platform, arch = process.arch): string {
  const dir = join(getCacheDir(root), getCacheKey(platform, arch));
  const exe = platform === "win32" ? "actionlint.exe" : "actionlint";
  return join(dir, exe);
}

export function computeSha256(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

export function verifySha256(data: Uint8Array, expectedHex: string): boolean {
  const actual = computeSha256(data);
  if (actual.length !== expectedHex.length) return false;
  // constant-time compare to avoid timing leak (not security-critical but good hygiene)
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

export function getOverrideBinary(): string | null {
  const override = process.env.ACTIONLINT_BIN?.trim();
  if (!override) return null;
  return resolve(override);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

async function downloadAsset(asset: PlatformInfo, destPath: string): Promise<Uint8Array> {
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`failed to download ${asset.url}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!verifySha256(buf, asset.sha256)) {
    const actual = computeSha256(buf);
    throw new Error(`SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actual}`);
  }
  // Atomic write to destPath via temp file
  const tmp = `${destPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ensureDir(dirname(destPath));
  await Bun.write(tmp, buf);
  // Re-verify from disk before rename (defense-in-depth against truncated write)
  const onDisk = await Bun.file(tmp).bytes();
  if (!verifySha256(onDisk, asset.sha256)) {
    rmSync(tmp, { force: true });
    throw new Error(`SHA-256 mismatch after writing ${asset.filename} to disk`);
  }
  renameSync(tmp, destPath);
  return buf;
}

function extractArchive(archivePath: string, destDir: string): void {
  ensureDir(destDir);
  const tmpDir = `${destDir}.extract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ensureDir(tmpDir);
  try {
    if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
      const r = spawnSync("tar", ["-xzf", archivePath, "-C", tmpDir], { stdio: "pipe" });
      if (r.status !== 0) throw new Error(`tar extraction failed: ${r.stderr?.toString().slice(0, 500)}`);
    } else if (archivePath.endsWith(".zip")) {
      // Prefer unzip, fallback to tar (bsdtar supports zip)
      let r = spawnSync("unzip", ["-o", archivePath, "-d", tmpDir], { stdio: "pipe" });
      if (r.status !== 0) {
        r = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "pipe" });
        if (r.status !== 0) throw new Error(`zip extraction failed (unzip and tar): ${r.stderr?.toString().slice(0, 500)}`);
      }
    } else {
      throw new Error(`unknown archive type: ${archivePath}`);
    }
    // Find binary inside extracted tree (archive contains single binary at root)
    const found = findBinary(tmpDir);
    if (!found) throw new Error(`actionlint binary not found after extracting ${archivePath}`);
    const exeName = archivePath.includes("windows") ? "actionlint.exe" : "actionlint";
    const finalPath = join(destDir, exeName);
    // Ensure destDir clean then move
    try { rmSync(finalPath, { force: true }); } catch {}
    renameSync(found, finalPath);
    if (process.platform !== "win32") {
      try { chmodSync(finalPath, 0o755); } catch {}
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findBinary(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && (e.name === "actionlint" || e.name === "actionlint.exe")) return p;
    if (e.isDirectory()) {
      const nested = findBinary(p);
      if (nested) return nested;
    }
  }
  return null;
}

export async function ensureActionlintBinary(root = process.cwd()): Promise<string> {
  const override = getOverrideBinary();
  if (override) {
    if (!existsSync(override)) throw new Error(`ACTIONLINT_BIN does not exist: ${override}`);
    return override;
  }
  const asset = getCurrentAsset();
  const cacheKey = getCacheKey(process.platform, process.arch);
  const cacheDir = join(getCacheDir(root), cacheKey);
  const binaryPath = join(cacheDir, process.platform === "win32" ? "actionlint.exe" : "actionlint");
  if (existsSync(binaryPath)) return binaryPath;

  // Download a verified archive and extract it into the platform-specific cache.
  const archivePath = join(getCacheDir(root), asset.filename);
  // Use cached archive if present and valid
  let needDownload = true;
  if (existsSync(archivePath)) {
    try {
      const existing = await Bun.file(archivePath).bytes();
      if (verifySha256(existing, asset.sha256)) needDownload = false;
      else rmSync(archivePath, { force: true });
    } catch {
      needDownload = true;
    }
  }
  if (needDownload) {
    await downloadAsset(asset, archivePath);
  } else {
    // Still verify before extraction
    const existing = await Bun.file(archivePath).bytes();
    if (!verifySha256(existing, asset.sha256)) throw new Error(`cached archive SHA-256 mismatch: ${archivePath}`);
  }
  extractArchive(archivePath, cacheDir);
  if (!existsSync(binaryPath)) throw new Error(`actionlint binary missing after extraction: ${binaryPath}`);
  return binaryPath;
}

async function main(): Promise<void> {
  const binary = await ensureActionlintBinary();
  const extraArgs = process.argv.slice(2);
  // Always disable shellcheck/pyflakes for deterministic behavior (no external deps)
  const args = ["-shellcheck=", "-pyflakes=", ...extraArgs];
  // If no file args, actionlint discovers .github/workflows automatically
  const proc = Bun.spawn([binary, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
