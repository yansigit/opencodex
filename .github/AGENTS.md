# GitHub automation instructions

This file applies to `.github/` and inherits the repository-wide rules in `/AGENTS.md`.

## Security boundary

Every workflow, ownership, branch-enforcement, release, or repository-automation
change requires explicit security review under `MAINTAINERS.md`.

## Workflow rules

- Grant the minimum required `permissions`.
- Pin third-party actions to immutable full commit SHAs.
- Preserve the human-readable version comment beside each pinned action.
- Do not run untrusted pull-request code with secrets or write permissions.
- Treat `pull_request_target`, workflow dispatch, reusable workflows, artifacts, caches, and generated command input as trust boundaries.
- Reusable workflow calls (`uses: ./.github/workflows/*.yml` with `with:`): expressions in `with:` must not use `env` or `secrets`. Use contexts GitHub permits there, such as `github`, `inputs`, `needs`, `strategy`, `matrix`, and `vars`. Caller `permissions:` must cover every callee job's needs.
- Release workflows (`release.yml`, `dev-version-bump.yml`): validate `workflow_dispatch.inputs` and `repository_dispatch.client_payload` shapes in a dedicated `validate-dispatch` job before using version or SHA.
- Do not broaden triggers, write permissions, token exposure, release eligibility, or publish capability without an explicit task requirement.
- Preserve cross-platform coverage where the workflow currently promises Linux, macOS, and Windows behavior.
- Keep branch-enforcement text synchronized with `AGENTS.md`, `MAINTAINERS.md`, and the public contributing guide.
- Required merge checks are `ci`, `hygiene`, `enforce-target`, and `mergeable` from the trusted App. `autonomous-sync` requires exact published-head provenance; never label handoff or agent-resolved syncs. Jules controller advances require parents `[previous Jules head, current dev]`, and active editing blocks them. Report `automation:hold` after 24 hours but never remove it automatically.

## Validation

- Inspect the complete workflow diff, including event triggers, permissions, conditions, interpolation, and shell behavior.
- Workflow file changes (`.github/workflows/**`): run `bun run lint:workflows` (actionlint semantic validation) and the matching workflow tests (e.g. `bun test tests/ci-workflows.test.ts`).
- Dependency or lock changes (`package.json`, `bun.lock`, `gui/package.json`, `gui/bun.lock`, overrides): run `bun run audit:high` (root and gui).
- Run the local commands represented by changed workflow steps where possible.
- Run `bun run prepush` for CI, release, dependency, packaging, or cross-platform workflow changes.
- Upstream sync / promotion readiness: when workflow files changed, workflow lint must be clean; when dependency files changed, audit must be clean; verify exact-head/provenance (tag, base, published head, registry/decision/report hashes); `cancelled` or `skipped` runs are not evidence of green — only `success` counts.
- A `main` push may reuse a promotion PR's dependency-audit result only when the
  read-only verifier proves the exact two-parent, tree-identical `dev` promotion,
  the same-repository merged PR, and a fresh successful `gates` audit step. The
  surrounding run may have been cancelled after merge, but that does not make it
  green: only the completed audit step is reused, and every missing, stale,
  ambiguous, changed-proof, or unavailable signal falls back to a live audit.
- A red `main` may be reconciled into exact-green `dev` only through the promotion backmerge helper's tree-preserving ancestry result. Never waive `main` CI for manual dispatch, a content-changing target, or a target that has not passed the helper's parent/tree postchecks.
- Automation health may report the one-commit `dev`-behind-`main` promotion window as a warning only while exact-tip `main` CI is active or within the bounded post-success reconciliation grace. Multi-commit, diverged, stale, failed-CI, or duplicate-controller states remain alerts.
- Post-release version advancement has one writer: `promote-dev.yml` verifies the published tag and exact release SHA, proves the next stable patch is unused in npm and remote tags, then makes the forward-only package-version commit through the repository App. `release.yml` must not also call `dev-version-bump.yml`; parallel bump authorities race, choose different successor policies, and leave a conflicting red PR.
- Do not claim the workflow itself passed until GitHub Actions reports success for the exact commit.
