import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface SmokeCacheEntry {
  fingerprint: string;
  timestamp: number;
  status: "passed" | "skipped" | "failed";
  reason?: string;
  modelsTested?: string[];
}

export interface SmokeCacheData {
  version: number;
  providers: Record<string, SmokeCacheEntry>;
}

const CACHE_VERSION = 1;

export function defaultSmokeCachePath(): string {
  return join(homedir(), ".opencodex", "live-inference-cache.json");
}

function defaultCachePath(customPath?: string): string {
  return customPath ?? defaultSmokeCachePath();
}

function emptyCache(): SmokeCacheData {
  return { version: CACHE_VERSION, providers: {} };
}

function walkTs(root: string, relDir: string): string[] {
  const paths: string[] = [];
  const fullDir = join(root, relDir);
  if (!existsSync(fullDir)) return paths;
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const relPath = join(relDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...walkTs(root, relPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(relPath);
    }
  }
  return paths;
}

function collectProviderSourcePaths(provider: string, root: string): string[] {
  let paths: string[];
  switch (provider) {
    case "google":
    case "google-antigravity":
    case "google-aistudio":
      paths = ["src/adapters/google.ts", "src/adapters/google-wire-compiler.ts", "src/adapters/google-tool-schema.ts", "src/adapters/google-antigravity-wire.ts", "src/types/tools.ts", "src/server/responses-undeclared-tool-guard.ts"];
      break;
    case "cursor":
      paths = ["src/adapters/cursor.ts", ...walkTs(root, "src/adapters/cursor")];
      break;
    case "command-code":
      paths = ["src/adapters/command-code.ts", "src/adapters/command-code-project-context.ts", "src/providers/command-code-efforts.ts"];
      break;
    case "openai":
    case "openai-responses":
      paths = ["src/adapters/openai-responses.ts", "src/adapters/responses-tool-schema.ts"];
      break;
    default:
      paths = [`src/adapters/${provider}.ts`];
      break;
  }
  return [...new Set(paths)].filter(path => existsSync(join(root, path))).sort();
}

export async function computeProviderSourceFingerprint(
  provider: string,
  projectRoot?: string,
): Promise<string> {
  const root = resolve(projectRoot ?? process.cwd());
  const hash = createHash("sha256");
  const paths = collectProviderSourcePaths(provider, root);
  if (paths.length === 0) return hash.update(`empty:${provider}`, "utf8").digest("hex");
  for (const relPath of paths) {
    hash.update(`${relPath}\0`, "utf8");
    hash.update(readFileSync(join(root, relPath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function loadSmokeCache(customPath?: string): Promise<SmokeCacheData> {
  const cachePath = defaultCachePath(customPath);
  if (!existsSync(cachePath)) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as SmokeCacheData;
    if (typeof parsed !== "object" || parsed === null) return emptyCache();
    return {
      version: typeof parsed.version === "number" ? parsed.version : CACHE_VERSION,
      providers: typeof parsed.providers === "object" && parsed.providers !== null ? parsed.providers : {},
    };
  } catch {
    return emptyCache();
  }
}

export async function saveSmokeCache(data: SmokeCacheData, customPath?: string): Promise<void> {
  const cachePath = defaultCachePath(customPath);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function shouldRunSmokeForProvider(
  provider: string,
  currentFingerprint: string,
  options?: { force?: boolean; cache?: SmokeCacheData },
): boolean {
  if (options?.force) return true;
  const entry = options?.cache?.providers[provider];
  if (!entry) return true;
  if (entry.fingerprint !== currentFingerprint) return true;
  return entry.status !== "passed";
}

export async function recordSmokeResult(
  provider: string,
  entry: SmokeCacheEntry,
  customPath?: string,
): Promise<void> {
  const cache = await loadSmokeCache(customPath);
  cache.providers[provider] = entry;
  await saveSmokeCache(cache, customPath);
}
