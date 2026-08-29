# SDD ledger — plan: .tmp/native-pr-maintenance-plan.md

Baseline: `47bfee47834734cd152aea5823006d91f384bb04` (`origin/dev` at workspace creation).
Spec: the user-approved plan is represented by `.tmp/native-pr-maintenance-plan.md`; no separate tracked spec exists.

## Preflight interface scan

| Tasks | Producer / consumer interface | Finding / ruling |
| --- | --- | --- |
| 1 self | Pure classifiers/gates and table tests | Internally consistent. Keep GitHub API mutation out of this module. |
| 2 self | Workflow consumes pure policy and owns API side effects | Internally consistent. Shadow mode must not require App credentials. |
| 3 self | Sync/Jules integration plus docs/setup | Internally consistent only after the active upstream-sync task lands. |
| 1 → 2 | `classifyPullRequest`, `exactHeadGate`, `approvalEvidence`, `botMergeEvidence`, `buildAutomationComment` | Task 2 must use these exports rather than duplicate policy in YAML. |
| 1 → 3 | Bot provenance and active-session inputs | Task 3 may extend input shapes but must preserve Task 1 fail-closed defaults. |
| 2 → 3 | Workflow labels/state and App-generated base-update record | Task 3 docs/Jules validation must use the exact state format Task 2 emits. |

Ruling: shadow mode uses the default `GITHUB_TOKEN` for read/comment reconciliation and skips App-token creation; update/merge modes require the App. — This permits safe deployment before credentials exist. — If wrong, shadow rollout would fail before producing evidence.

Task 1 review remediation: the pure policy engine now applies the universal exact-head gate before every merge evidence source, requires the persisted maintainer approval record, enforces the fixed baseline checks and App IDs, requires explicit complete changed-file and current-base SHA evidence, and rejects unbound/bare sync provenance.

Ruling: approval is persisted in the bot-owned state comment as `{headSha, actor, labeledEventId}` when a trusted maintainer applies `automerge-approved`; label presence alone is never authority. — GitHub label history does not reliably bind an event to a PR head. — If wrong, approval may need a different durable GitHub primitive.

Ruling: repository protection is documented with exact maintainer commands rather than implemented as an executable mutation script. — It avoids shipping a foot-gun that can rewrite repository administration accidentally. — If wrong, rollout is one manual API call less convenient.

Ruling: Task 3 waits for and incorporates the active upstream-sync task; Tasks 1 and 2 may proceed because they do not touch its files. — This honors branch/session ownership without idling independent implementation. — If wrong, later integration may need conflict resolution.

Ruling: reuse an idle prior design agent for Task 1 because the collaboration tree has reached its hard agent-node limit and refuses fresh spawns. — The task brief/report boundary and independent reviewer gate preserve isolation as far as the platform permits. — If wrong, inherited design context could bias implementation.

## Task 1 — complete

- Final commit before baseline rebase: `8a285a9e7`.
- Focused verification: 83 policy/helper tests passed; `git diff --check` clean.
- Review rounds closed fail-open authorization paths for Jules, persisted approval state, required checks/App IDs, file/base completeness, authenticated sync provenance, caller-supplied gates, and stacked terminal Jules PRs.
- Independent final verdict: spec PASS; task quality APPROVED.

Ruling: every bot merge source passes the same raw-evidence exact-head gate; callers cannot inject a pre-approved gate. — A shared trust boundary is smaller and safer than source-specific exceptions. — If wrong, a future source might need a separately signed evidence envelope.

Ruling: stacked topology outranks terminal agent state during classification. — Branch topology is a permanent merge-policy exclusion while session state is transient. — If wrong, terminal agent work on a stacked child would require an explicit manual-only class instead.

Review round 2 remediation: `botMergeEvidence` recomputes the exact-head gate from raw evidence and restricts Jules authorization to the completed, open, non-draft, same-repository `dev` lane with no hold, stacked, promotion, fork, or active-session classification. Focused policy/helper suite: 82/82 passing.

Final stacked-Jules remediation: stacked classification now outranks Jules active/terminal states, preventing an `openParentPullRequest` PR targeting `dev` from entering automatic merge. Focused policy/helper suite: 83/83 passing.
