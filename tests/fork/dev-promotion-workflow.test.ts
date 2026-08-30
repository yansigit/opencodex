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
      workflows: ["Cross-platform CI", "Release"],
      types: ["completed"],
      branches: ["dev", "main"],
    });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflowSource).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflowSource).toContain("github.event.workflow_run.event == 'push'");
    expect(workflowSource).toContain("github.event.workflow_run.head_branch == 'dev'");
    expect(workflowSource).toContain("github.ref_name == github.event.repository.default_branch");
    expect(workflowSource).toContain("github.event.workflow_run.name == 'Cross-platform CI'");
  });

  test("reconciles main ancestry after successful main or dev push CI", () => {
    expect(workflow.jobs?.backmerge?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(workflowSource).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflowSource).toContain("github.event.workflow_run.name == 'Cross-platform CI'");
    expect(workflowSource).toContain("github.event.workflow_run.event == 'push'");
    expect(workflowSource).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflowSource).toContain("id: verify-main");
    expect(workflowSource).toContain("github.event.workflow_run.head_sha");
    expect(workflowSource).toContain("refs/heads/main");
    expect(workflowSource).toContain("refs/heads/dev");
    expect(workflowSource).toContain("fork-promotion-backmerge.cjs");
    expect(workflowSource).toContain('"$verified_main_sha" =~ ^[0-9a-f]{40}$ && "$live_dev_sha" =~ ^[0-9a-f]{40}$');
    expect(workflowSource).toContain('"$VERIFIED_TARGET_SHA:refs/heads/dev"');
    expect(workflowSource).toContain("GIT_ASKPASS");
    expect(workflowSource).toContain("git-askpass.sh");
    expect(workflowSource).toContain("GIT_TERMINAL_PROMPT: 0");
    expect(workflowSource).toContain("id: backmerge-app-token");
    expect(workflowSource).toContain("GH_TOKEN: ${{ steps.backmerge-app-token.outputs.token }}");
    expect(workflowSource).toContain("post_main_sha");
    expect(workflowSource).toContain("post_dev_sha");
    expect(workflowSource).toContain("dev back-merge postcheck failed");
    expect(workflowSource).toContain("back-merge push remained uncertain after 3 attempts");
    expect(workflowSource).toContain("back-merge refs moved during retry");
    expect(workflowSource).toContain("main CI is not green yet; its workflow_run will retry reconciliation");
    expect(workflowSource).not.toContain("gh api --method PATCH");
    expect(workflowSource).toContain("main moved before the dev back-merge");
    expect(workflowSource).toContain("dev moved before the dev back-merge");
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
    expect(workflowSource).toContain("main_ancestor=true");
    expect(workflowSource).toContain("steps.verify.outputs.main_ancestor == 'true'");
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

  test("mints least-privilege App tokens only for the two dev writers", () => {
    const backmergeSteps = workflow.jobs?.backmerge?.steps ?? [];
    const postReleaseSteps = workflow.jobs?.post_release?.steps ?? [];
    const tokenUse = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

    expect(backmergeSteps.find((step) => step.id === "backmerge-app-token")).toMatchObject({
      if: "steps.verify-main.outputs.eligible == 'true'",
      uses: tokenUse,
      with: {
        "client-id": "${{ vars.PR_AUTOMATION_APP_ID }}",
        "private-key": "${{ secrets.PR_AUTOMATION_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(postReleaseSteps.find((step) => step.id === "post-release-app-token")).toMatchObject({
      if: "steps.verify-release.outputs.action == 'bump'",
      uses: tokenUse,
      with: {
        "client-id": "${{ vars.PR_AUTOMATION_APP_ID }}",
        "private-key": "${{ secrets.PR_AUTOMATION_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(workflowSource).not.toContain("permission-workflows");
    expect(backmergeSteps.find((step) => step.name === "Reconcile verified main ancestry into dev")).toMatchObject({
      env: { GH_TOKEN: "${{ steps.backmerge-app-token.outputs.token }}" },
    });
    expect(postReleaseSteps.find((step) => step.name === "Bump and push the next stable dev version")).toMatchObject({
      env: { GH_TOKEN: "${{ steps.post-release-app-token.outputs.token }}" },
    });
    expect(workflow.jobs?.promote?.steps?.some((step) => step.uses === tokenUse)).toBe(false);
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
    expect(workflowSource).not.toMatch(/--force(?!-with-lease)/);
    expect(workflowSource).toContain('"$VERIFIED_TARGET_SHA:refs/heads/dev"');
    expect(workflowSource).not.toMatch(/git\s+push[^\n]*refs\/heads\/main/);
  });

  test("post-release advances an exact main release to the next stable dev patch", () => {
    expect(workflow.jobs?.post_release?.permissions).toEqual({ contents: "read" });
    expect(workflowSource).toContain("post_release:");
    expect(workflowSource).toContain("github.event.workflow_run.name == 'Release'");
    expect(workflowSource).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(workflowSource).toContain("github.event.workflow_run.event == 'repository_dispatch'");
    expect(workflowSource).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflowSource).toContain("WORKFLOW_PATH: ${{ github.event.workflow_run.path || '' }}");
    expect(workflowSource).toContain("WORKFLOW_REPOSITORY: ${{ github.event.workflow_run.repository.full_name || '' }}");
    expect(workflowSource).toContain('expectedWorkflowPath: ".github/workflows/release.yml"');
    expect(workflowSource).toContain("EXPECTED_RELEASE_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(workflowSource).toContain("git merge-base --is-ancestor");
    expect(workflowSource).toContain("npm version patch --no-git-tag-version");
    expect(workflowSource).toContain("git config user.name");
    expect(workflowSource).toContain("git push origin");
    expect(workflowSource).not.toContain('--force-with-lease="refs/heads/dev:');
    expect(workflowSource).toContain("id: post-release-app-token");
    expect(workflowSource).toContain("GH_TOKEN: ${{ steps.post-release-app-token.outputs.token }}");
    expect(workflowSource).toContain("refs/heads/dev");
    expect(workflowSource).toContain("tag_sha");
    expect(workflowSource).toContain("npm view");
    expect(workflowSource).toContain("gh api \"repos/$EXPECTED_REPOSITORY/releases/tags/v${release_version}\"");
    expect(workflowSource).toContain("--atomic");
    expect(workflowSource).toContain("post-release push remained uncertain after 3 attempts");
    expect(workflowSource).toContain("post-release refs moved during retry");
    expect(workflowSource).toContain("--force-with-lease=\"refs/tags/v${RELEASE_VERSION}:$VERIFIED_MAIN_SHA\"");
    expect(workflowSource).toContain("post-release dev version check failed");
    expect(workflowSource).toContain('bump_base_sha="$EXPECTED_RELEASE_SHA"');
    expect(workflowSource).toContain('[ "$main_is_ancestor" = true ] && bump_base_sha="$live_dev_sha"');
    expect(workflowSource).toContain('VERIFIED_BASE_SHA: ${{ steps.verify-release.outputs.bump_base_sha }}');
    expect(workflowSource).toContain('git switch --detach --quiet "$VERIFIED_BASE_SHA"');
    expect(workflowSource).toContain('git rev-parse HEAD^)" != "$VERIFIED_BASE_SHA"');
  });
});
