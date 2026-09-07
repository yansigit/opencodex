import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  checkWorkflowPolicy,
  validateWorkflowPolicy,
  type RepositoryWorkflowPolicy,
  type WorkflowPolicyInput,
} from "../../scripts/ci/check-workflow-policy";
import { repoRoot } from "../helpers/repo-root";

const root = repoRoot();

async function loadInput(): Promise<WorkflowPolicyInput> {
  const policy = await Bun.file(resolve(root, ".github/policies/repository-policy.json"))
    .json() as RepositoryWorkflowPolicy;
  const yaml = async (path: string): Promise<unknown> =>
    Bun.YAML.parse(await Bun.file(resolve(root, path)).text());
  return {
    policy,
    paths: await yaml(policy.ci.paths) as Record<string, string[]>,
    ci: await yaml(policy.ci.workflow) as WorkflowPolicyInput["ci"],
    release: await yaml(policy.release.workflow) as WorkflowPolicyInput["release"],
  };
}

function clone(input: WorkflowPolicyInput): WorkflowPolicyInput {
  return structuredClone(input);
}

describe("repository workflow policy", () => {
  test("the checked-in workflows satisfy the shared policy", () => {
    expect(checkWorkflowPolicy(root)).toEqual([]);
  });

  test("the checker CLI is deterministic and succeeds silently except for its verdict", async () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "scripts/ci/check-workflow-policy.ts"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("workflow-policy: ok\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects ref-keyed concurrency and ambiguous merge-group diffs", async () => {
    const input = clone(await loadInput());
    input.ci.concurrency = {
      group: "cross-platform-ci-${{ github.ref }}",
      "cancel-in-progress": true,
    };
    const filter = Object.values(input.ci.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .find(step => step.id === "merge-group-filter");
    filter!.with!.base = "${{ github.ref }}";
    delete filter!.with!.ref;

    expect(validateWorkflowPolicy(input)).toEqual([
      "CI concurrency must use event-appropriate identities and cancel only stale pull-request or push runs",
      "CI paths-filter must use explicit merge_group base/head SHAs with safe fallbacks",
    ]);
  });

  test("rejects routing the Windows lane to a persistent runner", async () => {
    const input = clone(await loadInput());
    input.ci.jobs!["platform-windows"]!["runs-on"] = ["self-hosted", "Windows", "X64", "ocx-home"];
    expect(validateWorkflowPolicy(input)).toContain(
      "the Windows CI lane must use only the ephemeral GitHub-hosted runner",
    );
  });

  test("rejects aggregate and release-source drift", async () => {
    const input = clone(await loadInput());
    input.ci.jobs!.ci!.needs = ["changes"];
    input.release.jobs!["auto-release"]!.if =
      "github.event.workflow_run.conclusion == 'success'";
    expect(validateWorkflowPolicy(input)).toEqual([
      "CI aggregate job must directly need every producer job",
      "auto-release gate is missing: github.event.workflow_run.event == 'workflow_run'",
      "auto-release gate is missing: github.event.workflow_run.head_branch == 'main'",
    ]);
  });

  test("rejects weakened runner selection and aggregate shell gates", async () => {
    const input = clone(await loadInput());
    input.ci.jobs!["platform-windows"]!["runs-on"] = "self-hosted";
    const aggregate = input.ci.jobs?.ci?.steps
      ?.find(step => step.name === "Assert every needed job succeeded or was skipped");
    aggregate!.run = "set -euo pipefail\ntrue";
    expect(validateWorkflowPolicy(input)).toEqual([
      "CI aggregate job must fail closed on every non-success/non-skipped producer and required Windows result",
      "the Windows CI lane must use only the ephemeral GitHub-hosted runner",
    ]);
  });

  test("rejects path-policy drift that can bypass CI", async () => {
    const input = clone(await loadInput());
    input.paths.ci = input.paths.ci!.filter(path => path !== ".github/policies/**");
    expect(validateWorkflowPolicy(input)).toContain(
      "ci path policy must include .github/policies/**",
    );
  });

  test("includes composite actions in the shared CI path scope", async () => {
    const input = await loadInput();
    expect(input.paths.ci).toContain(".github/actions/**");
  });
});
