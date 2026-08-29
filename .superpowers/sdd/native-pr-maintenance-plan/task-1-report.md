# Task 1 Report

Implemented the pure PR automation policy engine in `.github/scripts/pr-automation.cjs` with table-driven tests in `.github/scripts/pr-automation.test.cjs`.

## Delivered

- Stable PR classification for same-repository human, fork, draft, hold, stacked, promotion, deterministic sync, agent-resolved sync, and Jules active/terminal states.
- Fail-closed exact-head gate for SHA identity, complete changed-file pagination, mergeability, current-base ancestry, trusted check App IDs, exact-head check results, and sensitive current/renamed paths.
- Maintainer approval evidence bound to the live head and the latest active `automerge-approved` label event.
- Jules evidence delegated to the existing `autonomousMergeEvidence` helper; deterministic sync evidence additionally requires trusted provenance, exact-head Cursor Bugbot success, complete non-sensitive files, and no agent resolution.
- Deterministic bot-owned status comment with `<!-- opencodex-pr-automation:v1 -->`.

## TDD evidence

RED:

```text
$ node --test .github/scripts/pr-automation.test.cjs
Error: Cannot find module './pr-automation.cjs'
```

GREEN:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

Focused compatibility checks:

```text
$ node --check .github/scripts/pr-automation.cjs
$ node --check .github/scripts/pr-automation.test.cjs
$ node --test .github/scripts/agent-maintenance.test.cjs .github/scripts/pr-sponsored-surface.test.cjs
ℹ tests 43
ℹ pass 43
ℹ fail 0
```

## Review remediation TDD evidence

RED regression run after review findings:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 37
ℹ pass 31
ℹ fail 6
```

The six failures covered Jules bypassing the universal gate, label-only approval, caller-controlled checks, malformed App IDs, incomplete file evidence, and bare provenance.

GREEN after remediation:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 37
ℹ pass 37
ℹ fail 0

$ node --test .github/scripts/agent-maintenance.test.cjs .github/scripts/pr-sponsored-surface.test.cjs
ℹ tests 43
ℹ pass 43
ℹ fail 0
```

The remediation now applies the exact-head/complete-files/base-SHA/sensitive-path gate before both Jules and deterministic-sync evidence; requires the persisted `{headSha, actor, labeledEventId}` approval record; enforces the fixed baseline check set and per-check App IDs; and requires authenticated, identity-matched trusted sync provenance.

The implementation has no API mutation, checkout, dependency, or workflow changes.

## Review round 2 remediation TDD evidence

RED regression run before the implementation change:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 39
ℹ pass 37
ℹ fail 2
```

The two failures demonstrated that an injected `headGate` could authorize a
deterministic sync, and that a draft Jules PR could be reported ready. The
regression cases also table-check hold, fork, stacked, promotion, and active
Jules states.

GREEN after remediation:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 39
ℹ pass 39
ℹ fail 0

$ node --test .github/scripts/pr-automation.test.cjs .github/scripts/agent-maintenance.test.cjs .github/scripts/pr-sponsored-surface.test.cjs
ℹ tests 82
ℹ pass 82
ℹ fail 0
```

`botMergeEvidence` now always recomputes `exactHeadGate` from raw live
evidence and ignores caller-supplied gate results. Jules evidence is accepted
only for the completed, open, non-draft, same-repository, `dev`-targeted,
non-hold, non-stacked, non-promotion classification lane, while retaining the
existing authenticated Jules/session/head authorship evidence.

## Final stacked-Jules remediation TDD evidence

RED regression run before the precedence change:

```text
$ node --test .github/scripts/pr-automation.test.cjs
ℹ tests 40
ℹ pass 39
ℹ fail 1
```

The failure used a completed Jules PR with `openParentPullRequest: true` and
`base.ref: dev`; it was incorrectly classified as `jules-terminal`.

GREEN after remediation:

```text
$ node --test .github/scripts/pr-automation.test.cjs .github/scripts/agent-maintenance.test.cjs .github/scripts/pr-sponsored-surface.test.cjs
ℹ tests 83
ℹ pass 83
ℹ fail 0
```

Stacked classification now takes precedence over Jules active/terminal
states, so stacked PRs cannot enter an automatic merge lane.
