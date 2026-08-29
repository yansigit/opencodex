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

## Task 2 — complete

- Added `.github/workflows/pr-automation.yml` as the single trusted controller for open `dev` PR reconciliation, guarded branch updates, exact-head status, target-gate dispatch, and optional merge.
- Removed the superseded sync babysitter workflow/script/tests.
- Added `.github/scripts/pr-automation-workflow.test.cjs` with trigger, permissions, trusted-checkout, token-boundary, race, pagination, immutable bot-state, raw-evidence, promotion, and merge-response contracts.
- Focused verification: actionlint clean; embedded script syntax clean; workflow/policy/helper suite 81/81 passing.

Ruling: branch updates use GitHub's `update-branch` endpoint with an expected SHA and a single proven stale-head retry; no local branch writer or force push is permitted. — GitHub owns the merge-base operation and the expected SHA prevents overwriting concurrent work. — If wrong, the controller must remain status-only for that PR.

Ruling: automatic merge requires the pure policy engine's raw exact-head authorization plus a final live SHA/current-base reread and an affirmative merge response. — A fresh read closes stale event/check/comment races without duplicating policy in workflow code. — If wrong, merge mode must be disabled pending a stronger GitHub primitive.

Task 2 security review remediation: approval state is now minted only on the exact maintainer `pull_request_target` label event and never rebound from an old timeline event; stale head/controller updates clear the label and marker. Final merge rereads all raw evidence and rejects unresolved threads or current `CHANGES_REQUESTED`; maintenance state is parsed only from immutable bot-owned issue comments and duplicate/conflicting records fail closed. The 422 retry requires an explicit expected-head mismatch and a full fresh eligibility reclassification. Hardened focused suite: 85/85 passing.

Final Task 2 remediation: autonomous-sync provenance is head-bound to an immutable bot label event and hidden bot-owned record; malformed maintenance state is isolated to the exact PR (or only clearly agent-owned candidates for orphan records); update races and label invalidation reread before status rendering; post-update success requires an open, non-draft PR still targeting `dev`, the intended base SHA, fresh eligibility, and confirmed ancestry. Focused workflow/policy/helper suite: 88/88 passing; actionlint and embedded script syntax clean.

## Task 3 review remediation — complete

Review findings were addressed in the amended Task 3 commit: label-only sync wakeups now dispatch the trusted controller with exact PR/head/tag inputs; manual dispatches cannot mint provenance; existing PRs reconcile and clear stale sync state; Jules merge rereads full evidence and merges through REST with the live SHA; complete changed-file/sensitive-path evidence gates sync authorization; and dev protection documentation uses zero generic approvals. The invalid App-ID-as-user-ID comparison was removed. Focused policy/workflow suite: 102/102 passing; sync suite: 7/7 passing; typecheck, actionlint, and diff check clean.

Ruling: autonomous sync mutations are issued by the repository-only PR Automation App only in `merge` mode; other modes remain non-autonomous. — App-authored PR and label events are required to wake normal exact-head CI, unlike `GITHUB_TOKEN` mutations. — If wrong, the autonomous sync lane will remain unreachable or over-authorized.

Final security closure: fixed controller-comment state retention and App bot identity scoping; reused the authoritative protected-surface predicate; added current-base ancestry plus unresolved-review/change-request gates to the final Jules SHA merge; and bound documented required checks to GitHub Actions App `15368`. Focused policy/workflow suite: 102/102 passing; sync/workflow suite: 34/34 passing; actionlint and diff check clean.
