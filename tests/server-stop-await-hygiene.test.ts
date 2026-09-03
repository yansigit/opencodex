import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const testsDir = import.meta.dir;
const DRAIN_SENSITIVE_FILES = [
  "aistudio-bridge-endpoint.test.ts",
  "claude-desktop-config-path.test.ts",
  "google-aistudio-integration.test.ts",
  "google-aistudio-status.test.ts",
  "server-request-body-size.test.ts",
  "vision-routed.test.ts",
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
  const trackedTests = new Set(readdirSync(testsDir).filter((name) => name.endsWith(".test.ts")));
  for (const file of DRAIN_SENSITIVE_FILES) {
    expect(trackedTests.has(file)).toBe(true);
    const text = readFileSync(join(testsDir, file), "utf8");
    const starts = text.match(/\bstartServer\s*\(/g)?.length ?? 0;
    const awaitedStops = text.match(/\bawait\s+[A-Za-z_$][\w$?]*(?:\.[A-Za-z_$][\w$?]*)*\.stop\s*\(\s*true\s*\)/g)?.length ?? 0;
    if (starts > awaitedStops) {
      offenders.push(`${file}: ${starts} startServer call(s), ${awaitedStops} awaited stop(s)`);
    }
  }

  expect(offenders).toEqual([]);
});
