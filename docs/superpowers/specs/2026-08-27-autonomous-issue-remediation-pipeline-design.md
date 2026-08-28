# Autonomous Issue Remediation Pipeline Design

Date: 2026-08-27
Status: Approved Design
System: opencodex Autonomous Telemetry, Remediation, and Promotion

## Overview & Motivation

Repeated operational issues (e.g. WebSocket 1006 connection drops under heavy context, tool replay repetition loops, schema mismatches, and merge conflicts) require continuous developer intervention:
1. Detecting errors across scattered logs (`~/.opencodex/service.log`, `routing-history.sqlite`, `~/.codex/logs_2.sqlite`).
2. Manually triggering debugging sessions in Codex.
3. Implementing fixes, verifying with tests, and opening PRs to `dev`.
4. Merging PRs to `dev` and coordinating promotion to `main`.
5. Forgetting to restart or reload local proxy instances that continue running stale code.

This design automates this entire lifecycle end-to-end:
`Local Detection & Fingerprinting -> Deduplicated Dispatch (via 'my instance') -> Autonomous Repair (Jules + Cursor Bugbot) -> Auto-Merge to dev -> dev Auto-Release & Promotion to main -> Local Feedback Loop`.

---

## Architectural Components

### 1. Local Failure Detection, Fingerprinting & De-duplication

- **Runtime Hook**:
  A lightweight hook integrated into the server error handler and stream relay (`src/server/responses/core.ts` and `src/server/responses/ws-upstream.ts`).
- **Normalized Fingerprinting**:
  Produces a deterministic hash to identify unique issue classes:
  `fingerprint = sha256(failure_kind + ":" + provider + ":" + model + ":" + normalized_signature)`
  - Variable tokens, timestamps, nonces, request IDs, and session IDs are stripped before hashing.
- **Local Ledger (`~/.opencodex/telemetry-issues.sqlite`)**:
  - Table `failure_events`:
    - `fingerprint` (TEXT PRIMARY KEY)
    - `first_seen` (INTEGER)
    - `last_seen` (INTEGER)
    - `count` (INTEGER)
    - `status` ('monitoring' | 'dispatched' | 'fixed' | 'ignored')
    - `github_issue_number` (INTEGER NULL)
    - `resolution_sha` (TEXT NULL)
- **Threshold Gate**:
  - Triggers dispatch only when `count >= 3` within a rolling 30-minute window (filtering out transient network blips).
- **Deduplication Invariant**:
  - If `status == 'dispatched'`, skip.
  - If `status == 'fixed'`, only trigger if the failure reproduces on a commit ahead of `resolution_sha`.
  - Remote verification: Queries `gh issue list --repo yansigit/opencodex --state open --search "fingerprint:<hash>"` before creating a new ticket.

---

### 2. Instance Identity & Secure Dispatch

- **Authorization Gate**:
  - Reads configuration from `~/.opencodex/config.json`:
    ```json
    {
      "autonomousRemediation": {
        "enabled": true,
        "instanceId": "sb-macbook-pro"
      }
    }
    ```
  - If unconfigured or disabled, runtime detection is completely silent and never calls external APIs.
- **Trusted Local `gh` Execution**:
  - Dispatch is executed directly by the local proxy using the user's authenticated `gh` CLI.
  - No repository tokens or private keys are transmitted over network webhooks.
  - Command:
    ```bash
    gh issue create \
      --repo yansigit/opencodex \
      --title "fix(<provider>): <normalized error summary>" \
      --label "agent:jules,autonomous-fix,instance:verified" \
      --body "$ISSUE_BODY"
    ```
- **Metadata Payload**:
  - Embeds a machine-readable block inside the issue description:
    ```markdown
    <!-- opencodex-failure-telemetry
    fingerprint: 4f9b8c2...
    instance_id: sb-macbook-pro
    provider: openai
    model: gpt-5.6-luna
    error_code: websocket_1006_stream_drop
    repro_evidence: { ... sanitized payload ... }
    -->
    ```

---

### 3. Autonomous Remediation (Jules + Cursor Bugbot)

- **Workflow Orchestration (`.github/workflows/agent-maintenance.yml`)**:
  - Triggered by the `agent:jules` and `autonomous-fix` labels.
  - Invokes Google Jules API with:
    - Target task: Reproduce the error with a minimal test in `tests/` (TDD).
    - Implement the root-cause fix in `src/`.
    - Open a PR targeting `dev`.
- **Review & Repair**:
  - Cursor Bugbot automatically analyzes the PR diff.
  - If issues are detected, findings are fed back to Jules for automated correction (up to 2 attempts).
  - If findings persist beyond 2 attempts, PR is labeled `agent:needs-human` and halted.

---

### 4. Autonomous Merge to `dev` & Promotion to `main`

- **Auto-Merge Criteria (All Must Pass)**:
  1. Required CI checks pass (`ci`, `enforce-target`, `hygiene`).
  2. Cursor Bugbot concludes with `success` (0 unresolved findings).
  3. Live end-to-end inference smoke tests pass (`bun scripts/live-smoke.ts`).
  4. Label `autonomous-fix` present and verified against trusted author/instance.
- **Execution**:
  - Merged into `dev` via non-squash merge commit.
- **Dev Auto-Release**:
  - Merging to `dev` automatically triggers `.github/workflows/fork-dev-auto-release.yml` to publish a tagged dev build.
- **Promotion to `main`**:
  - Triggered via `.github/workflows/promote-dev.yml`.
  - Promotes `dev` to `main` after stability verification.

---

### 5. Local Instance Feedback & Process Reload

- **Local Watcher**:
  - The local instance polls the status of dispatched issues via `gh issue view` / `gh pr view`.
  - Once merged to `dev`:
    - Updates local ledger entry to `status = 'fixed'` with `resolution_sha`.
    - Prompts or performs graceful in-place service reload (`ocx reload` or restarting the background service) so the developer instance immediately runs the patched version.

---

## Verification & Safety Invariants

1. **Strict Dedup**: Never create duplicate issues or attempt parallel repairs for the same active fingerprint.
2. **Untrusted Environment No-Op**: Clones without `autonomousRemediation.enabled` in local configuration never execute `gh` dispatches.
3. **Quality & Security Gates**: Autonomous merges cannot bypass CI, Cursor Bugbot, or privacy scans. Protected paths (`src/oauth/`, workflow files, security boundaries) still require human maintainer sponsorship per `MAINTAINERS.md`.
