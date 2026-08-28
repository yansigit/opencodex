# Autonomous Issue Remediation Pipeline Implementation Plan

> Plan: docs/superpowers/plans/2026-08-27-autonomous-issue-remediation-pipeline-plan.md
> Spec: docs/superpowers/specs/2026-08-27-autonomous-issue-remediation-pipeline-design.md

## Global Constraints

- Runtime is Bun-native TypeScript.
- Core path (`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`) must NOT import `src/lab/` directly or transitively (`tests/core-lab-boundary.test.ts` must pass).
- `bun run typecheck` and `bun run privacy:scan` must remain green at all times (no secrets, tokens, or API keys in logs/issues).
- Follow TDD: every task writes a failing test first, watches it fail, writes minimal implementation, and verifies it passes.

## Task 1: Telemetry Fingerprinting & SQLite Ledger Engine

Implement normalized failure fingerprinting and local SQLite persistence.

**Files touched**:
- `src/telemetry/types.ts`
- `src/telemetry/fingerprint.ts`
- `src/telemetry/ledger.ts`
- `tests/telemetry-fingerprint.test.ts`
- `tests/telemetry-ledger.test.ts`

**Requirements**:
- Define `FailureEvent`, `FailureFingerprint`, `LedgerRecord`, and `RemediationStatus` ('monitoring' | 'dispatched' | 'fixed' | 'ignored').
- `computeFailureFingerprint(event)`: canonical normalization stripping ephemeral timestamps, session IDs, request IDs, line/col numbers, returning SHA-256 hash.
- `TelemetryLedger`: SQLite table `failure_events` in `~/.opencodex/telemetry-issues.sqlite` (or custom path). Methods: `recordFailure(event, windowMs)`, `getRecord(fingerprint)`, `updateStatus(fingerprint, status, details)`, `shouldDispatch(fingerprint, threshold, windowMs)`.
- TDD: write tests in `tests/telemetry-fingerprint.test.ts` and `tests/telemetry-ledger.test.ts` verifying hashing stability and rolling window threshold counting.

## Task 2: Runtime Interception & Error Hook

Wire error interception into stream responses and WebSocket upstream handling.

**Files touched**:
- `src/telemetry/hook.ts`
- `src/config/autonomous-remediation.ts`
- `src/server/responses/ws-upstream.ts`
- `src/server/responses/core.ts`
- `tests/telemetry-hook.test.ts`

**Requirements**:
- Define configuration helper in `src/config/autonomous-remediation.ts`: parses `autonomousRemediation` settings (`enabled`, `instanceId`, `threshold`, `rollingWindowMs`).
- `interceptRuntimeFailure(error, context)` in `src/telemetry/hook.ts`: extracts failure category (`websocket_1006`, `tool_repetition_loop`, `upstream_wire_error`), computes fingerprint, records to ledger.
- Hook into `src/server/responses/ws-upstream.ts` on 1006 close events and `src/server/responses/core.ts` on terminal failure events without altering user SSE streams.
- TDD: write tests in `tests/telemetry-hook.test.ts` simulating stream drops and verifying telemetry capture.

## Task 3: Local Dispatcher & Instance Authorization Boundary

Implement local issue dispatch using user's authenticated `gh` CLI with instance verification and remote deduplication.

**Files touched**:
- `src/telemetry/dispatcher.ts`
- `src/cli/telemetry-commands.ts`
- `src/cli/index.ts`
- `tests/telemetry-dispatcher.test.ts`

**Requirements**:
- Verify `instanceId` matches local config before taking any external action. No-op if unconfigured or disabled.
- Query existing open issues on `yansigit/opencodex` matching `fingerprint:<hash>` using `gh issue list`. If already present, link to it and mark `status = 'dispatched'` without creating a new issue.
- Create issue using `gh issue create` with labels `agent:jules,autonomous-fix,instance:verified` and embed machine-readable `<!-- opencodex-failure-telemetry ... -->` metadata block.
- CLI command: `ocx telemetry status` displaying currently tracked and dispatched failure signatures.
- TDD: write tests in `tests/telemetry-dispatcher.test.ts` mocking command runner and verifying payload format, remote search, and authorization gating.

## Task 4: GitHub Actions Auto-Merge Extension

Extend maintenance workflow to verify autonomous fixes and auto-merge to `dev`.

**Files touched**:
- `.github/scripts/agent-maintenance.cjs`
- `.github/workflows/agent-maintenance.yml`
- `.github/scripts/agent-maintenance.test.cjs`

**Requirements**:
- Extend `.github/scripts/agent-maintenance.cjs` with `autonomousMergeEvidence()`: verifies PR has label `autonomous-fix`, check runs include green baseline (`ci`, `enforce-target`, `hygiene`) and green Cursor Bugbot (`conclusion == success`), and head commit author/PR matches authorized session.
- In `.github/workflows/agent-maintenance.yml`, when `autonomousMergeEvidence` passes, execute GitHub GraphQL/REST merge into `dev` (non-squash merge commit) and mark tracking issue state `agent:completed`.
- TDD: add test cases in `.github/scripts/agent-maintenance.test.cjs` verifying autonomous merge validation logic, waiver handling, and failure rejections.
