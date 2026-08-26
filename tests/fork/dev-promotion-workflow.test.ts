import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/promote-dev.yml", import.meta.url), "utf8");

describe("dev promotion workflow contract", () => {
  test("runs only after successful dev push CI or trusted manual dispatch", () => {
    expect(workflow).toContain('workflows: ["Cross-platform CI"]');
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain("branches: [dev]");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'dev'");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.ref_name == github.event.repository.default_branch");
  });

  test("guards against a moved dev head before creating the promotion PR", () => {
    expect(workflow).toContain("github.event.workflow_run.head_sha");
    expect(workflow).toContain("id: verify");
    expect(workflow).toContain("verified_sha=$expected_ci_sha");
    expect(workflow).toContain("VERIFIED_CI_SHA: ${{ steps.verify.outputs.verified_sha }}");
    expect(workflow).toContain("git ls-remote origin refs/heads/dev");
    expect(workflow).toContain("live_dev_sha");
    expect(workflow).toContain("expected_ci_sha");
    expect(workflow).toContain("dev moved before the promotion PR mutation");
    expect(workflow).toContain("exit 1");
  });

  test("uses least privilege and an immutable trusted checkout", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40} # v\d/);
    expect(workflow).toContain("persist-credentials: false");
  });

  test("creates or updates one human-gated dev-to-main PR", () => {
    const createStep = workflow.split("- name: Create or update the human promotion PR")[1];
    expect(workflow).toContain('gh pr list --base main --head dev --state open');
    expect(workflow).toContain("gh pr edit");
    expect(workflow).toContain("gh pr create");
    expect(workflow).toContain("--base main");
    expect(workflow).toContain("--head dev");
    expect(workflow).toContain("human");
    expect(createStep).toContain('if [ "$live_dev_sha" != "$VERIFIED_CI_SHA" ]');
    expect(createStep).not.toContain('expected_ci_sha="$(git ls-remote');
    expect(createStep).not.toContain("$expected_ci_sha");
  });

  test("never merges or force-pushes main", () => {
    expect(workflow).not.toContain("\\`");
    expect(workflow).not.toMatch(/gh\s+pr\s+merge/);
    expect(workflow).not.toMatch(/git\s+push/);
    expect(workflow).not.toMatch(/--force/);
  });
});
