import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { repoPath } from "../helpers/repo-root";

const DRAIN_SENSITIVE_FILES = [
  "tests/adapters/google/aistudio-bridge-endpoint.test.ts",
  "tests/claude-integration/claude-desktop-config-path.test.ts",
  "tests/adapters/google/google-aistudio-integration.test.ts",
  "tests/adapters/google/google-aistudio-status.test.ts",
  "tests/server/server-request-body-size.test.ts",
  "tests/vision/vision-routed.test.ts",
] as const;

/**
 * `startServer().stop()` drains project lifecycle work and therefore returns a
 * promise. A floating stop can race fixture cleanup on Windows. `Bun.serve()`
 * listeners are deliberately outside this check because their stop is sync.
 *
 * Counting instead of naming `server` also covers helpers and aliases in every
 * suite where cleanup touches the server's home or related lifecycle resources.
 * Other storage suites use dedicated async stop helpers; `Bun.serve()` fixtures
 * are synchronous and are deliberately outside this project-server invariant.
 */
test("project test servers await asynchronous shutdown", () => {
  const offenders: string[] = [];
  for (const file of DRAIN_SENSITIVE_FILES) {
    const path = repoPath(file);
    expect(existsSync(path), file).toBe(true);
    const text = readFileSync(path, "utf8");
    const starts = text.match(/\bstartServer\s*\(/g)?.length ?? 0;
    const awaitedStops = text.match(/\bawait\s+[A-Za-z_$][\w$?]*(?:\.[A-Za-z_$][\w$?]*)*\.stop\s*\(\s*true\s*\)/g)?.length ?? 0;
    if (starts > awaitedStops) {
      offenders.push(`${basename(file)}: ${starts} startServer call(s), ${awaitedStops} awaited stop(s)`);
    }
  }

  expect(offenders).toEqual([]);
});
