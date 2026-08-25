# Audit Concerns Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reconcile the fork-sync documentation with the dev-first implementation and verify the reported test failures without weakening socket-backed tests.

**Architecture:** Documentation is corrected at the source of the drift. Socket-backed suites are rerun with the repository-pinned Bun binary outside the restricted sandbox; no production fallback or test skip is added for an environment-only bind restriction. Promotion from `dev` to the public default branch remains a maintainer-controlled external action.

**Tech Stack:** Markdown, Bun 1.4, Bun tests, Git metadata.

**Spec:** `docs/superpowers/plans/2026-08-24-dev-first-upstream-sync.md` and the implemented fork-sync workflow/tests.

## Global Constraints

- Integration pull requests target `dev`; `main` receives maintainer-controlled promotions only.
- Never push or merge a protected branch from this task.
- Do not weaken or skip socket-backed tests to accommodate the restricted execution sandbox.
- Preserve the existing fork-sync safety gates and injected test boundaries.

### Task 1: Reconcile stale fork-sync plan language

**Files:**
- Modify: `docs/superpowers/plans/2026-08-24-fork-sync-action-merge.md`

- [x] Replace the stale integration-target statements with `dev` and explicitly distinguish `vendor/main` / trusted default-branch execution from the PR base.
- [x] Add a dated amendment explaining that the implementation is dev-first and that promotion to `origin/main` is outside an agent worktree.
- [x] Search the plan for remaining contradictory target or push instructions.

### Task 2: Document the default-branch promotion boundary

**Files:**
- Modify: `docs/fork/AUTOMATION-HANDOFF.md`

- [x] State that default-branch GitHub workflows execute from `origin/main`, so the maintenance workflow must be promoted there before it can run on GitHub.
- [x] Keep the promotion human-controlled and do not perform a push or merge.

### Task 3: Verify the reported test concerns

**Files:**
- No code changes.

- [x] Run affected socket-backed suites with `node_modules/bun/bin/bun.exe` outside the sandbox.
- [x] Run typecheck and privacy scan.
- [x] Confirm the sandbox-only `EADDRINUSE` behavior with a minimal listener probe and record the passing out-of-sandbox result in the handoff.

Verification: management-provider-validation 81/81, provider-outbound 15/15,
server-images 68/68, command-code suites 40/40, and Google provider options
14/14 passed with Bun 1.4 outside the sandbox. `bun run typecheck` and
`bun run privacy:scan` passed. The default sandbox still rejects all loopback
binds, including a minimal `Bun.serve({ port: 0 })` probe. A full `prepush`
attempt stalled after several minutes without output and remains a CI/host
runner follow-up; it was not counted as passing.
