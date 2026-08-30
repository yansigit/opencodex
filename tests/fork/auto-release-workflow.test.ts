import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowText = readFileSync(resolve(
  import.meta.dir,
  "../../.github/workflows/fork-auto-release.yml",
), "utf8");
const workflow = Bun.YAML.parse(workflowText) as {
  on?: {
    workflow_run?: {
      workflows?: string[];
      types?: string[];
      branches?: string[];
    };
  };
  permissions?: Record<string, string>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<string, {
    if?: string;
    permissions?: Record<string, string>;
    "timeout-minutes"?: number;
    steps?: Array<{
      id?: string;
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      with?: Record<string, string>;
    }>;
  }>;
};

describe("fork auto-release workflow contract", () => {
  test("runs only after successful Cross-platform CI on main", () => {
    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["Cross-platform CI"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.jobs?.["auto-release"]?.if).toContain("conclusion == 'success'");
  });

  test("uses minimum dispatch permissions and bounded non-canceling concurrency", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs?.["auto-release"]?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(workflow.jobs?.["auto-release"]?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(workflow.concurrency).toEqual({
      group: "fork-auto-release",
      "cancel-in-progress": false,
    });
  });

  test("checks out the CI head with the immutable checkout action", () => {
    expect(workflowText).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(workflowText).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
  });

  test("dispatches only the audited stable release event", () => {
    const steps = workflow.jobs?.["auto-release"]?.steps ?? [];
    expect(steps.find(step => step.uses?.startsWith("actions/create-github-app-token@"))).toMatchObject({
      id: "release-dispatch-app-token",
      uses: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
      with: {
        "client-id": "${{ vars.PR_AUTOMATION_APP_ID }}",
        "private-key": "${{ secrets.PR_AUTOMATION_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(workflowText).toContain('event_type:"fork-auto-release"');
    expect(workflowText).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/dispatches" --input -');
    expect(workflowText).toContain("GH_TOKEN: ${{ steps.release-dispatch-app-token.outputs.token }}");
    expect(workflowText).toContain("expected_sha:$expected_sha");
    expect(workflowText).not.toContain("gh workflow run");
    expect(workflowText).not.toMatch(/^\s*npm publish\b/m);
  });

  test("keeps publish credentials in release.yml", () => {
    expect(workflowText).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token/);
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toContain("${{");
      }
    }
  });

  test("waits for the service lifecycle gate when needed", () => {
    expect(workflowText).toContain("service-lifecycle.yml");
    expect(workflowText).toContain("waitForSuccessfulCi");
    expect(workflowText).toContain("service paths");
  });

  // Indented `node <<` inside `run: |` never sees a column-0 terminator, so bash
  // treats the rest of the step as the heredoc and exits 2 before npm view.
  test("decides from the env CLI instead of a nested node heredoc", () => {
    expect(workflowText).not.toMatch(/^\s*node <</m);
    expect(workflowText).toContain("node .github/scripts/fork-auto-release.cjs");
  });

  test("passes the exact audited commit message to the decision before npm lookup", () => {
    const decideStep = workflow.jobs?.["auto-release"]?.steps?.find(step =>
      step.run?.includes("fork-auto-release.cjs")
    );
    expect(decideStep?.run).toContain('git show -s --format=%B "$HEAD_SHA"');
    expect(decideStep?.env?.RAW_COMMIT_MESSAGE).toBeUndefined();
    expect(decideStep?.run?.indexOf("git show -s --format=%B")).toBeLessThan(
      decideStep?.run?.indexOf("npm view") ?? -1,
    );
  });
});
