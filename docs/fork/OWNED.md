# Fork path ownership

Agents read this before resolving sync conflicts. Three-way merge: base = last common ancestor; **ours** = `origin/dev`; **theirs** = `vendor/main`.

Do not open this document or the fork overlay (the conflict class, not a git branch) as an upstream PR.

## Path classes

### `fork-owned` — default take ours

Files only this fork adds or maintains:

| Path |
|---|
| `src/fork/**` |
| `tests/fork/**` |
| `docs/fork/**` |
| `.cursor/skills/opencodex-fork-sync/**` |
| `scripts/fork/**` |
| `.github/workflows/fork-upstream-sync.yml` |
| `.github/workflows/fork-pr-mergeable.yml` |

### `shared-hotspot` — manual / agent report

Upstream and the fork overlay (conflict class) both touch wire protocol or core request path. Serialize merges on `google` adapters and `responses/core.ts` (never two workers at once).

| Path |
|---|
| `src/adapters/google*.ts` |
| `src/server/responses/core.ts` |
| `src/providers/antigravity-quota.ts` |
| `src/providers/quota.ts` (Antigravity quota probe path) |

Keep upstream control flow; re-fit fork behavior. Never “accept all ours” on these files.

The established shared-hotspot defaults are:

- `src/adapters/google-http.ts`: apply account cooldown first, then host
  failover.
- `src/server/responses/core.ts`: try the Antigravity 429 carousel first, then
  recover the opaque blob.

### `upstream-owned` — default take theirs

Everything not listed above. Re-apply fork intent as a **new small commit** only if still needed after taking upstream.

### `recipe` — resolve with a named merge recipe

| Path | Recipe |
|---|---|
| `package.json` | Take every non-release field from upstream, preserve our `name` as `@yansigit/opencodex`, and choose the higher valid SemVer of current and upstream; sync versions never decrease |

## Conflict defaults

| Class | Default | Notes |
|---|---|---|
| `upstream-owned` | Take theirs | Re-apply fork intent as a new small commit only if still needed |
| `fork-owned` | Take ours | Files only the fork added |
| `shared-hotspot` | Manual / agent report | Keep upstream control flow; re-fit fork behavior; never “accept all ours” |
| `recipe` | Run the named recipe | `package.json` keeps fork identity and a non-decreasing version while taking upstream metadata |
| Lockfiles | Take theirs | Regenerate if the fork added deps |
| File deleted by them, edited by us | Decide restore vs abandon | Record in merge message |
| Rename | Follow new path | `--find-renames`; do not keep a zombie old path |
| Upstream shipped the same idea | Drop ours | Duplicate patches cause later impossible conflicts |
| Refactor of a patched function | Port behavior | New `fork:` commit on the new shape; forget the old diff |

Never `git merge -X ours` across the tree.

## Preservation gate

Clean merges can silently overwrite fork behavior even when Git reports no textual conflict. The preservation gate detects this:

- `scripts/fork/sync/overlap.ts` requires one exact merge base and uses rename-aware base-to-fork, base-to-upstream, and base-to-result diffs plus blob IDs. It reports logical overlaps, fork deletions/renames, exact-upstream replacements, and changes to registered integration paths.
- `docs/fork/PRESERVATION.json` is the baseline feature registry and per-release questionnaire. Every candidate needs upstream intent, fork invariant, equivalence judgment, disposition, implementation evidence, and exact tests.
- `preserve` ports fork behavior to upstream control flow. `upstream-equivalent` needs upstream commit/path evidence and the same behavioral test. `intentional-drop` requires a separate, earlier maintainer-reviewed baseline change and can never be inferred by a sync.
- The preservation report binds base, dev, vendor, and published-head SHAs; candidate blobs and decisions; the full registry hash; the decision hash; and report hash. A later push makes the PR marker stale.
- The existing required `mergeable` job executes the verifier from a detached checkout of the PR's base SHA, against the PR worktree, with read-only permissions and no secrets.
- `autonomous-sync` requires a conflict-free merge, no handoff or agent resolution, exact ancestry/provenance, and zero candidates. Resolved preservation/equivalence judgments remain human-reviewed drafts.

No auto `checkout --ours/--theirs` for code conflicts; only the named `package.json` recipe may auto-resolve. All other conflicts abort the merge and require decision-handoff with preservation evidence.
