# Implementation Plan — Command Code Prompt Cache Stability

**Goal:** Eliminate Command Code prompt cache misses across multi-turn agent loops by stabilizing all components of the prompt prefix (tool ordering, tool nudges, workspace metadata config, and session affinity).

## Global Constraints
- Bun-native TypeScript in strict mode (`bun run typecheck` must pass).
- No regressions to existing Command Code provider behavior, reasoning efforts, or session collision boundaries.
- No logging of request bodies or sensitive keys (`bun run privacy:scan` must pass).
- TDD required: tests must be written first and observed to fail before implementation.

---

### Task 1: Deterministic Tool Sorting and Catalog Nudge Stability
**Problem:** Codex and dynamic MCP providers can emit tools in varying order between turns. Because `wireTools(tools)` and the `toolNudge` in `params.system` list tools in array order, any change in tool array order mutates both `params.tools` and the beginning of the `system` prompt text, completely busting Gemini/Command Code prompt cache from byte zero.
**Files to change:**
- `tests/command-code-provider.test.ts`
- `src/adapters/command-code.ts`
**Step 1 (RED):** Write a unit test in `tests/command-code-provider.test.ts` with two requests having identical tools in reversed/shuffled order. Assert that `buildRequest` produces identical `params.tools` order and identical `params.system` text. Watch test fail.
**Step 2 (GREEN):** In `src/adapters/command-code.ts`, sort visible tools deterministically by wire name (`namespacedToolName(tool.namespace, tool.name)`) before passing to `wireTools` and `buildNonOpenAIToolCatalogNudgeForTools`.
**Step 3 (VERIFY):** Run `bun test tests/command-code-provider.test.ts` to verify.

---

### Task 2: Robust Session Identity Propagation & Fallback
**Problem:** Command Code uses `x-session-id` for backend worker affinity. When `x-codex-parent-thread-id` is absent (root Codex threads), `parsed._clientThreadId` was left undefined. In `chat-completions.ts`, session headers were never propagated. When no thread identity exists, `commandCodeSessionId` generated a `randomUUID()` every turn, causing a 100% cache miss on all subsequent turns.
**Files to change:**
- `tests/command-code-provider.test.ts`
- `src/adapters/command-code.ts`
- `src/server/responses/core.ts`
- `src/chat/inbound.ts`
- `src/server/chat-completions.ts`
**Step 1 (RED):** In `tests/command-code-provider.test.ts`, test that `commandCodeSessionId` produces stable UUIDs across turns when:
  - `_cursorConversationId` is present.
  - No thread ID exists, but a non-trivial initial conversation exists (conversation root hash fallback).
  - Test that `core.ts` sets `_clientThreadId` from `thread-id` or `session_id` headers when `x-codex-parent-thread-id` is absent.
**Step 2 (GREEN):**
  - In `src/adapters/command-code.ts`: expand `commandCodeSessionId` to recognize `_cursorConversationId` and conversation root fallback.
  - In `src/server/responses/core.ts`: set `parsed._clientThreadId` from `thread-id` or `session_id` if `inboundClientThreadId` is absent.
  - In `src/chat/inbound.ts` and `src/server/chat-completions.ts`: preserve incoming `session-id`, `x-session-id`, and `thread-id` into the internal request.
**Step 3 (VERIFY):** Run `bun test tests/command-code-provider.test.ts` and relevant server tests.

---

### Task 3: Workspace Config Freezing & Deterministic Structure Sorting
**Problem:** `commandCodeConfig` reads directory entries using `opendir`, which returns filesystem-ordered entries. If files are added/renamed, entry order changes. Furthermore, if a session crosses midnight UTC, `new Date().toISOString().slice(0, 10)` rolls over and invalidates the cached prefix.
**Files to change:**
- `tests/command-code-workspace-cache.test.ts`
- `src/adapters/command-code.ts`
**Step 1 (RED):** Write a unit test in `tests/command-code-workspace-cache.test.ts` verifying that `structure` is always sorted alphabetically, and that cached config per session preserves its initial date across midnight.
**Step 2 (GREEN):** In `src/adapters/command-code.ts`:
  - Call `structure.sort()` before returning.
  - Ensure session cache retains the initial date for that session.
**Step 3 (VERIFY):** Run `bun test tests/command-code-workspace-cache.test.ts`.

---

### Task 4: Regression Testing & Full Verification
**Files to change:**
- All affected test suites
**Step 1:** Run `bun test tests/command-code-*.test.ts tests/commandcode-provider.test.ts`.
**Step 2:** Run `bun run typecheck` to verify strict TypeScript typing.
**Step 3:** Run `bun run privacy:scan` to ensure no secrets or PII are leaked.
