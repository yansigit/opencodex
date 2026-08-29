# Subagent Model Authority and Log Classification Design

## Summary

Make OpenCodex's active Codex model catalog the authority for subagent selection,
remove misleading roster/default wording, and identify main-agent versus spawned
subagent requests in Dashboard Logs.

GSD agents use the OpenCodex preferred subagent model by default. They may omit the
inline model only when the synchronized native default is known to be current. A
GSD-specific model may be used only after the user confirms that exception; there is
no automatic escape from the OpenCodex catalog or silent catalog mutation.

This work has two independently shippable tracks:

- OpenCodex: subagent settings UX and durable request classification.
- GSD upstream: runtime-aware model propagation and user-confirmed exceptions.

## Problems

### Featured order is presented as execution order

`subagentModels` controls the first five model overrides advertised by Codex's
`spawn_agent` tool. Its first element is not the omitted-model default. The dashboard
currently calls `injectionModel` "Model to call first" and describes the featured list
as the candidates from which that first model is chosen. That is false when native
default synchronization is off or pending, guidance is unavailable, or the parent
omits the model.

Making array index zero the default would be unsafe. Account-qualified expansion and
specialist-role saves can change the catalog rows before the advertisement window is
sliced, so an unrelated edit could silently change execution.

### GSD drops its resolved model

GSD's generated Codex adapter says that `spawn_agent` has no inline `model` parameter
and therefore discards `Task(model=...)`. Current Codex V2 supports the parameter.
The adapter also claims that resolved models are embedded in agent TOMLs, but the
installer writes models only for explicit `model_overrides`.

An unrelated project `.planning/config.json` can additionally shadow global
`runtime: "codex"` model settings, causing GSD to resolve Claude aliases such as
`sonnet`. Those aliases are not valid Codex/OpenCodex catalog model ids.

### Request logs do not identify agent origin

OpenCodex already detects genuine spawned children from Codex protocol headers for
effort caps and fallback. That classification is not persisted with request logs, so
the dashboard cannot distinguish main-agent, spawned-subagent, and other Codex
internal traffic after routing or restart.

## Goals

- Preserve separate advertised-roster and preferred/default concepts.
- Make the dashboard wording match the runtime contract.
- Keep OpenCodex's active Codex catalog authoritative for GSD subagent spawns.
- Make ordinary GSD agents pass the OpenCodex preference explicitly, or inherit only
  after native-default synchronization is confirmed current.
- Require explicit user confirmation before a GSD workflow requests a model outside
  the active OpenCodex-advertised choices.
- Persist a privacy-safe request-origin enum and expose it as a dashboard filter.
- Preserve historical logs without fabricating their origin.

## Non-goals

- Treat `subagentModels[0]` as a fallback or default.
- Invent a model-quality score or automatically decide that a model is "powerful
  enough."
- Automatically add a GSD model to the Codex/OpenCodex catalog.
- Persist one-time GSD fallback approval as a permanent preference.
- Store raw Codex headers, agent prompts, role names, or task text in usage logs.
- Add server-side `/api/logs` origin filtering while the dashboard still filters its
  bounded 2,000-row result locally.

## Decisions

### 1. Explicit preference, never positional default

Keep the existing configuration fields:

- `subagentModels`: ordered advertised overrides, maximum five.
- `injectionModel` and `injectionEffort`: preferred delegation model and effort.
- `syncCodexSubagentDefaults`: opt-in application of that preference to Codex's
  omitted-model native defaults.

No config migration is required. The existing injection-model response gains one
additive diagnostic described below.

The Subagents workspace changes as follows:

- Rename "Featured" to "Advertised overrides."
- State that order controls the models shown by `spawn_agent`, not default or fallback
  order.
- Rename "Model to call first" to "Preferred subagent model."
- Add a `Prefer` action and `Preferred` badge to advertised rows, backed by the
  existing `injectionModel` field. Reordering rows never changes that field.
- Rename the native-default toggle to "Use for omitted-model subagents" and state
  that it applies to newly created Codex tasks after sync/restart.
- Render the existing catalog state returned by `GET /api/subagent-models`. When the
  catalog is stale, reuse the existing dashboard Codex-restart control; never restart
  without a user action.
- Extend `GET /api/injection-model` with `nativeDefaultState` (`active`, `disabled`,
  `pending`, or `blocked`). `active` requires matching marker-owned Codex `[agents]`
  values and every running app-server to postdate the relevant `config.toml` write;
  a stopped app-server is safe because its next process will read the file. The
  dashboard must not claim omitted-model behavior from desired config alone.

The preferred model may remain outside the five advertised overrides. Show a warning
in that case, but do not silently insert it or evict another row.

### 2. OpenCodex catalog is GSD's default authority

Use these terms consistently:

- **Synchronized catalog:** every model row known to the running Codex app-server.
  Exact ids in this catalog are executable; the five-model advertisement cap is not
  an eligibility cap. Current Codex accepts an exact full-catalog id even when it is
  outside the five suggestions; if a future runtime rejects that contract, treat the
  unknown-model response as a roster-promotion requirement rather than retrying.
- **Advertised overrides:** the first five eligible rows shown in `spawn_agent`.
  These are the operator's primary GSD choices, not the complete executable catalog.
- **Preferred model:** `injectionModel`, used explicitly by fresh OpenCodex guidance
  and, when enabled and synchronized, by Codex's omitted-model native default.
- **GSD catalog:** GSD's external tier/model recommendation table. Membership there
  does not make a model executable in Codex.

GSD model selection follows this order:

1. When fresh OpenCodex guidance declares a preferred model and that id is advertised,
   pass it explicitly for an ordinary GSD spawn.
2. If no preference is available in guidance, omit `model` only when OpenCodex reports
   that its marker-owned native default matches the configured preference and the
   running app-server catalog is fresh.
3. If neither condition holds, pause with sync/restart guidance instead of inheriting
   Codex's root model.
4. A GSD per-role override or user-owned agent TOML pin inside the advertised overrides
   may be passed explicitly. A user-authored pin counts as persistent authorization,
   but it does not bypass catalog availability checks.
5. If the GSD workflow requests a different GSD-catalog model, pause for user
   confirmation before any catalog change or spawn.

"Not powerful enough" is not inferred by OpenCodex. It means the GSD workflow has
explicitly selected a different tier/model for the role. The confirmation must show:

- the current OpenCodex preferred model;
- the GSD-requested model and role;
- that the exception applies only to this spawn;
- that an unavailable Codex catalog model cannot run until the user separately adds
  and synchronizes it.

When interactive question tooling is unavailable, GSD asks the same question in text
and stops. It must not choose the exception automatically. Approval authorizes the
single spawn, not catalog/config mutation.

After approval:

- If the exact id is already in the synchronized catalog, pass it for this spawn even
  when it is outside the five advertised overrides.
- If it is not in the synchronized catalog, offer a separate explicit action to add it
  to the OpenCodex subagent roster, synchronize the catalog, and restart the affected
  Codex app-server. If all five advertised slots are occupied, the user must select
  which entry to replace; never evict one implicitly. Only retry after that action
  succeeds.
- Declining the catalog change leaves configuration untouched and stops the spawn.

### 3. GSD resolves before it forwards

The GSD upstream change fixes two shared seams rather than patching generated files:

1. Effective configuration keeps global runtime/model defaults underneath project
   overrides. An unrelated project key must not erase `runtime: "codex"`,
   `model_overrides`, `model_profile_overrides`, or model policy.
2. The generated Codex adapter inspects the visible `spawn_agent` schema. When the
   schema supports `model`, it forwards only a nonempty, non-`inherit`, runtime-native
   model selected by the authority order above.

OpenCodex's fresh collaboration guidance supplies the preferred model to the GSD
orchestrator. It also distinguishes an active synchronized default from a desired but
pending/blocked default. Stale/unknown catalog state continues to suppress guidance;
the GSD adapter treats missing authority guidance as a reason to pause, not permission
to inherit the root model.

The adapter must:

- preserve `agent_type`, because it owns the GSD role instructions;
- use `fork_turns: "none"` when forwarding model or effort overrides;
- never translate `sonnet`, `haiku`, or other Claude aliases locally;
- omit only when the schema lacks `model` and the synchronized OpenCodex default is
  confirmed current;
- pause rather than inherit when the preferred/default state is unknown, stale, or
  blocked by a user-owned native default;
- preserve V1 behavior and explicit static TOML pins.

If the user confirms a GSD model that is not installed in the active Codex catalog,
the spawn remains blocked pending the separate add/sync/restart action. Confirmation
cannot make an unknown model executable.

### 4. Durable request-origin classification

Add an optional field to the request-log and usage-log contracts:

```ts
agentKind?: "main" | "subagent" | "internal";
```

Add one shared classifier and keep `isThreadSpawnRequest(headers)` as the boolean
projection of it. Classify once at Responses ingress, before body parsing and routing:

- `subagent`: either exact thread-spawn marker is present. This wins over conflicting
  non-spawn metadata.
- `internal`: any valid nonempty non-spawn marker is present and no thread-spawn
  evidence exists. Known examples include review, compact, and memory consolidation;
  future marker values remain internal rather than being mislabeled main.
- `main`: Responses traffic has no subagent marker in either supported header shape.
- absent: a marker is malformed or contradictory without decisive thread-spawn
  evidence, the row is historical, or the surface cannot be classified.

Raw header values are never persisted. Reuse the classification throughout the
request instead of parsing the same metadata again for fallback and effort policy.

Carry the enum through:

- `RequestLogContext` and `RequestLogEntry`;
- final log construction and append-only `usage.jsonl` normalization;
- startup hydration from persisted usage;
- the management DTO and GUI `LogEntry`.

The Logs page adds an Agent filter with `All`, `Main`, `Subagent`, `Internal`, and
`Unknown`. Missing historical values match only `All` and `Unknown`. Rows and the
detail dialog show a compact localized badge.

## Error and compatibility behavior

- Existing config files and API clients remain valid.
- Historical usage rows remain readable and are shown as Unknown.
- Malformed persisted `agentKind` values are dropped during normalization.
- A stale app-server catalog is visible in the Subagents workspace; it does not cause
  an automatic restart.
- An invalid or unavailable GSD model is never sent speculatively to `spawn_agent`.
- A declined GSD exception offers inheritance only when `nativeDefaultState` is
  `active`, the catalog/process state is fresh, and the user chooses that option;
  otherwise the workflow stops with sync/restart guidance.
- No request payload, credential, account identifier, or raw protocol metadata is
  added to logs.

## Implementation boundaries

### OpenCodex repository

- Subagent workspace copy, preference action/badge, catalog-state notice, and restart
  control reuse.
- Request classification, persistence, hydration, DTO, dashboard badge, and filter.
- User-facing documentation and all dashboard locales.

### GSD upstream repository

- Effective global/project model configuration merge.
- Codex adapter generator's schema-aware model mapping and confirmation contract.
- Generated-artifact snapshots and resolver tests.

Do not patch files under package caches or generated installed skill directories as
the source fix. A local explicit `model_overrides` reinstall remains a temporary
workaround only.

## Testing

### OpenCodex runtime

- Main, spawned-child, and internal markers classify distinctly.
- Conflicting thread-spawn/non-spawn evidence resolves to spawned child; malformed
  non-decisive evidence resolves to Unknown.
- Classification occurs before parse/routing failures are finalized.
- `agentKind` survives JSONL append, normalization, and hydration.
- Unknown or malformed historical fields remain safe and readable.
- Raw headers never appear in persisted rows.
- WebSocket handshake headers survive reconstruction and classify each
  `response.create` row identically to HTTP Responses traffic.

### Dashboard

- Advertised/default copy and preference badge match the stored fields.
- Reordering advertised models does not change `injectionModel`.
- Stale catalog state renders the existing restart control.
- All five Agent filter values select the expected rows.
- Badges render in rows and details with accessible localized labels.
- Run focused GUI tests, i18n lint, GUI build, and privacy scan.

### GSD upstream

- An unrelated project config preserves global Codex runtime/model defaults.
- Project model settings override global settings on explicit conflicts.
- V2 forwards the fresh OpenCodex preferred model with `fork_turns: "none"`.
- Missing/stale/blocked preferred-default state pauses rather than inheriting the root
  model.
- V1 and schemas without `model` inherit only when the synchronized native default is
  confirmed active; otherwise they pause.
- Empty, `inherit`, Claude aliases, and unavailable models are not forwarded.
- A non-advertised GSD request pauses for confirmation.
- Decline, approve-once from the synchronized catalog, separately approve add/sync,
  unavailable-after-approval, and noninteractive text paths are covered.
- Explicit user-owned agent TOML pins remain unchanged.

## Rollout

The OpenCodex UI/logging changes can ship independently. Until the GSD upstream fix
is installed, GSD agents use the OpenCodex native subagent default only after that
default has been synchronized; explicit `model_overrides` remain the only reliable
per-role override.

After the GSD fix, one live check should confirm:

1. an ordinary GSD agent uses the OpenCodex preferred model;
2. an advertised per-role override is forwarded;
3. an out-of-catalog GSD model pauses before any spawn;
4. the resulting requests appear under the correct Agent filter.
