import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fixed fixture directory shared by two test files is a silent flake factory.
 *
 * `bun test --isolate` gives each file its own module registry, but every file shares one
 * process and one filesystem. Two files that delete and recreate the same path while
 * pointing OPENCODEX_HOME at it will destroy each other's config and credentials whenever
 * the suite happens to overlap them. The failure surfaces as an unrelated assertion (a 401
 * where a 400 was expected) in whichever file lost the race, and the failure count changes
 * from run to run.
 *
 * That is exactly how `.tmp-server-auth-test` came to be declared by both
 * server-auth.test.ts and management-provider-validation.test.ts: the 665b65643 split copied
 * the path literal without renaming it. Reviewers do not reliably catch a duplicated string
 * across two large files, so assert it here instead.
 */
const TESTS_DIR = import.meta.dir;

/** `join(import.meta.dir, ".tmp-foo")` and the template-literal spelling of the same thing. */
const FIXTURE_LITERAL = /import\.meta\.dir\s*,\s*(["'`])(\.tmp-[^"'`]*)\1/g;

/** This guard quotes the offending literal in its own prose, so it must skip itself. */
const SELF = "fixture-dir-uniqueness.test.ts";

function testFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter(name => name.endsWith(".test.ts") && name !== SELF)
    .sort();
}

/**
 * Strip comments before scanning. The fix for the original flake left an explanatory comment
 * naming the old path in both files, and a naive scan reads that as a live declaration — the
 * first version of this guard failed exactly that way.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("test fixture directories", () => {
  test("no static fixture directory is shared by two test files", () => {
    const owners = new Map<string, string[]>();

    for (const file of testFiles()) {
      const source = withoutComments(readFileSync(join(TESTS_DIR, file), "utf8"));
      for (const match of source.matchAll(FIXTURE_LITERAL)) {
        const literal = match[2]!;
        // Paths carrying a runtime value (`${process.pid}`, a counter, mkdtemp output) are
        // already per-run and cannot collide, so they are not the hazard this guards.
        if (literal.includes("${")) continue;
        const list = owners.get(literal) ?? [];
        if (!list.includes(file)) list.push(file);
        owners.set(literal, list);
      }
    }

    // Name the offenders rather than just failing a count: the fix is to give one of them its
    // own directory, and the message should say which files to look at.
    const shared = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([literal, files]) => `${literal} <- ${files.join(", ")}`);

    expect(shared).toEqual([]);
  });

  test("ACL-sensitive fixtures and observed collision cases use per-run paths", () => {
    // These files either caused a real collision/Windows teardown cascade or persisted state
    // through the same ACL-hardening path. Each now derives a per-run directory, which also
    // makes two concurrent runs of the SAME file safe — something a rename alone would miss.
    for (const [file, fixedPath] of [
      ["server-auth.test.ts", ".tmp-server-auth-test"],
      ["management-provider-validation.test.ts", ".tmp-server-auth-test"],
      ["codex-quota-prime.test.ts", ".tmp-codex-quota-prime-test"],
      ["codex-routing.test.ts", ".tmp-codex-routing-test"],
      ["codex-pool-rotation.test.ts", ".tmp-codex-pool-rotation-test"],
      ["codex-main-rotation.test.ts", ".tmp-main-rotation-codex"],
      ["codex-main-rotation.test.ts", ".tmp-main-rotation-store"],
      ["codex-plan.test.ts", ".tmp-codex-plan-test"],
      ["codex-cooldown-recovery.test.ts", ".tmp-codex-cooldown-recovery-test"],
      ["session-affinity.test.ts", ".tmp-session-affinity-test"],
      ["issue-914-transport-attribution.test.ts", ".tmp-issue-914-test"],
      ["kimi-oauth-identity.test.ts", ".tmp-kimi-oauth-identity-test"],
      ["oauth-account-id-collision.test.ts", ".tmp-oauth-account-id-collision-test"],
      ["codex-auth-collision.test.ts", ".tmp-codex-auth-collision-test"],
      ["codex-account-delete-atomicity.test.ts", ".tmp-codex-account-delete-atomicity"],
    ]) {
      const source = withoutComments(readFileSync(join(TESTS_DIR, file), "utf8"));
      const fixedFixtures = [...source.matchAll(FIXTURE_LITERAL)].map(match => match[2]);
      expect(fixedFixtures).not.toContain(fixedPath);
      expect(source).toContain("mkdtempSync(join(tmpdir()");
    }
  });
});
