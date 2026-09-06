import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { helperPath, isRepoPackageName, repoPath, repoRoot } from "./helpers/repo-root";
import { isTestFileName } from "../scripts/test-layout/plan";
import { loadLayout, resolveTarget } from "../scripts/test-layout/schema";

// Every JavaScript/TypeScript *.test.* under tests/ must resolve to a domain, and once a domain is listed in
// layout.migrated no file that resolves to it may still sit at the root. Root support files
// are on keepAtRoot. Uses the same resolver as the mover, so the guard and the tool agree;
// tests/test-layout-tooling.test.ts holds the independent membership oracle.
describe("tests/ layout", () => {
  const layout = loadLayout();
  const root = join(repoRoot(), "tests");

  test("repo-root helper resolves the package", () => {
    expect(repoRoot()).toBe(repoPath());
    expect(helperPath("remove-tree.ts")).toBe(join(root, "helpers", "remove-tree.ts"));
    expect(isRepoPackageName("@yansigit/opencodex")).toBe(true);
    expect(isRepoPackageName("@bitkyc08/opencodex")).toBe(true);
    expect(isRepoPackageName("opencodex")).toBe(false);
  });

  test("every test file resolves to a domain and migrated domains hold no stragglers", () => {
    const unresolved: string[] = [];
    const stragglers: string[] = [];
    const misplaced: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!isTestFileName(entry)) continue;
        const rel = relative(root, full).split(sep).join("/");
        const dirName = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        // helpers/ and fixtures/ hold support files only; a test module there is misplaced.
        if (/^(helpers|fixtures)(\/|$)/.test(dirName)) { misplaced.push(`${rel} -> not a test directory`); continue; }
        const target = resolveTarget(layout, entry);
        if (target === null) {
          if (!layout.keepAtRoot.includes(entry)) unresolved.push(rel);
          else if (dirName !== "") misplaced.push(`${rel} -> keepAtRoot`);
          continue;
        }
        if (dirName === "" && layout.migrated.includes(target.split("/")[0]!)) stragglers.push(rel);
        if (dirName !== "" && dirName !== target) misplaced.push(`${rel} -> ${target}`);
      }
    };
    walk(root);
    expect({ unresolved, stragglers, misplaced }).toEqual({ unresolved: [], stragglers: [], misplaced: [] });
  });
});
