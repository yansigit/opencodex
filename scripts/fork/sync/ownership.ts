import type { PathClass } from "./types";

const FORK_OWNED_PREFIXES = [
  "src/fork/",
  "tests/fork/",
  "docs/fork/",
  ".cursor/skills/opencodex-fork-sync/",
  "scripts/fork/",
] as const;

const FORK_OWNED_FILES = new Set([
  ".github/workflows/fork-upstream-sync.yml",
  ".github/workflows/fork-pr-mergeable.yml",
]);

const SHARED_HOTSPOT_PREFIXES = [
  "gui/src/i18n/",
  "src/adapters/google",
  "src/server/management/",
  "src/server/responses/",
] as const;

const SHARED_HOTSPOT_FILES = new Set([
  "src/cli/capabilities.ts",
  "src/codex/inject.ts",
  "src/config.ts",
  "src/router.ts",
  "src/server/auth-cors.ts",
  "src/server/index.ts",
  "src/service.ts",
  "src/server/responses/core.ts",
  "src/providers/antigravity-quota.ts",
  "src/providers/key-failover.ts",
  "src/providers/key-store.ts",
  "src/providers/quota.ts",
]);

export function isSharedHotspot(path: string): boolean {
  return SHARED_HOTSPOT_FILES.has(path)
    || SHARED_HOTSPOT_PREFIXES.some(prefix => path.startsWith(prefix));
}

export function classifyPath(path: string): PathClass {
  if (isSharedHotspot(path)) return "shared-hotspot";
  if (path === "package.json") return "recipe";
  if (FORK_OWNED_FILES.has(path)) return "fork-owned";
  if (FORK_OWNED_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return "fork-owned";
  }
  return "upstream-owned";
}
