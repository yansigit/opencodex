import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dir, "../../.github/workflows/fork-pr-mergeable.yml");
const workflow = () => readFileSync(workflowPath, "utf8");

describe("fork PR mergeable workflow", () => {
  test("covers integration and release PRs with readiness revalidation", () => {
    const source = workflow();

    expect(source).toMatch(/\bpull_request:/);
    expect(source).toMatch(/branches:\s*\n\s+- dev\s*\n\s+- main/);
    expect(source).toMatch(/types:[\s\S]*- edited/);
    expect(source).toMatch(/types:[\s\S]*- ready_for_review/);
    expect(source).not.toContain("pull_request_target");
    expect(source).toContain("ref: ${{ github.event.pull_request.head.sha }}");
  });

  test("uses read-only contents permission and a complete checkout", () => {
    const source = workflow();

    expect(source).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(source).not.toMatch(/pull-requests:\s*(?!read\b)\S+/);
    expect(source).toMatch(/fetch-depth:\s*0/);
    expect(source).toContain("persist-credentials: false");
  });

  test("fails dirty PRs and fails closed when mergeability stays unknown", () => {
    const source = workflow();

    expect(source).toContain("github.event.pull_request.mergeable");
    expect(source).toMatch(/mergeable[^\n]*false/);
    expect(source).toMatch(/mergeable[^\n]*null/);
    expect(source).toMatch(/retry|attempt/i);
    expect(source).toContain("GitHub has not computed mergeability");
  });

  test("rejects branches that are not descendants of the base with promotion-specific recovery", () => {
    const source = workflow();

    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain('"origin/$BASE_REF"');
    expect(source).toContain("HEAD");
    expect(source).toContain("Protected dev reconciliation must finish before this promotion can merge.");
    expect(source).toContain("merge the base into the pull request branch before retrying");
    expect(source).toContain("GitHub's 3-way");
  });

  test("does not mutate the pull request or repository", () => {
    const source = workflow();

    expect(source).not.toMatch(/\bgh\s+pr\s+merge\b/);
    expect(source).not.toMatch(/\bgh\s+(?:pr|issue)\s+(?:edit|comment|label)\b/);
    expect(source).not.toMatch(/pull-requests:\s*write/);
  });
});
