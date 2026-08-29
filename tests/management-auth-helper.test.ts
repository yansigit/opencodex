import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, saveConfig } from "../src/config";
import { inMemoryManagementPersistence } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let home: string | undefined;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});
test("in-memory management persistence changes only its fixture", () => {
  home = mkdtempSync(join(tmpdir(), "ocx-management-auth-helper-"));
  process.env.OPENCODEX_HOME = home;
  const sentinel: OcxConfig = { port: 10100, defaultProvider: "sentinel", providers: {} };
  saveConfig(sentinel);
  const before = readFileSync(getConfigPath(), "utf8");
  const fixture: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {} };
  const persistence = inMemoryManagementPersistence(fixture);

  persistence.saveConfigPreservingClaudeCode?.({ ...fixture, defaultProvider: "changed" });
  const outcome = persistence.mutatePersistedConfig?.(config => {
    config.defaultProvider = "changed";
    return { changed: true, value: "updated" };
  });

  expect(outcome).toEqual({ status: "committed", value: "updated" });
  expect(fixture.defaultProvider).toBe("changed");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
});
