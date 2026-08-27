import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsPromises = await import("node:fs/promises");
const realOpendir = fsPromises.opendir;
const opendirMock = mock(realOpendir);
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  opendir: opendirMock,
}));

import {
  workspaceMetadataCache,
  workspaceConfigCache,
  pruneWorkspaceMetadataCache,
  MAX_WORKSPACE_METADATA_ENTRIES,
  SESSION_WORKSPACE_CONFIG_TTL_MS,
  commandCodeConfig,
} from "../src/adapters/command-code";

beforeEach(() => {
  workspaceMetadataCache.clear();
  workspaceConfigCache.clear();
  opendirMock.mockImplementation(realOpendir);
});

afterEach(() => {
  workspaceMetadataCache.clear();
  workspaceConfigCache.clear();
  opendirMock.mockImplementation(realOpendir);
});

describe("workspaceMetadataCache eviction", () => {
  const dummyValue = { isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] as string[] };

  test("expired entries are evicted before capacity check", () => {
    const now = Date.now();
    // Insert 3 entries: two expired, one fresh.
    workspaceMetadataCache.set("/old1", { collectedAt: now - 60_000, value: dummyValue });
    workspaceMetadataCache.set("/old2", { collectedAt: now - 45_000, value: dummyValue });
    workspaceMetadataCache.set("/fresh", { collectedAt: now - 1_000, value: dummyValue });
    expect(workspaceMetadataCache.size).toBe(3);

    pruneWorkspaceMetadataCache(now);

    // The two expired entries (>= 30s TTL) should be gone; the fresh one stays.
    expect(workspaceMetadataCache.size).toBe(1);
    expect(workspaceMetadataCache.has("/fresh")).toBe(true);
    expect(workspaceMetadataCache.has("/old1")).toBe(false);
    expect(workspaceMetadataCache.has("/old2")).toBe(false);
  });

  test("oldest live entry is evicted when at capacity with no expired entries", () => {
    const now = Date.now();
    // Fill to exactly MAX_WORKSPACE_METADATA_ENTRIES with fresh entries.
    for (let i = 0; i < MAX_WORKSPACE_METADATA_ENTRIES; i++) {
      workspaceMetadataCache.set(`/dir-${i}`, { collectedAt: now - (MAX_WORKSPACE_METADATA_ENTRIES - i), value: dummyValue });
    }
    expect(workspaceMetadataCache.size).toBe(MAX_WORKSPACE_METADATA_ENTRIES);

    pruneWorkspaceMetadataCache(now);

    // The oldest entry (/dir-0, collectedAt = now - 128) should be evicted.
    expect(workspaceMetadataCache.size).toBe(MAX_WORKSPACE_METADATA_ENTRIES - 1);
    expect(workspaceMetadataCache.has("/dir-0")).toBe(false);
    // The newest entry should still be present.
    expect(workspaceMetadataCache.has(`/dir-${MAX_WORKSPACE_METADATA_ENTRIES - 1}`)).toBe(true);
  });

  test("cache never exceeds the cap", () => {
    const now = Date.now();
    // Simulate inserting more entries than the cap by calling prune before each insertion.
    for (let i = 0; i < MAX_WORKSPACE_METADATA_ENTRIES + 10; i++) {
      pruneWorkspaceMetadataCache(now + i);
      workspaceMetadataCache.set(`/dir-${i}`, { collectedAt: now + i, value: dummyValue });
    }
    expect(workspaceMetadataCache.size).toBeLessThanOrEqual(MAX_WORKSPACE_METADATA_ENTRIES);
  });

  test("prune on an empty cache is a no-op", () => {
    expect(workspaceMetadataCache.size).toBe(0);
    pruneWorkspaceMetadataCache(Date.now());
    expect(workspaceMetadataCache.size).toBe(0);
  });

  test("commandCodeConfig returns a stable cached config across turns in the same session", async () => {
    const sessionId = "session-1234";
    const cwd = process.cwd();
    const first = await commandCodeConfig(cwd, sessionId);
    const second = await commandCodeConfig(cwd, sessionId);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).toEqual(second);
    expect(first).toBe(second);
  });
});

describe("commandCodeConfig structure and session freeze", () => {
  test("returns a sorted structure array", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ocx-cc-structure-"));
    const names = ["zebra", "alpha", "mango"];
    opendirMock.mockImplementation(async () => ({
      close: async () => undefined,
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            if (index >= names.length) return { done: true as const, value: undefined };
            const name = names[index++];
            return { done: false as const, value: { name } };
          },
        };
      },
    }));

    try {
      const config = await commandCodeConfig(cwd);
      expect(config.structure).toEqual(["alpha", "mango", "zebra"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("selects the lexicographically smallest entries before applying the structure cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ocx-cc-structure-cap-"));
    const names = [...Array.from({ length: 64 }, (_, index) => `z-${index.toString().padStart(2, "0")}`), "a-first"];
    opendirMock.mockImplementation(async () => ({
      close: async () => undefined,
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            if (index >= names.length) return { done: true as const, value: undefined };
            return { done: false as const, value: { name: names[index++]! } };
          },
        };
      },
    }));

    try {
      const config = await commandCodeConfig(cwd);
      expect(config.structure).toHaveLength(64);
      expect(config.structure).toContain("a-first");
      expect(config.structure).not.toContain("z-63");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session cache preserves initial date and structure across midnight", async () => {
    const sessionId = "session-midnight";
    const cwd = mkdtempSync(join(tmpdir(), "ocx-cc-midnight-"));
    const names = ["beta", "alpha"];
    opendirMock.mockImplementation(async () => ({
      close: async () => undefined,
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            if (index >= names.length) return { done: true as const, value: undefined };
            const name = names[index++];
            return { done: false as const, value: { name } };
          },
        };
      },
    }));

    const beforeMidnight = new Date("2026-01-01T23:30:00.000Z");
    const afterMidnight = new Date("2026-01-02T01:30:00.000Z");
    const nowSpy = spyOn(Date, "now").mockReturnValue(beforeMidnight.getTime());
    let currentIso = "2026-01-01T23:30:00.000Z";
    const afterMidnightIso = "2026-01-02T01:30:00.000Z";
    const dateSpy = spyOn(Date.prototype, "toISOString").mockImplementation(() => currentIso);

    try {
      const first = await commandCodeConfig(cwd, sessionId);
      expect(first.date).toBe("2026-01-01");
      expect(first.structure).toEqual(["alpha", "beta"]);

      nowSpy.mockReturnValue(afterMidnight.getTime());
      currentIso = afterMidnightIso;

      const second = await commandCodeConfig(cwd, sessionId);
      expect(second).toBe(first);
      expect(second.date).toBe("2026-01-01");
      expect(second.structure).toEqual(["alpha", "beta"]);
    } finally {
      nowSpy.mockRestore();
      dateSpy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session snapshot stays byte-stable after its TTL when workspace metadata changes", async () => {
    const sessionId = "session-immutable";
    const cwd = mkdtempSync(join(tmpdir(), "ocx-cc-immutable-"));
    let names = ["initial.txt"];
    opendirMock.mockImplementation(async () => ({
      close: async () => undefined,
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            if (index >= names.length) return { done: true as const, value: undefined };
            return { done: false as const, value: { name: names[index++]! } };
          },
        };
      },
    }));

    const start = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(start);
    try {
      const first = await commandCodeConfig(cwd, sessionId);
      names = ["changed.txt"];
      nowSpy.mockReturnValue(start + SESSION_WORKSPACE_CONFIG_TTL_MS + 1);

      const second = await commandCodeConfig(cwd, sessionId);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      nowSpy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
