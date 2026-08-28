# Subagent Driver Overwrite, Multi-Candidate Failover, and Stability Implementation Plan

## Global Constraints

- Work on branch `codex/subagent-driver-candidates-failover`.
- Bun-native TypeScript only; keep `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts` free of direct or transitive `src/lab/` imports.
- Follow strict TDD: write failing tests first, watch them fail for the expected reason, write minimal code to pass, and verify green.
- Follow Ponytail (level: full): minimal working diffs, reuse existing helpers, no unnecessary abstractions.
- Preserve request logging privacy: never log prompts, request bodies, credentials, or API keys.
- Preserve backward compatibility with existing `subagentModelFallbackByModel`, `subagentModelFallback`, and `subagentRoles`.

---

## Task 1: Configuration Schema for Subagent Candidates

Add the `subagentCandidates` configuration field to config types and schema.

- In `src/types/config.ts`, add `subagentCandidates?: string[] | Record<string, string[]>;` to `OcxConfig`.
- In `src/config.ts`, define schema:
  - Supports string array: `z.array(z.string().trim().min(1)).min(1)`.
  - Supports string record of string arrays: `z.record(z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1))`.
  - Union of both, optional, with graceful degradation on malformed hand-edits (`.catch(undefined)`).
- Add helper `resolveSubagentCandidates(config: OcxConfig, roleOrModel?: string): string[]` to normalize candidate arrays.
- Add focused unit tests in `tests/subagent-candidates-config.test.ts` verifying array, record, degradation, and resolution.

Focused verification:
```bash
bun test tests/subagent-candidates-config.test.ts
bun run typecheck
```

---

## Task 2: Subagent Model Overwrite & Multi-Candidate Selection

Implement driver model overwrite and candidate failover in `src/codex/subagent-model-fallback.ts`.

- Update candidate resolution: when `subagentCandidates` is present, use the configured candidates as the primary selection order. The subagent's requested model (e.g. `gpt-5.6-luna`) does not override the user's candidate preference.
- Broaden failure classification in `noteSubagentModelFailure`:
  - Accept network errors, 5xx server errors, timeouts, and stream disconnects (`stream closed before response.completed`), placing the failed candidate in a 60s cooldown.
- In `src/server/responses/core.ts`, call `recordSubagentFailureForThreadSpawn` on stream disconnects and 5xx errors so failed candidates are immediately cooled down for subsequent retries.
- Add focused tests in `tests/subagent-candidates-overwrite.test.ts` covering:
  - Overwriting requested `gpt-5.6-luna` with candidate array.
  - Role-specific candidate resolution (e.g., `coder` -> Flash).
  - Automatic hop to Candidate 2 when Candidate 1 is in cooldown after failure.

Focused verification:
```bash
bun test tests/subagent-candidates-overwrite.test.ts tests/subagent-model-fallback.test.ts
bun run typecheck
```

---

## Task 3: Effort & Parameter Auto-Sanitization for Effortless Models

Prevent Codex router 400 errors when subagents route to models like Composer 2.5 that do not support reasoning effort ladders.

- In `src/server/effort-policy.ts` / `src/server/responses/core.ts`:
  - Check if the routed model supports reasoning effort (via `supportedLadderFor`).
  - If the model has an empty effort ladder (e.g. `cursor/composer-2.5`), strip `reasoning` from `parsed.options` and `parsed._rawBody`.
- Add focused tests in `tests/subagent-effort-sanitization.test.ts` verifying that requests with `reasoning: { effort: "high" }` routed to Composer 2.5 have effort sanitized without triggering rejection.

Focused verification:
```bash
bun test tests/subagent-effort-sanitization.test.ts tests/effort-policy.test.ts
bun run typecheck
```

---

## Task 4: Subagent Code-Mode & Role Guidance

Improve subagent stability through targeted prompt guidance in `src/server/responses/collaboration.ts`.

- In `multiAgentGuidanceText`:
  - When `collabSurface(parsed) === "v2"`, append guidance:
    - Advise orchestrator to omit `agent_type` or use `worker` when specifying model overrides to avoid client-side model locks.
    - Inject code-mode isolate guidance: clarify that `exec` has no `require('fs')`, and demonstrate proper template literal escaping for `apply_patch` calls.
- Add unit tests in `tests/subagent-code-mode-guidance.test.ts` asserting that the guidance appears in rendered v2 multi-agent guidance text.

Focused verification:
```bash
bun test tests/subagent-code-mode-guidance.test.ts tests/collaboration-mode.test.ts
bun run typecheck
```

---

## Task 5: Live Verification & Full Regression Suite

Verify end-to-end functionality including live inference smoke tests.

- Run full test suite: `bun run test`.
- Verify core-lab boundary: `bun test tests/core-lab-boundary.test.ts`.
- Run typecheck: `bun run typecheck`.
- Run privacy scan: `bun run privacy:scan`.
- Execute live inference check through OpenCodex proxy on port 10100 testing candidate selection and response completion.
