# Cursor Automation handoff

The parent agent must open the Cursor Automations editor after
`.cursor/skills/opencodex-fork-sync/automation-prompt.md` is committed. Configure
the automation for the Cursor webhook and use that committed prompt.

Add these repository secrets to the fork:

- `FORK_SYNC_CURSOR_WEBHOOK_URL`
- `FORK_SYNC_CURSOR_WEBHOOK_SECRET`

The automation must stop after preparing the disposable rebuild, decision
table, and draft PR. A human reviews and merges `origin/dev`; this
implementation does not open the Automations editor.

The handoff payload's `prepareResult` is authoritative. For
`decision-handoff`, inspect `handoffReason`: `conflict` means the merge was
aborted without choosing either side; `preservation` means the clean result
has unresolved preservation candidates. Complete the same questionnaire stored
in `docs/fork/PRESERVATION.json`, regenerate exact-head provenance, and never
apply an unrecorded drop. Any push invalidates the previous report and hashes.

GitHub `pull_request_target` and scheduled workflows load their trusted
automation from the repository default branch (`origin/main`). Promoting the
maintenance workflow and its controller from `dev` to `origin/main` is a
maintainer-controlled release step; until that promotion, the implementation
is present on `dev` but is not active on GitHub's default-branch event path.
