# Google AI Studio Web Provider Status & Re-auth Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the 502 HTML parsing error, test credential leaks, false "Connected" GUI status, terminal login bridge popup bug, extension auto-sync CORS failure, and missing dashboard re-authentication for the Google AI Studio (Web) provider.

**Architecture:**
- Stream parser: Early HTML/redirect detection in `src/adapters/google.ts`.
- CLI login: Clean native WebKit window flow without unsolicited bridge browser popups.
- Extension & Bridge: CORS preflight support for `chrome-extension://` origins and decoupled liveness probing.
- Backend Status & Re-auth: Live session/relay flags in `safeConfigDTO`, connectivity testing in `/api/providers/test`, and `POST /api/aistudio/login/native` endpoint.
- GUI Dashboard: Dynamic readiness in `gui/src/provider-workspace/catalog.ts` and re-authentication CTA in ProviderOverview.

**Global Constraints:**
- Bun-native only; no Node-only APIs, no new compile step.
- Optional subsystems stay off core path (`tests/core-lab-boundary.test.ts` must pass).
- Subagent model: `command-code/meta-muse-spark-1.2-contributor` with `fork_turns: "none"`.
- TDD: write failing test before modifying production code.
- Privacy scan: `bun run privacy:scan` must stay green.

---

### Task 1: Upstream HTML Error Handling & Test Isolation

**Files:**
- Modify: `src/adapters/google.ts`
- Modify: `tests/google-aistudio-adapter.test.ts`
- Modify: `tests/google-aistudio-e2e-smoke.test.ts`
- Test: `tests/google-aistudio-stream.test.ts`

- [ ] Step 1: Write failing test in `tests/google-aistudio-stream.test.ts` verifying that an upstream HTML response (e.g. `<!doctype html>...<base href="https://accounts.google.com">...</body>`) yields an error `Google AI Studio session expired — re-authentication required` rather than `upstream non-SSE response: </script>...`.
- [ ] Step 2: Update `src/adapters/google.ts` in `parseStream` to detect if `Content-Type` contains `text/html` or if non-SSE buffer begins with `<!doctype` or contains `accounts.google.com/v3/signin`, yielding the descriptive re-authentication error.
- [ ] Step 3: Fix test isolation in `tests/google-aistudio-adapter.test.ts` and `tests/google-aistudio-e2e-smoke.test.ts` so that all tests pass an isolated temp file path to `saveAiStudioSession` (or set `OPENCODEX_HOME`), ensuring `~/.opencodex/aistudio-session.json` is never modified by tests.
- [ ] Step 4: Run `bun test tests/google-aistudio-stream.test.ts tests/google-aistudio-adapter.test.ts tests/google-aistudio-e2e-smoke.test.ts` and confirm all pass.

---

### Task 2: Terminal Login Cleanup

**Files:**
- Modify: `src/oauth/login-cli.ts`
- Test: `tests/aistudio-login-cli.test.ts`

- [ ] Step 1: Write failing test in `tests/aistudio-login-cli.test.ts` checking that successful native WebKit login or token paste does NOT invoke `openUrl` with the bridge URL.
- [ ] Step 2: In `src/oauth/login-cli.ts`, remove the trailing unconditional `openUrl(bridgeUrl);` in `handleAiStudioBridgeLogin()`, only calling it when Option 3 (browser bridge) is deliberately chosen.
- [ ] Step 3: Run `bun test tests/aistudio-login-cli.test.ts` to verify.

---

### Task 3: Bridge Endpoint & WebSocket Relay Decoupling

**Files:**
- Modify: `src/server/aistudio-ws-hub.ts`
- Modify: `src/server/index.ts`
- Test: `tests/aistudio-bridge-endpoint.test.ts`
- Test: `tests/aistudio-ws-hub.test.ts`

- [ ] Step 1: Write failing test in `tests/aistudio-bridge-endpoint.test.ts` verifying that `/aistudio/bridge` HTML checks status via HTTP `/v1/ws/aistudio/status` instead of connecting to the worker WebSocket hub `/v1/ws/aistudio`.
- [ ] Step 2: Update `getAiStudioBridgeHtml` in `src/server/aistudio-ws-hub.ts` to poll `/v1/ws/aistudio/status` for displaying local proxy connectivity and active relay session count, rather than opening a dummy WebSocket that registers as an inference worker.
- [ ] Step 3: Run `bun test tests/aistudio-bridge-endpoint.test.ts tests/aistudio-ws-hub.test.ts` to verify.

---

### Task 4: Extension Auto-Sync CORS Preflight & Port Configuration

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/auth-cors.ts`
- Modify: `integrations/aistudio-extension/popup.js`
- Test: `tests/aistudio-bridge-endpoint.test.ts`
- Test: `tests/aistudio-extension.test.ts`

- [ ] Step 1: Write failing test in `tests/aistudio-bridge-endpoint.test.ts` for `OPTIONS /api/aistudio/session` with `Origin: chrome-extension://test-extension-id`, expecting HTTP 204 with `Access-Control-Allow-Origin: chrome-extension://test-extension-id`.
- [ ] Step 2: In `src/server/index.ts`, update the `OPTIONS` preflight handler to permit `chrome-extension://` and `https://aistudio.google.com` for `/api/aistudio/session` and return matching CORS headers. Update the `POST /api/aistudio/session` response headers to return matching `Access-Control-Allow-Origin`.
- [ ] Step 3: In `integrations/aistudio-extension/popup.js`, read `proxyPort` from `chrome.storage.local` (defaulting to 10100) before making the auto-sync fetch.
- [ ] Step 4: Run `bun test tests/aistudio-bridge-endpoint.test.ts tests/aistudio-extension.test.ts` to verify.

---

### Task 5: Backend Live Session Status & Re-auth Endpoint

**Files:**
- Modify: `src/server/auth-cors.ts`
- Modify: `src/server/management/provider-routes.ts`
- Modify: `src/server/index.ts`
- Test: `tests/google-aistudio-discovery.test.ts`
- Test: `tests/aistudio-native-webkit.test.ts`

- [ ] Step 1: Write failing test verifying:
  - `safeConfigDTO` returns `hasAiStudioSession: boolean` and `aiStudioRelayActive: boolean` for `google-aistudio`.
  - `POST /api/providers/test?name=google-aistudio` reports real status instead of `static_catalog` unapplicable.
  - `POST /api/aistudio/login/native` endpoint exists and returns status.
- [ ] Step 2: Implement `hasAiStudioSession` and `aiStudioRelayActive` in `safeConfigDTO` (`src/server/auth-cors.ts`).
- [ ] Step 3: Implement `google-aistudio` handling in `/api/providers/test` (`src/server/management/provider-routes.ts`) to check relay/session health.
- [ ] Step 4: Implement `POST /api/aistudio/login/native` in `src/server/index.ts` to launch native login on macOS when requested.
- [ ] Step 5: Run tests to verify backend changes.

---

### Task 6: Dashboard Accurate Status & Re-auth CTA

**Files:**
- Modify: `gui/src/provider-workspace/catalog.ts`
- Modify: `gui/src/components/provider-workspace/ProviderOverview.tsx`
- Modify: `gui/src/components/provider-workspace/ProviderRail.tsx`
- Test: `gui/tests/provider-workspace-catalog.test.ts` (or corresponding GUI test)

- [ ] Step 1: Write failing test in GUI tests for `binProviderStatus`: for `googleMode === "ai-studio-web"`, it should only be "ready" if `hasAiStudioSession || aiStudioRelayActive`; otherwise "needs-setup".
- [ ] Step 2: Update `isConfigurationReady` in `gui/src/provider-workspace/catalog.ts` to require `p.hasAiStudioSession === true || p.aiStudioRelayActive === true`.
- [ ] Step 3: In `ProviderOverview.tsx`, when `item.googleMode === "ai-studio-web"` and it needs setup or re-auth, display a prominent "Re-authenticate" / "Connect" button that calls `/api/aistudio/login/native` or opens the bridge.
- [ ] Step 4: Run `bun run test` on GUI tests and build check `bun run lint:gui` to ensure cleanliness.

