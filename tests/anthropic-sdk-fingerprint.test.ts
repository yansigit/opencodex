import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CODE_HEADERS } from "../src/adapters/client-fingerprint";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Fingerprint characterization for the Claude Code OAuth surface.
 *
 * The proxy's outbound Anthropic fingerprint is pinned to the real
 * Claude Code CLI's header set (currently @anthropic-ai/sdk 0.74.0),
 * deliberately decoupled from the dev-only SDK exact pin (0.122.0).
 * Bumping the SDK for fixtures/types must not silently change the
 * User-Agent / Stainless headers seen by Anthropic.
 *
 * This test locks that invariant and characterizes the installed SDK
 * export surface so a future major SDK bump that removes a type is
 * noticed here rather than as a silent translation regression.
 */

describe("anthropic sdk fingerprint", () => {
  test("outbound Claude Code fingerprint remains pinned to 0.74.0", () => {
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Package-Version"]).toBe("0.74.0");
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBe("node");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Lang"]).toBe("js");
  });

  test("proxy User-Agent for Anthropic is stable and decoupled from dev sdk", async () => {
    // The adapter hard-codes "@anthropic-ai/sdk/0.74.0" for both OAuth and apikey paths.
    // Importing the adapter here would hit network-adjacent code; instead assert the
    // documented contract appears in the adapter source.
    const anthropicAdapter = readFileSync(join(repoRoot, "src/adapters/anthropic.ts"), "utf8");
    expect(anthropicAdapter).toContain("@anthropic-ai/sdk/0.74.0");
    // Dev pin must be different (prevents accidental coupling)
    const pkg = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]).toBe("0.122.0");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Package-Version"]).not.toBe(pkg.devDependencies?.["@anthropic-ai/sdk"]);
  });

  test("installed @anthropic-ai/sdk package matches the exact dev pin", () => {
    // Only runs when node_modules present (local dev / CI with bun install)
    const pkgPath = join(repoRoot, "node_modules", "@anthropic-ai", "sdk", "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    expect(pkg.version).toBe("0.122.0");
  });

  test("faker fingerprint: sdk User-Agent appears only in anthropic adapter and sidecar executors", () => {
    // Characterization of the allowlist: only Anthropic-facing modules should emit the
    // literal 0.74.0 UA. A stray copy elsewhere would mean the fingerprint is
    // duplicated and will drift when the pinned SDK changes.
    const matches = listTypeScriptFiles(join(repoRoot, "src")).filter((path) =>
      readFileSync(path, "utf8").includes("@anthropic-ai/sdk/0.74.0"),
    );
    expect(matches.length).toBeGreaterThan(0);
    const allowedPrefixes = [
      "src/adapters/anthropic.ts",
      "src/vision/anthropic-describe.ts",
      "src/web-search/anthropic-executor.ts",
    ];
    for (const path of matches) {
      const relative = path.slice(repoRoot.length + 1);
      const isAllowed = allowedPrefixes.includes(relative);
      expect(isAllowed).toBe(true);
    }
  });
});
