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

  test("checks out the exact trusted workflow revision with the immutable action", () => {
    expect(workflow).toContain(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    );
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: true");
  });

  test("grants vendor, issue, and draft PR write permissions", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: write");
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
    expect(workflow).toContain("steps.pin.outputs.kind != 'already-current'");
  });

  test("prepares daily merges and opens draft PRs only for merged branches", () => {
    expect(workflow).toContain("/scripts/fork/sync/cli.ts\" prepare");
    expect(workflow).toContain("/scripts/fork/sync/cli.ts\" draft-pr");
    expect(workflow).toContain("steps.prepare.outputs.status == 'merged'");
    expect(workflow).toContain("refs/heads/$branch:refs/heads/$branch");
  });

  test("configures the temporary automation commit identity in the sync worktree", () => {
    expect(workflow).toContain('git -C "$FORK_SYNC_WORKTREE" config user.name "Yumi"');
    expect(workflow).toContain('git -C "$FORK_SYNC_WORKTREE" config user.email "automation""@""sbyoon.com"');
  });

  test("publishes a remote sync branch for every conflict handoff", () => {
    expect(workflow).toContain(
      "if: steps.pin.outputs.kind == 'pin-updated' || steps.pin.outputs.kind == 'main-behind' || steps.pin.outputs.kind == 'history-diverged'",
    );
    expect(workflow).toContain("status\" = \"hotspot-handoff\" ] || [ \"$status\" = \"history-diverged\"");
    expect(workflow).toContain('git push origin "refs/heads/$branch:refs/heads/$branch"');
    expect(workflow).toContain('git switch -C "$branch"');
  });

  test("prepares from dev while keeping scripts on the trusted workflow revision", () => {
    expect(workflow).toContain("ref: ${{ github.sha }}");
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
    expect(workflow).toContain("github.ref_name != 'dev'");
  });

  test("keeps the upstream fetch step at the workflow step indentation", () => {
    expect(workflow).toContain(
      "      - name: Fetch upstream release refs\n        run: |\n          set -eu",
    );
  });

  test("starts Cursor only for hotspot or history handoff", () => {
    expect(workflow).toContain("steps.prepare.outputs.status == 'hotspot-handoff'");
    expect(workflow).toContain("steps.pin.outputs.kind == 'history-diverged'");
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
  });

  test("does not create a Jules issue before Cursor fallback is known to fail", () => {
    const issueStep = workflow.split("- name: Notify GitHub issue")[1];
    expect(issueStep).toContain("steps.pin.outputs.kind != 'history-diverged'");
    expect(issueStep).toContain("steps.prepare.outputs.status != 'hotspot-handoff'");
  });

  test("asserts pinning did not move the default branch HEAD", () => {
    expect(workflow).toContain("git rev-parse --abbrev-ref HEAD");
    expect(workflow).toContain("github.event.repository.default_branch");
  });

  test("does not merge or force-push from the action", () => {
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/gh\s+pr\s+merge|git\s+push\s+.*--force|git\s+merge\s+-X/);
  });

  test("pushes only the two vendor refs after a successful pin", () => {
    expect(workflow).toContain(
      "git push origin refs/heads/vendor/main:refs/heads/vendor/main refs/heads/vendor/dev:refs/heads/vendor/dev",
    );
    expect(workflow).toContain(
      "if: steps.pin.outputs.kind == 'pin-updated' || steps.pin.outputs.kind == 'history-diverged'",
    );
    expect(workflow).not.toMatch(/git\s+push\s+origin\s+(?:main|origin\/main)\b/);
  });

  test("bootstraps missing vendor refs from upstream instead of failing the fetch", () => {
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/main");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/dev");
    expect(workflow).toContain("git branch vendor/main upstream/main");
    expect(workflow).toContain("git branch vendor/dev upstream/dev");
  });
});
