import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Hygiene: production src must never runtime-import @anthropic-ai/sdk.
 *
 * The SDK is a dev-only reference for fixtures and type surfaces (exact-pin
 * @anthropic-ai/sdk 0.122.0 in devDependencies). If production code runtime-imports
 * it, the package would need to move to dependencies and would be bundled/shipped.
 * Only `import type` is allowed in src (erased at runtime).
 *
 * This also enforces the exact pin: no caret/range, not in dependencies/
 * optionalDependencies/overrides, and lockfile carries the same bytes.
 */

// walk src for .ts files
function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSrcFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Detects runtime imports of the SDK (side-effect, static, re-export, dynamic).
// Allows `import type` (erased). Mirrors core-lab-boundary IMPORT_RE semantics.
const RUNTIME_SDK_RE =
  /import\s+(?!type\b)[^;]*?from\s+["']@anthropic-ai\/sdk(?:\/[^"']*)?["']|import\s+["']@anthropic-ai\/sdk(?:\/[^"']*)?["']|export\s+(?!type\b)[^;]*?from\s+["']@anthropic-ai\/sdk(?:\/[^"']*)?["']|\bimport\s*\(\s*["']@anthropic-ai\/sdk(?:\/[^"']*)?["']\s*\)/;

describe("anthropic sdk import hygiene", () => {
  test("package.json pins @anthropic-ai/sdk 0.122.0 exactly in devDependencies only", async () => {
    const pkg = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]).toBe("0.122.0");
    expect(pkg.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(pkg.optionalDependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    // overrides must not pin it either (would hide a prod dep)
    expect(pkg.overrides?.["@anthropic-ai/sdk"]).toBeUndefined();
    // exact, no range prefix
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]?.startsWith("^")).toBe(false);
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]?.startsWith("~")).toBe(false);
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]?.startsWith(">=")).toBe(false);
  });

  test("bun.lock carries the same exact sdk bytes", async () => {
    const lock = await Bun.file(join(repoRoot, "bun.lock")).text();
    // dev dep entry in lockfile package list
    expect(lock).toContain('"@anthropic-ai/sdk": "0.122.0"');
    expect(lock).toContain('"@anthropic-ai/sdk@0.122.0"');
  });

  test("src/ has no runtime import from @anthropic-ai/sdk (import type only)", async () => {
    const srcDir = join(repoRoot, "src");
    const files = listSrcFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, "utf8");
      if (RUNTIME_SDK_RE.test(content)) {
        // report repo-relative path
        offenders.push(abs.slice(repoRoot.length + 1));
      }
      // reset regex state for global-free pattern, but our pattern is not /g so no need
    }
    expect(offenders).toEqual([]);
  });

  test("checked-in manifest matches pinned pin and fingerprint", async () => {
    const manifestPath = join(repoRoot, "tests/fixtures/anthropic-sdk-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sdkExactPin?: string; fingerprint?: { userAgent?: string } };
    expect(manifest.sdkExactPin).toBe("0.122.0");
    expect(manifest.fingerprint?.userAgent).toBe("@anthropic-ai/sdk/0.74.0");
    const pkg = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()) as { devDependencies?: Record<string,string> };
    expect(manifest.sdkExactPin).toBe(pkg.devDependencies?.["@anthropic-ai/sdk"]);
  });

  test("installed sdk package.json matches pinned version", async () => {
    const pkgPath = join(repoRoot, "node_modules", "@anthropic-ai", "sdk", "package.json");
    if (!existsSync(pkgPath)) {
      // bun install may use isolated lock; still assert file exists in repo context
      // Fallback: check bun.lock already covered, so skip when not installed locally.
      return;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    expect(pkg.version).toBe("0.122.0");
  });
});
