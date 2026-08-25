# End-to-End Autonomous Upstream Sync & Maintenance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the upstream sync, conflict resolution, and PR maintenance pipelines so the system runs fully autonomously—from upstream tag polling to automated conflict resolution and automated draft-to-ready conversion—leaving only the final merge button for the repository owner.

---

### Task 1: Fix Workflow Handoff & Event Payload

**Files:**
- Modify: `.github/workflows/fork-upstream-sync.yml`
- Modify: `tests/fork/sync-workflow.test.ts`

- [x] **Step 1: Write failing test in `tests/fork/sync-workflow.test.ts`** asserting that `fork-upstream-sync.yml` passes `$RUNNER_TEMP/fork-sync-handoff.json` (containing `prepareStatus`) to the coordinator emit step.
- [x] **Step 2: Run test and verify it fails.**
- [x] **Step 3: Update `.github/workflows/fork-upstream-sync.yml`** to pass `$RUNNER_TEMP/fork-sync-handoff.json`.
- [x] **Step 4: Run test and verify it passes.**

---

### Task 2: Jules Fallback Dispatch for Sync Conflicts

**Files:**
- Modify: `scripts/fork/sync/notifiers/github-issue.ts`
- Modify: `tests/fork/sync-notify.test.ts`
- Modify: `.github/workflows/agent-maintenance.yml`
- Modify: `.github/scripts/agent-maintenance.cjs`
- Modify: `.github/scripts/agent-maintenance.test.cjs`

- [x] **Step 1: Write failing tests in `tests/fork/sync-notify.test.ts`** verifying that `hotspot-handoff` or `history-diverged` events with no webhook coordinator create an issue with `agent:jules` label and `[agent:sync]` title.
- [x] **Step 2: Run test and verify failure.**
- [x] **Step 3: Update `scripts/fork/sync/notifiers/github-issue.ts`** to add `agent:jules` label and conflict metadata when in hotspot-handoff.
- [x] **Step 4: Update `.github/scripts/agent-maintenance.cjs` and `.github/workflows/agent-maintenance.yml`** to recognize `[agent:sync]` tasks and instruct Jules to resolve conflicts according to `docs/fork/OWNED.md` on the sync branch.
- [x] **Step 5: Run tests and verify they pass.**

---

### Task 3: Automated Draft-to-Ready Conversion (Merge-Ready Gate)

**Files:**
- Modify: `.github/workflows/enforce-pr-target.yml`
- Modify: `.github/scripts/agent-maintenance.cjs`
- Modify: `.github/scripts/agent-maintenance.test.cjs`
- Modify: `.github/scripts/enforce-pr-target.test.cjs`

- [x] **Step 1: Write failing tests** for automated ready-for-review conversion when required baseline CI and Bugbot checks are clean on the current head SHA.
- [x] **Step 2: Run tests and verify failure.**
- [x] **Step 3: Update `.github/workflows/enforce-pr-target.yml` and `agent-maintenance.cjs`** to call `markPullRequestReadyForReview` and apply `review-ready` once all criteria are met on a draft PR.
- [x] **Step 4: Run tests and verify they pass.**

---

### Task 4: Full Suite Verification & Branch Hygiene

**Files:**
- Verify all tests across repository

- [x] **Step 1: Run all focused fork tests (`bun test tests/fork/*.test.ts`).**
- [x] **Step 2: Run all workflow & maintenance tests (`node --test .github/scripts/*.test.cjs`).**
- [x] **Step 3: Run `bun run typecheck`.**
- [x] **Step 4: Run `bun run privacy:scan`.**
