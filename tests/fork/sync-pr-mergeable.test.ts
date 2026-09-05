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

  test("preserves GitHub null while mergeability is still being computed", () => {
    const source = workflow();

    expect(source).toContain('if .mergeable == null then "null" else (.mergeable | tostring) end');
    expect(source).not.toContain("--jq '.mergeable'");
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

  test("uses only the trusted base verifier for sync PRs", () => {
    const source = workflow();
    expect(source).toContain("if: startsWith(github.head_ref, 'sync/')");
    expect(source).toContain("uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2");
    expect(source.indexOf("Setup Bun for trusted preservation verifier"))
      .toBeLessThan(source.indexOf("Preservation overlap check for sync PR"));
    expect(source).toContain('git worktree add --detach "$trusted" "$BASE_SHA"');
    expect(source).toContain('verifier="$trusted/scripts/fork/sync/cli.ts"');
    expect(source).not.toContain('verifier="$GITHUB_WORKSPACE/scripts/fork/sync/cli.ts"');
    expect(source).toContain('bun "$verifier" verify');
    expect(source).toContain('FORK_SYNC_WORKTREE="$GITHUB_WORKSPACE"');
    expect(source).toContain('FORK_SYNC_TRUSTED_REGISTRY="$trusted/docs/fork/PRESERVATION.json"');
    expect(source).toContain('"$trusted/docs/fork/PRESERVATION.json"');
    expect(source).not.toMatch(/jq[^\n]+\sdocs\/fork\/PRESERVATION\.json/);
    expect(source).not.toContain("bun scripts/fork/sync/cli.ts overlap");
  });

  test("binds exact head, registry, decisions, and report through PR provenance", () => {
    const source = workflow();
    expect(source).toContain("opencodex-fork-sync-provenance");
    expect(source).toContain('--arg merge "$HEAD_SHA"');
    expect(source).toContain('--argjson provenance "$provenance"');
  });

  test("resolves upstream release tag from trusted base or upstream package.json when introduced by sync PR", () => {
    const source = workflow();
    expect(source).toContain('tag="$(jq -r --arg sha "$upstream" \'.releases | to_entries[] | select(.value.tagSha == $sha) | .value.tag\' "$trusted/docs/fork/PRESERVATION.json" | head -n 1)"');
    expect(source).toContain('tag="$(git show "$upstream:package.json" 2>/dev/null | jq -r \'select(.version != null) | "v" + .version\' || true)"');
    expect(source).toContain('if [ -z "$tag" ]; then');
    expect(source).not.toContain("validateRegistryTransition' \"$trusted/scripts/fork/sync/preservation.ts\"");
    expect(source).toContain('echo "::error::Preservation provenance does not identify a registered upstream release"');
    expect(source).not.toMatch(/jq[^\n]+\sdocs\/fork\/PRESERVATION\.json/);
  });
});
