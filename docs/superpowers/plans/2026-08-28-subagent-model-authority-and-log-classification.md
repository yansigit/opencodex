# Subagent Model Authority and Log Classification Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-28-subagent-model-authority-and-log-classification-design.md`

## Global Constraints

- OpenCodex's synchronized catalog is the execution authority. `subagentModels` stays the ordered five advertised overrides; `injectionModel` remains the independent preference.
- Never infer model quality, mutate the catalog, restart Codex, or approve a GSD exception without an explicit user action.
- Persist only `agentKind`; never persist raw headers, markers, prompts, roles, request bodies, credentials, or account identifiers.
- Reuse existing TOML-marker, app-server freshness, restart, catalog-state, logging, and filter patterns. Add no dependency and no server-side log filtering.
- Follow TDD: record the focused RED and GREEN command/output in each task report.

## Task 1: OpenCodex native-default authority and guidance

Implement and test the OpenCodex runtime/API authority contract.

- Reuse the existing marker-aware Codex TOML analysis to inspect ownership and effective `agents.default_subagent_model` / `agents.default_subagent_reasoning_effort` values without writing the file.
- Compute `nativeDefaultState: "active" | "disabled" | "pending" | "blocked"`:
  - `disabled` when effective sync is off.
  - `blocked` for unreadable, ambiguous, externally owned, or user-conflicting native defaults.
  - `pending` when desired marker-owned values do not match, freshness cannot be proven, or any running app server predates the relevant config write.
  - `active` when marker-owned values match and no running server is stale; no running server is safe.
- Add the field to `GET /api/injection-model` only; keep PUT's response contract unchanged.
- Add the same explicit state to fresh V2 collaboration guidance beside the preferred model. Stale/unknown catalog state continues to suppress positive authority guidance.
- Preserve `isThreadSpawnRequest` behavior and the Lab/core import boundary.
- Cover marker ownership, all four states, process freshness, GET compatibility, and guidance output with focused tests.

## Task 2: OpenCodex request-origin logging

Implement and test durable request classification.

- Add `AgentKind = "main" | "subagent" | "internal"` and a shared header classifier beside the existing spawn detector.
- Exact spawn evidence wins; valid non-spawn markers are internal; no marker on Responses-derived traffic is main; malformed/contradictory non-spawn evidence is absent/Unknown.
- Keep `isThreadSpawnRequest(headers)` as the boolean projection.
- Classify at HTTP and Responses WebSocket ingress before parse/routing failures, then carry the enum through request context, final logs, normalized `usage.jsonl`, hydration, and management DTOs.
- Leave unrelated image/search/live traffic unclassified and never persist raw marker data.
- Cover classifier precedence, early failures, HTTP/WS parity, JSONL normalization/round-trip, invalid historical values, and DTO exposure.

## Task 3: GSD runtime/model authority

Implement and test the source fix in a separate checkout of `open-gsd/gsd-core` based on `next`; never modify installed or cached generated trees.

- Merge global runtime/model defaults beneath project settings. Project values win, explicit `null` clears inherited values, nested model maps merge, and malformed global defaults fail open without discarding valid project config.
- Apply the same merge semantics to installation-time model resolution.
- Update the generated Codex adapter instructions to preserve `agent_type`, use `fork_turns: "none"` with overrides, and never translate or forward Claude aliases.
- Ordinary GSD spawns pass the fresh OpenCodex preferred model only when the exact ID is visible in the current `spawn_agent.model` catalog. Model omission is allowed only when guidance explicitly reports `nativeDefaultState: active`; missing/stale/pending/blocked/legacy authority pauses.
- A different GSD-catalog model requires one-spawn confirmation showing role, preference, requested model, and scope. Decline uses the preference; unavailable interaction stops. An absent catalog ID requires a separate add/sync/restart approval and is never mutated automatically.
- Preserve explicit user-owned TOML pins and V1 compatibility.
- Run focused resolver/installer tests, full tests, generated-sync lint, and lint. Verify generated artifacts under an isolated temporary `HOME`/`CODEX_HOME`.

## Task 4: Dashboard settings, logs, locales, and docs

After Tasks 1 and 2 are integrated, implement and test the GUI as one ownership lane.

- Rename Featured to Advertised overrides, explain ordering, rename the preference and omitted-model toggle, add Prefer actions/Preferred badges, and warn when preference is outside the five advertised rows. Reordering never changes `injectionModel`.
- Display `nativeDefaultState`; only active may claim omitted-model behavior is live. Missing fields from an older proxy fail closed.
- Reuse `/api/subagent-models.catalogState`, the existing stale banner, and restart hook. Refresh after a user-triggered restart; never restart automatically.
- Add local Logs filtering and row/detail badges for All, Main, Subagent, Internal, and Unknown. Unknown matches only missing/invalid historical values. Do not change `/api/logs` query behavior.
- Add every visible string to every GUI locale and update canonical English documentation without contradicting translated docs.
- Run focused GUI tests, i18n lint, GUI lint, and GUI build.

## Task 5: Cross-repository verification and delivery

- Integrate reviewed OpenCodex task commits into this feature branch and keep the GSD work on its separate local branch.
- Run OpenCodex typecheck, full tests, privacy scan, GUI lint, GUI build, and docs build.
- In isolated temporary state, verify preferred explicit spawn, active-default omission, fail-closed pending/blocked state, confirmed exact-catalog GSD exception, unavailable-model stop, and correct dashboard agent classification.
- Perform separate whole-branch reviews plus one cross-repository contract review. Do not publish, install into live GSD, push, or open PRs.
