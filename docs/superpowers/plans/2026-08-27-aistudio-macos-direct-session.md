# AI Studio macOS Direct Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native macOS login plus direct SAPISID-authenticated HTTP the AI Studio runtime, while retaining Brave only as an optional credential exporter.

**Architecture:** One credential resolver feeds inference and management status. Native login is an awaited macOS process; direct Google adapter requests are the only inference transport. Browser relay code is deleted, with its public routes returning migration-safe `410 Gone` responses for one release.

**Tech Stack:** Bun-native TypeScript, Swift/AppKit/WebKit, React/Vite, Chrome Manifest V3, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-27-aistudio-macos-direct-session-design.md`

## Global Constraints

- macOS is the only supported interactive login and reauthentication platform in this release.
- Direct authenticated HTTP remains platform-neutral for CI and imported sessions.
- No new dependencies, background jobs, polling API, persistent health database, or credential logging.
- Use strict TDD: write each behavior test, run it red for the expected reason, add the minimum implementation, then run it green.
- Preserve Google adapter streaming, buffered responses, tool calls, cancellation, error classification, and private MakerSuite `v1internal` request behavior.
- Brave remains credential-export only; inference relay, active tabs, background workers, and userscripts are deprecated.

---

### Task 1: Shared AI Studio credentials and truthful auth state

**Files:**
- Create: `src/oauth/aistudio-credentials.ts`
- Modify: `src/oauth/google-aistudio-auth.ts`
- Modify: `src/adapters/google.ts`
- Modify: `src/server/auth-cors.ts`
- Modify: `src/server/management/provider-routes.ts`
- Test: `tests/aistudio-credentials.test.ts`
- Test: `tests/google-aistudio-adapter.test.ts`
- Test: `tests/google-aistudio-stream.test.ts`
- Test: `tests/google-aistudio-status.test.ts`

**Interfaces:**
- Produces: `AiStudioCredentialResolution = { kind: "ready"; cookieHeader: string; source: "provider-api-key" | "provider-header" | "session"; fingerprint: string } | { kind: "missing"; reason: string } | { kind: "invalid"; reason: string }`.
- Produces: `resolveAiStudioCredentials(provider, session?)` with priority valid `apiKey`, case-insensitive `Cookie` header, saved session; invalid higher-priority values do not hide a valid lower-priority source.
- Produces: dashboard field `aiStudioAuthState: "connected" | "checking" | "needs_reauth" | "unsupported"`; retain `hasAiStudioSession` for compatibility and remove `aiStudioRelayActive`.

- [ ] Write failing credential tests for each source, priority, case-insensitive header lookup, arbitrary strings, missing `SAPISID`, and control characters; assert fingerprints are stable SHA-256 values without exposing cookie text.
- [ ] Run `bun test tests/aistudio-credentials.test.ts` and confirm failures are caused by the missing resolver.
- [ ] Implement the resolver by reusing session loading and cookie validation; do not add a class or dependency.
- [ ] Run the credential test green.
- [ ] Write failing adapter/status tests proving direct transport ignores an active relay, status never accepts arbitrary `apiKey`, HTML/redirect/401/403 map to reauthentication, and 429/5xx/network failures remain non-auth failures.
- [ ] Run those tests red, remove adapter relay selection, route all credential consumers through the resolver, and add the auth-state DTO.
- [ ] Run the four focused test files green, then `bun run typecheck`.
- [ ] Commit as `refactor(aistudio): centralize direct session credentials`.

### Task 2: Awaited native macOS login and dashboard reauthentication

**Files:**
- Modify: `integrations/aistudio-daemon/main.swift`
- Modify: `src/oauth/aistudio-native-daemon.ts`
- Modify: `src/oauth/login-cli.ts`
- Modify: `src/server/index.ts`
- Modify: `gui/src/components/provider-workspace/ProviderOverview.tsx`
- Modify: `gui/src/provider-workspace/catalog.ts`
- Modify: `gui/src/i18n/*.ts`
- Test: `tests/aistudio-native-webkit.test.ts`
- Test: `tests/aistudio-login-cli.test.ts`
- Test: `tests/google-aistudio-status.test.ts`
- Test: `gui/tests/aistudio-workspace-status.test.tsx`

**Interfaces:**
- Produces: `runAiStudioNativeLogin(options?) => Promise<{ kind: "authenticated"; sessionPath: string } | { kind: "cancelled" } | { kind: "unsupported" } | { kind: "failed"; error: string }>`; the optional dependency injection is test-only process spawning, not a second production implementation.
- Changes: `POST /api/aistudio/login/native` remains open until native completion and session validation, returning success only then; request abort terminates the child.
- Consumes: Task 1 credential resolver and auth-state contract.

- [ ] Write failing native helper, CLI, server, and GUI tests for authenticated, cancelled, unsupported, failed, request-aborted, and deferred-success behavior.
- [ ] Run the four focused test files and confirm expected red failures.
- [ ] Remove Swift headless relay/UI automation; add window-close cancellation and deterministic exit codes `0` authenticated, `2` cancelled, `1` failed.
- [ ] Centralize Swift spawning in `runAiStudioNativeLogin`; make CLI and server await it and reject missing/invalid saved sessions.
- [ ] Remove CLI bridge fallback for short input/non-macOS and return a clear unsupported result.
- [ ] Update the dashboard to render the four auth states, auto-test once while `checking`, await reauthentication, and abort on cancellation without false success.
- [ ] Add every visible string to all locale modules and run `cd gui && bun run lint:i18n`.
- [ ] Run focused tests green, `swiftc integrations/aistudio-daemon/main.swift -o /tmp/opencodex-aistudio-login-check`, `cd gui && bun run lint && bun run build`, and `bun run typecheck`.
- [ ] Commit as `feat(aistudio): await native macos authentication`.

### Task 3: Retire relay runtime and keep Brave extraction-only

**Files:**
- Delete: `src/server/aistudio-ws-hub.ts`
- Modify: `src/server/index.ts`
- Modify: `src/codex/catalog/provider-fetch.ts`
- Modify: `src/providers/quota.ts`
- Delete: `integrations/aistudio-extension/background.js`
- Delete: `integrations/aistudio-extension/content.js`
- Delete: `integrations/aistudio-extension/offscreen.js`
- Delete: `integrations/aistudio-extension/offscreen.html`
- Modify: `integrations/aistudio-extension/manifest.json`
- Modify: `integrations/aistudio-extension/popup.js`
- Modify: `integrations/aistudio-extension/popup.html`
- Modify: `integrations/aistudio-extension/README.md`
- Test: `tests/aistudio-bridge-endpoint.test.ts`
- Test: `tests/aistudio-extension.test.ts`
- Test: `tests/google-aistudio-discovery.test.ts`
- Test: `tests/google-aistudio-quota.test.ts`
- Delete: `tests/aistudio-ws-hub.test.ts`
- Delete: `tests/google-aistudio-relay-adapter.test.ts`

**Interfaces:**
- Changes: `/aistudio/bridge`, `/aistudio/bridge.user.js`, `/v1/ws/aistudio`, `/aistudio/ws`, and `/v1/ws/aistudio/status` return HTTP 410 JSON/HTML migration guidance and never upgrade a WebSocket.
- Changes: extension stores `proxyPort` in `chrome.storage.local`, defaults to `10100`, and uses it only for session auto-sync.
- Changes: AI Studio model discovery remains static (`liveModels: false`); quota reports only existing local pacing/usage without relay state or invented upstream windows.

- [ ] Write failing route tests asserting every legacy route returns 410 and cannot become an active relay.
- [ ] Write failing extension behavior tests with Chrome/fetch stubs for extraction, copy, auto-sync, custom-port persistence, and absence of pinned-tab/relay permissions.
- [ ] Write failing discovery/quota tests proving no relay or public `/v1beta/models` request is used.
- [ ] Run the focused tests red for the expected legacy behaviors.
- [ ] Delete the relay hub and consumers, add the minimal 410 handlers in the composition root, and retain static catalog/pacing behavior.
- [ ] Reduce the extension manifest and popup to extraction/copy/auto-sync; persist a validated port `1..65535`, defaulting to `10100`.
- [ ] Run the four focused tests green and `bun run typecheck`.
- [ ] Commit as `refactor(aistudio): retire browser inference relay`.

### Task 4: Documentation, direct integration coverage, and release verification

**Files:**
- Modify: `docs-site/src/content/docs/reference/adapters.md`
- Modify: directly affected AI Studio provider guides and translations discovered by `rg -l "AI Studio|aistudio" docs-site/src/content/docs`
- Modify: `docs/superpowers/specs/aistudio-web-provider-spec.md` only to mark the newer design as superseding its relay architecture
- Rename: `tests/google-aistudio-e2e-smoke.test.ts` to `tests/google-aistudio-integration.test.ts`
- Modify: `scripts/live-smoke.ts` only if existing scenarios cannot exercise the required direct AI Studio cases
- Test: `tests/google-aistudio-integration.test.ts`

**Interfaces:**
- Documents: native macOS login, direct `v1internal` session transport, extraction-only Brave extension, static models, local-only quota reporting, and 410 relay migration.
- Verifies: text streaming, buffered generation, standard tools plus `function_call_output`, comprehensive/freeform schemas, and subagent-spawn tool traffic all use direct transport.

- [ ] Extend or rewrite the integration test first so relay-backed behavior fails and direct streaming/tool/subagent cases are explicit.
- [ ] Run the integration test red for the removed-relay expectation, then make only the minimum fixture/harness changes needed for direct transport and run it green.
- [ ] Update English and translated docs so none retain active-tab, userscript, offscreen-relay, official API-key fallback, live discovery, or upstream-quota claims.
- [ ] Run `cd docs-site && bun install --frozen-lockfile && bun run build`.
- [ ] Run the focused AI Studio test set, `bun run typecheck`, `bun run test`, `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`, `bun run privacy:scan`, and `bun test tests/core-lab-boundary.test.ts`.
- [ ] On macOS, run `bun scripts/live-smoke.ts --provider google-aistudio --force --json` against the branch-local proxy after native login; record streaming, tool-call round trip, comprehensive/freeform schema, and subagent-spawn results separately. If credentials or provider availability block live verification, report that fact without weakening deterministic gates.
- [ ] Commit as `docs(aistudio): document native direct-session workflow`.
