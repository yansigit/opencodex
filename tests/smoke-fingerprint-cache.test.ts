import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeProviderSourceFingerprint,
  defaultSmokeCachePath,
  loadSmokeCache,
  recordSmokeResult,
  saveSmokeCache,
  shouldRunSmokeForProvider,
  type SmokeCacheData,
} from "../src/smoke/fingerprint-cache";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ocx-smoke-cache-"));
}

describe("smoke fingerprint cache", () => {
  test("uses the OpenCodex home for the default cache path", () => {
    expect(defaultSmokeCachePath()).toBe(join(homedir(), ".opencodex", "live-inference-cache.json"));
  });

  test("fingerprint includes mapped files deterministically", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src/adapters"), { recursive: true });
    await writeFile(join(root, "src/adapters/google.ts"), "google");
    await writeFile(join(root, "src/adapters/google-wire-compiler.ts"), "wire");

    const first = await computeProviderSourceFingerprint("google", root);
    await writeFile(join(root, "src/adapters/google-unmapped.ts"), "ignored");
    expect(await computeProviderSourceFingerprint("google", root)).toBe(first);
    await writeFile(join(root, "src/adapters/google.ts"), "changed");
    const second = await computeProviderSourceFingerprint("google", root);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    await rm(root, { recursive: true, force: true });
  });

  test("fingerprint sorts cursor files and uses the empty-provider fallback", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src/adapters/cursor"), { recursive: true });
    await writeFile(join(root, "src/adapters/cursor/z.ts"), "z");
    await writeFile(join(root, "src/adapters/cursor/a.ts"), "a");
    await writeFile(join(root, "src/adapters/cursor.ts"), "entry");

    const fingerprint = await computeProviderSourceFingerprint("cursor", root);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeProviderSourceFingerprint("missing-provider", root)).toBe("0ae8bafb6df43d987ac850d6fdde0a4241b07c4022741d37868b30dd78a77eb0");
    await rm(root, { recursive: true, force: true });
  });

  test("loads missing or malformed cache as an empty current cache", async () => {
    const root = await tempRoot();
    const path = join(root, "cache.json");
    expect(await loadSmokeCache(path)).toEqual({ version: 1, providers: {} });
    await writeFile(path, "not json");
    expect(await loadSmokeCache(path)).toEqual({ version: 1, providers: {} });
    await rm(root, { recursive: true, force: true });
  });

  test("saves and records cache entries", async () => {
    const root = await tempRoot();
    const path = join(root, "nested/cache.json");
    const data: SmokeCacheData = { version: 1, providers: {} };
    await saveSmokeCache(data, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(data);
    await recordSmokeResult("google", { fingerprint: "abc", timestamp: 1, status: "passed" }, path);
    expect((await loadSmokeCache(path)).providers.google.fingerprint).toBe("abc");
    await rm(root, { recursive: true, force: true });
  });

  test("runs when forced, uncached, stale, or not passed", () => {
    const passed: SmokeCacheData = { version: 1, providers: { google: { fingerprint: "same", timestamp: 1, status: "passed" } } };
    expect(shouldRunSmokeForProvider("google", "same", { cache: passed })).toBe(false);
    expect(shouldRunSmokeForProvider("google", "same", { force: true, cache: passed })).toBe(true);
    expect(shouldRunSmokeForProvider("cursor", "same", { cache: passed })).toBe(true);
    expect(shouldRunSmokeForProvider("google", "new", { cache: passed })).toBe(true);
    expect(shouldRunSmokeForProvider("google", "same", { cache: { version: 1, providers: { google: { ...passed.providers.google, status: "failed" } } } })).toBe(true);
    expect(shouldRunSmokeForProvider("google", "same", { cache: { version: 1, providers: { google: { ...passed.providers.google, status: "skipped" } } } })).toBe(true);
  });
});
