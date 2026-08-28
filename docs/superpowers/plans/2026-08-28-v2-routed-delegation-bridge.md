# Experimental V2 Routed Delegation Bridge

## Goal

Add a default-off V2 experiment that exposes plaintext mirror collaboration tools to an eligible native ChatGPT root. OpenCodex rewrites mirror calls back to native collaboration calls with `encrypted_function_args: []`, allowing Codex to manage real V2 agents while routed children receive readable tasks without an extra recovery request.

## Public interface

- Config: `v2RoutedDelegationBridge?: boolean`.
- `GET /api/v2`: returns `v2RoutedDelegationBridge: false` by default.
- `PUT /api/v2`: accepts a boolean and validates the complete request before persistence.
- Missing or malformed persisted values disable only this experiment.

## Runtime behavior

- Activate only for a canonical ChatGPT, unambiguous V2 root after native-parent override routing.
- Exclude disabled, routed, V1, ordinary, child/helper, combo, compaction, malformed-surface, and shadow-intercepted requests.
- Keep native `collaboration.*` tools unchanged.
- Inject only `ocx_agents.spawn_agent`, `ocx_agents.send_message`, and `ocx_agents.followup_task`, preserving native parameter schemas and adding routed-child usage guidance.
- Support top-level `tools` and `input[].additional_tools`, update parsed and raw bodies together, and make injection idempotent.
- Reject a pre-existing conflicting `ocx_agents` namespace.
- Rewrite allowlisted mirror calls to native collaboration calls with `encrypted_function_args: []` across JSON, SSE, and canonical upstream WebSocket delivery.
- Normalize before response-state caching and replay inspection; never rewrite genuine native or unknown calls.
- Parent override takes precedence. Recovery remains unchanged.

## Dashboard and docs

- Add an accessible experimental switch near existing V2 settings.
- Re-read server state after writes and avoid optimistic active state on failures.
- Explain armed/inactive behavior, provider privacy/cost/context implications, model-directed tool selection, and the native-child-to-routed-grandchild limitation.
- Update all locale modules and the subagent, dashboard, configuration/API, and architecture documentation.

## TDD tasks

1. Config schema and management API.
2. Pure request injection and response normalization.
3. Runtime, streaming, WebSocket, replay, and cache integration.
4. Dashboard, localization, and documentation.

Each task records a failing behavioral test before production code, focused GREEN evidence, two independent review verdicts, and fixes. Tasks 2 and 4 may run concurrently in separate worktrees after task 1.

## Verification

- Permanent tests cover configuration, dashboard behavior, injection, idempotence, collisions, eligibility exclusions, JSON/SSE/WebSocket normalization, replay, native-call preservation, recovery/compaction ordering, and a deterministic parent/child lifecycle.
- Run full backend typecheck/tests/privacy scan, GUI tests/lints/build, and docs build.
- Run one bounded live session in isolated temporary homes with native `gpt-5.6-terra` and routed `opencode-go/mimo-v2.5`: spawn one child, read a sentinel via a real tool, wait, follow up, wait, list agents, and verify exact markers with no recovery request.
- Do not retry live inference automatically or log secrets, request bodies, headers, account identifiers, or repository contents.

## Intentional limits

- Root-only bridge; a native child delegating to a routed grandchild can still cross the encrypted boundary.
- No model selector, CLI command, dependency, routing framework, nested-child rewrite, or automatic fallback.
- Push and PR creation require separate authorization.
