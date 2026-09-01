import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(
  import.meta.dir,
  "../../.github/workflows/fork-upstream-sync.yml",
), "utf8");

describe("fork upstream sync workflow contract", () => {
  test("polls on a schedule and supports manual dispatch", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
  });

  test("checks out the guarded trusted ref with the immutable action", () => {
    expect(workflow).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(workflow).toContain("ref: ${{ github.ref }}");
    expect(workflow).toContain("persist-credentials: false");
  });

  test("keeps the token read-only for contents while allowing issue and draft PR writes", () => {
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: write");
  });

  test("uses the supported GitHub App token input", () => {
    expect(workflow).toContain("client-id: ${{ vars.PR_AUTOMATION_APP_ID }}");
    expect(workflow).not.toContain("app-id:");
  });

  test("uses the deploy key for every push that may carry workflow files", () => {
    const pushLines = workflow.match(/^\s+.*git push .*$/gm) ?? [];

    expect(workflow).toContain("FORK_SYNC_SSH_KEY: ${{ secrets.FORK_SYNC_SSH_KEY }}");
    expect(workflow).toContain(
      "git remote set-url --push origin \"$(printf 'git@%s:%s.git' github.com \"$GITHUB_REPOSITORY\")\"",
    );
    expect(workflow.match(/git remote set-url --push origin/g)).toHaveLength(1);
    expect(pushLines.length).toBeGreaterThan(0);
    expect(pushLines.every(line => !line.includes("GIT_ASKPASS"))).toBe(true);
    expect(pushLines.every(line => /git push(?:\s+--\S+)*\s+origin(?:\s|$)/.test(line))).toBe(true);
  });

  test("passes the two Cursor secrets only to emit", () => {
    expect(workflow).toContain("FORK_SYNC_CURSOR_WEBHOOK_URL");
    expect(workflow).toContain("FORK_SYNC_CURSOR_WEBHOOK_SECRET");
    expect(workflow).toContain("FORK_SYNC_NOTIFIERS: github-issue");
    expect(workflow).toContain("FORK_SYNC_COORDINATORS: cursor-webhook");
  });

  test("emits every non-no-op lane and summarizes its kind", () => {
    expect(workflow).toContain("main-behind");
    expect(workflow).toContain("history-diverged");
    expect(workflow).toContain("Fork sync lane: $kind");
    expect(workflow).toContain("steps.vendor.outputs.kind != 'already-current'");
  });

  test("prepares daily merges and opens draft PRs only for merged branches", () => {
    expect(workflow).toContain("/scripts/fork/sync/cli.ts\" prepare");
    expect(workflow).toContain("/scripts/fork/sync/cli.ts\" draft-pr");
    expect(workflow).toContain("steps.prepare.outputs.ready_for_pr == 'true'");
    expect(workflow).toContain('[ "$status" = "merged" ]');
    expect(workflow).toContain('/scripts/fork/sync/cli.ts" publish');
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
  });

  test("configures the temporary automation commit identity in the sync worktree", () => {
    expect(workflow).toContain('git -C "$FORK_SYNC_WORKTREE" config user.name "Yumi"');
    expect(workflow).toContain('git -C "$FORK_SYNC_WORKTREE" config user.email "automation""@""sbyoon.com"');
  });

  test("publishes a remote sync branch for every conflict handoff", () => {
    expect(workflow).toContain(
      "if: steps.vendor.outputs.kind == 'pin-updated' || steps.vendor.outputs.kind == 'main-behind' || steps.vendor.outputs.kind == 'history-diverged'",
    );
    expect(workflow).toContain('[ "$status" = "hotspot-handoff" ] || [ "$status" = "history-diverged" ]');
    expect(workflow).toContain('git switch -C "$branch"');
    expect(workflow).toContain('/scripts/fork/sync/cli.ts" publish');
  });

  test("prepares from dev while keeping scripts on the guarded trusted ref", () => {
    expect(workflow).toContain("ref: ${{ github.ref }}");
    expect(workflow).toContain("git fetch origin dev");
    expect(workflow).toContain("git fetch --force upstream main dev --tags --prune");
    expect(workflow).toContain("git worktree add");
    expect(workflow).toContain("FORK_SYNC_WORKTREE");
    expect(workflow).not.toContain("base=main");
    expect(workflow).not.toContain("base: main");
  });

  test("does not run dependency install scripts with the persisted write token", () => {
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
  });

  test("rejects manual dispatches from untrusted refs", () => {
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.ref_name != github.event.repository.default_branch");
    expect(workflow).not.toContain("github.ref_name != 'dev'");
    expect(workflow).toContain("Fork sync may only run from the default branch.");
  });

  test("keeps the upstream fetch step at the workflow step indentation", () => {
    expect(workflow).toContain(
      "      - name: Fetch upstream release refs\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -eu",
    );
  });

  test("starts Cursor only when publication created or fast-forwarded a handoff", () => {
    expect(workflow).toContain("steps.prepare.outputs.handoff_required == 'true'");
    expect(workflow).toContain("FORK_SYNC_COORDINATORS: cursor-webhook");
  });

  test("passes the prepare status into the Cursor handoff event", () => {
    expect(workflow).toContain("prepareStatus");
    expect(workflow).toContain("jq --arg prepareStatus");
    const cursorStep = workflow.split("- name: Notify Cursor handoff")[1];
    expect(cursorStep).toBeDefined();
    expect(cursorStep).toContain('bun "$GITHUB_WORKSPACE/scripts/fork/sync/cli.ts" emit < "$RUNNER_TEMP/fork-sync-handoff.json"');
    expect(cursorStep).not.toContain('emit < "$event_file"');
  });

  test("builds the handoff payload before either notifier can consume it", () => {
    const handoffStep = workflow.split("- name: Build sync handoff payload")[1];
    expect(handoffStep).toBeDefined();
    expect(handoffStep).toContain('> "$RUNNER_TEMP/fork-sync-handoff.json"');
    expect(handoffStep).toContain("fork-sync-prepare.json");
    expect(handoffStep).toContain("mergeBaseCount");
    const issueStep = workflow.split("- name: Notify GitHub issue")[1];
    expect(issueStep).toContain('emit < "$RUNNER_TEMP/fork-sync-handoff.json"');
  });

  test("passes the full prepare result and three-way metadata to handoff", () => {
    const handoffStep = workflow.split("- name: Build sync handoff payload")[1];
    expect(handoffStep).toContain("fork-sync-prepare.json");
    expect(handoffStep).toContain("prepareResult");
    expect(handoffStep).toContain("publishResult");
    expect(handoffStep).toContain("headSha");
    expect(handoffStep).toContain("mergeBaseCount");
    expect(handoffStep).toContain("mergeBaseShas");
  });

  test("falls back to a trusted Jules issue only when Cursor is unavailable", () => {
    const cursorStep = workflow.split("- name: Notify Cursor handoff")[1];
    expect(cursorStep).toContain("coordinator_status");
    expect(cursorStep).toContain("FORK_SYNC_NOTIFIERS=github-issue");
    expect(cursorStep).toContain("FORK_SYNC_COORDINATORS=\"\"");
    expect(cursorStep).toContain("FORK_SYNC_CURSOR_WEBHOOK_URL");
    expect(cursorStep).toContain("FORK_SYNC_CURSOR_WEBHOOK_SECRET");
    expect(cursorStep).toContain("::warning::Cursor webhook unavailable - hotspot handoff will be handled by Jules via GitHub issue.");
    expect(cursorStep).toContain("Cursor webhook failed (HTTP \${coordinator_status:-unknown}); falling back to Jules-tracked GitHub issue (agent:jules).");
    expect(cursorStep).toContain("Jules fallback issue ensured for hotspot handoff.");
  });

  test("reports workflow failures and closes the notification after recovery", () => {
    expect(workflow).toContain("Reconcile sync failure notification");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("opencodex-fork-sync-workflow-failure");
    expect(workflow).toContain("agent:needs-human");
    expect(workflow).toContain('state: "closed"');
    expect(workflow).toContain("The freshness supervisor will retry after its cooldown");
  });

  test("does not create a Jules issue before Cursor fallback is known to fail", () => {
    const issueStep = workflow.split("- name: Notify GitHub issue")[1];
    expect(issueStep).toContain("steps.vendor.outputs.kind != 'history-diverged'");
    expect(issueStep).toContain("steps.prepare.outputs.status != 'hotspot-handoff'");
    expect(issueStep).toContain("steps.prepare.outputs.escalation_required == 'true'");
  });

  test("installs before exposing the push secret and verifies the SSH host", () => {
    expect(workflow.indexOf("bun install --frozen-lockfile --ignore-scripts")).toBeLessThan(
      workflow.indexOf("FORK_SYNC_SSH_KEY: ${{ secrets.FORK_SYNC_SSH_KEY }}"),
    );
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("UserKnownHostsFile=$known_hosts");
  });

  test("asserts pinning did not move the checked-out branch HEAD", () => {
    expect(workflow).toContain("git rev-parse --abbrev-ref HEAD");
    expect(workflow).toContain("EXPECTED_BRANCH: ${{ github.ref_name }}");
    expect(workflow).toContain('expected_branch="$EXPECTED_BRANCH"');
  });

  test("does not merge or force-push from the action", () => {
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/gh\s+pr\s+merge|git\s+push\s+.*--force|git\s+merge\s+-X/);
  });

  test("pushes only the two vendor refs after a successful pin", () => {
    expect(workflow).toContain(
      "git push --atomic origin refs/heads/vendor/main:refs/heads/vendor/main refs/heads/vendor/dev:refs/heads/vendor/dev",
    );
    expect(workflow).toContain('if [ "$kind" = "pin-updated" ] || [ "$kind" = "history-diverged" ]');
    expect(workflow).not.toMatch(/git\s+push\s+origin\s+(?:main|origin\/main)\b/);
  });

  test("reports a rejected atomic publication as divergence", () => {
    expect(workflow).toContain('kind="pin-diverged"');
    expect(workflow).toContain("atomic vendor publication was rejected; remote refs were preserved");
    expect(workflow).toContain('echo "kind=$kind" >> "$GITHUB_OUTPUT"');
  });

  test("leaves missing vendor refs for the stable-tag pinning logic", () => {
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/main");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/dev");
    expect(workflow).not.toContain("git branch vendor/main upstream/main");
    expect(workflow).not.toContain("git branch vendor/dev upstream/dev");
  });
});
