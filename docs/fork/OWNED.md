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

Upstream and the fork overlay (conflict class) both touch wire protocol, core request paths, or locale catalogs. Serialize merges on these files (never two workers at once).

| Path |
|---|
| `gui/src/i18n/**` |
| `src/adapters/google*.ts` |
| `src/cli/capabilities.ts` |
| `src/codex/inject.ts` |
| `src/config.ts` |
| `src/router.ts` |
| `src/server/auth-cors.ts` |
| `src/server/index.ts` |
| `src/server/management/**` |
| `src/server/responses/**` |
| `src/service.ts` |
| `src/providers/antigravity-quota.ts` |
| `src/providers/key-failover.ts` |
| `src/providers/key-store.ts` |
| `src/providers/quota.ts` (Antigravity quota probe path) |

Keep upstream control flow; re-fit fork behavior. Never “accept all ours” on these files.

The established shared-hotspot defaults are:

- `src/adapters/google-http.ts`: apply account cooldown first, then host
  failover.
- `src/server/responses/core.ts`: try the Antigravity 429 carousel first, then
  recover the opaque blob.
- `gui/src/i18n/**`: preserve the union of upstream and fork English keys in
  every locale. Never resolve a catalog wholesale to either side; the locale
  catalog parity test is the post-merge backstop.

### `upstream-owned` — default take theirs

Everything not listed above. Re-apply fork intent as a **new small commit** only if still needed after taking upstream.

### `recipe` — resolve with a named merge recipe

| Path | Recipe |
|---|---|
| `package.json` | Take every non-release field from upstream, preserve fork `name` as `@yansigit/opencodex` and choose the higher valid SemVer (never decrease); preserve fork-owned scripts `test:container` and `check:hygiene`, keep the `prepush` `check:hygiene` prefix, and keep the pinned devDependency `@anthropic-ai/sdk` while taking all other upstream metadata |

## Conflict defaults

| Class | Default | Notes |
|---|---|---|
| `upstream-owned` | Take theirs | Re-apply fork intent as a new small commit only if still needed |
| `fork-owned` | Take ours | Files only the fork added |
| `shared-hotspot` | Manual / agent report | Keep upstream control flow; re-fit fork behavior; never “accept all ours” |
| `recipe` | Run the named recipe | `package.json` keeps fork identity and a non-decreasing version, preserves fork-owned scripts `test:container`/`check:hygiene`, the `prepush` hygiene prefix, and the pinned `@anthropic-ai/sdk` while taking upstream metadata |
| Lockfiles | Take theirs | Regenerate if the fork added deps |
| File deleted by them, edited by us | Decide restore vs abandon | Record in merge message |
| Rename | Follow new path | `--find-renames`; do not keep a zombie old path |
| Upstream shipped the same idea | Drop ours | Duplicate patches cause later impossible conflicts |
| Refactor of a patched function | Port behavior | New `fork:` commit on the new shape; forget the old diff |

Never `git merge -X ours` across the tree.
