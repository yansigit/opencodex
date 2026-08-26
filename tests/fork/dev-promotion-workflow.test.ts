import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(new URL("../../.github/workflows/promote-dev.yml", import.meta.url), "utf8");
const workflow = Bun.YAML.parse(workflowText) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { permissions?: Record<string, unknown>; steps?: Array<Record<string, unknown>> }>;
};
const workflowSource = workflowText;

describe("dev promotion workflow contract", () => {
  test("runs only after successful dev push CI or trusted manual dispatch", () => {
    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["Cross-platform CI"],
      types: ["completed"],
      branches: ["dev"],
    });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflowSource).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflowSource).toContain("github.event.workflow_run.event == 'push'");
    expect(workflowSource).toContain("github.event.workflow_run.head_branch == 'dev'");
    expect(workflowSource).toContain("github.ref_name == github.event.repository.default_branch");
  });

  test("guards against a moved dev head before creating the promotion PR", () => {
    expect(workflowSource).toContain("github.event.workflow_run.head_sha");
    expect(workflowSource).toContain("id: verify");
    expect(workflowSource).toContain("verified_sha=$expected_ci_sha");
    expect(workflowSource).toContain("VERIFIED_CI_SHA: ${{ steps.verify.outputs.verified_sha }}");
    expect(workflowSource).toContain("git ls-remote origin refs/heads/dev");
    expect(workflowSource).toContain("gh run list --workflow ci.yml --commit");
    expect(workflowSource).toContain("live_dev_sha");
    expect(workflowSource).toContain("expected_ci_sha");
    expect(workflowSource).toContain("dev moved before the promotion PR mutation");
    expect(workflowSource).toContain("promotion PR head changed before verification");
    expect(workflowSource).toContain("exit 1");
  });

  test("skips promotion PR mutation when main and verified dev trees are identical", () => {
    expect(workflowSource).toContain('git fetch --no-tags origin "refs/heads/dev"');
    expect(workflowSource).toContain('fetched_dev_sha="$(git rev-parse FETCH_HEAD)"');
    expect(workflowSource).toContain('if [ "$fetched_dev_sha" != "$expected_ci_sha" ]; then');
    expect(workflowSource).toContain('git diff --quiet HEAD "$fetched_dev_sha" --');
    expect(workflowSource).toContain("trees_differ=false");
    expect(workflowSource).toContain("trees_differ=true");
    expect(workflowSource).toContain("if: steps.verify.outputs.trees_differ == 'true'");
  });

  test("uses least privilege and an immutable trusted checkout", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs?.promote?.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    });
    expect(workflowSource).toMatch(/actions\/checkout@[0-9a-f]{40} # v\d/);
    expect(workflowSource).toContain("persist-credentials: false");
  });

  test("creates or updates one human-gated dev-to-main PR", () => {
    const createStep = workflowSource.split("- name: Create or update the human promotion PR")[1];
    expect(workflowSource).toContain('gh pr list --base main --head dev --state open');
    expect(workflowSource).toContain("gh pr edit");
    expect(workflowSource).toContain("gh pr create");
    expect(workflowSource).toContain("--base main");
    expect(workflowSource).toContain("--head dev");
    expect(workflowSource).toContain("human");
    expect(workflowSource).toContain("multiple open dev-to-main promotion PRs exist");
    expect(createStep).toContain('if [ "$live_dev_sha" != "$VERIFIED_CI_SHA" ]');
    expect(createStep).not.toContain('expected_ci_sha="$(git ls-remote');
    expect(createStep).not.toContain("$expected_ci_sha");
  });

  test("never merges or force-pushes main", () => {
    expect(workflowSource).not.toContain("\\`");
    expect(workflowSource).not.toMatch(/gh\s+pr\s+merge/);
    expect(workflowSource).not.toMatch(/git\s+push/);
    expect(workflowSource).not.toMatch(/--force/);
  });
});
