# Task 3 report

Implemented the native PR maintenance integration on the rebased task branch.

- Added `mergeable` to the required trusted-App check set and workflow dispatch wakeups.
- Sync PR creation now carries exact published-head provenance and applies `autonomous-sync` only for a merged, clean, non-handoff publication with no protected-surface resolution. Agent-resolved and handoff syncs are not labeled.
- Jules head movement accepts a controller-recorded merge only when its two parents are exactly the prior Jules head and current `dev`; active editing states are rejected.
- `automation:hold` records older than 24 hours are included in the workflow summary and are never removed.
- Updated repository policy/setup documentation, including an explicit `dev` protection command. `main` remains release-only and is not changed.

Review remediation:

- Replaced label-only wakeup with a trusted default-branch `workflow_dispatch` carrying PR/head/tag inputs. The controller accepts it only from the immutable GitHub Actions bot actor and exact body/label/head metadata, then persists its bot-owned sync record. Ordinary/manual dispatches cannot mint provenance.
- Existing sync PRs now reconcile label/provenance state and remove stale state when eligibility is lost.
- Jules autonomous merge rereads the complete live evidence and uses REST merge with the live expected SHA, closing the TOCTOU window.
- Complete changed-file evidence and the universal sensitive-path gate are required before sync authorization; conflict-resolution classifications alone are insufficient.
- Corrected dev protection guidance to zero generic approvals and documented all controller/Bugbot/Jules variables, secrets, app installation, and immutable identity prerequisites.
- Review remediation follow-up: removed undefined cross-workflow helper calls from the Jules merge path; the final check/file/head reread now recomputes `autonomousMergeEvidence` directly and requires complete file pagination before REST merge with the live SHA.
- Final reviewer remediation: sync publication now fetches repository metadata and the complete live PR file list before labeling/dispatching, rejects sensitive files and renames even on clean merges, reconciles unsafe existing PRs, and uses the resolved default branch for dispatch. The producer job has only the additional `actions: write` permission required for dispatch.
- Final security remediation: merge mode now mints the pinned PR Automation App token for sync PR/label mutations, with `PR_AUTOMATION_APP_USER_ID` used as the immutable producer identity; the redundant workflow dispatch path/permission was removed. The shared `isAgentProtectedPath` predicate is used for live sync files, and existing sync state is reconciled safely.
- Final audit closure: controller evidence now scopes the App bot identity correctly; Jules rereads current `dev`, proves live ancestry, rejects unresolved threads and current change requests, and rechecks the base immediately before its SHA-guarded merge. Branch protection binds required checks to App `15368` and documents the exact repository-only App permission allowlist.

Focused evidence:

```text
node --test .github/scripts/pr-automation.test.cjs .github/scripts/agent-maintenance.test.cjs .github/scripts/pr-automation-workflow.test.cjs
102 pass, 0 fail
bun test tests/fork/sync-pull-request.test.ts tests/fork/sync-workflow.test.ts
34 pass, 0 fail
```

Full suite validation is intentionally deferred to Task 4.
