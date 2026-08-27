# Google AI Studio Web Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a stable, low-profile Google AI Studio (Web) provider that relays coding-agent prompts through the user's existing AI Studio / Pro browser session without a separate API key path.

**Architecture:** Reuse the existing `google` adapter with a new `ai-studio-web` mode (browser relay + SAPISIDHASH fallback), a lightweight in-process relay hub (`aistudio-ws-hub`), session-bundle import (`aistudio-session-sync`), MakerSuite chunk parser, and extension/daemon helpers. Thin shims over existing config/routing/pacing; no new server compile step.

**Tech Stack:** Bun-native TypeScript, existing `src/adapters/google`, `src/oauth/*`, `src/server/*`, `src/providers/registry`, Bun tests.

**Spec:** docs/superpowers/specs/aistudio-web-provider-spec.md

## Global Constraints
- Bun-native only; no Node-only APIs, no new compile step.
- Must stay off core path: no imports from `src/lab/` in router/lifecycle/responses core.
- Request pacing required for browser-backed session: default 8 RPM, 7500ms interval, 1500ms jitter (registry defaults).
- Keep diff minimal: reuse existing `google` adapter and `google-aistudio-auth` SAPISIDHASH helpers; no new dependencies.
- Security: no token/body logging; cookie handling must reject CR/LF injection.
- TDD: every production change has a failing test first.

---

### Task 1: Session Bundle Sync & CLI Login

**Files:**
- Modify: `src/oauth/aistudio-session-sync.ts`
- Modify: `src/oauth/login-cli.ts`
- Test: `tests/aistudio-session-sync.test.ts`
- Test: `tests/aistudio-login-cli.test.ts`

**Interfaces:**
- Consumes: existing `src/oauth/google-aistudio-auth.ts` helpers (SAPISID parse), `src/config.ts` load/save
- Produces: `serializeSessionBundle(data)->string`, `parseSessionBundle(token)->AiStudioSessionData`, `saveAiStudioSession(data,dest)->string`, `saveAiStudioSessionFromToken(token,dest)->string`, `loadAiStudioSession(path)->AiStudioSessionData|null`, `cookieHeaderFromSession(session)->string`, `getAiStudioSessionPath()->string`

- [ ] Step 1: Write failing test in `tests/aistudio-session-sync.test.ts` for invalid base64 / missing cookies rejection and for cookieHeaderFromSession joining.
- [ ] Step 2: Run test verify fail
- [ ] Step 3: Implement minimal session sync (base64 JSON bundle, schema validation, file read/write under ~/.opencodex/aistudio-session.json, cookie header builder)
- [ ] Step 4: Write failing test in `tests/aistudio-login-cli.test.ts` for registry entry `google-aistudio` label/googleMode/note and `serialize/parse` round-trip
- [ ] Step 5: Implement/verify `login-cli.ts` handleAiStudioBridgeLogin paste-token path (prompt, decode via saveAiStudioSessionFromToken, print success) and registry note contains /aistudio/bridge
- [ ] Step 6: Verify tests pass
- [ ] Step 7: Commit

### Task 2: MakerSuite Parser & Adapter Stream Hardening

**Files:**
- Create: `src/adapters/google-aistudio-parser.ts`
- Modify: `src/adapters/google.ts`
- Test: `tests/aistudio-login-flow.test.ts`
- Test: `tests/google-aistudio-stream.test.ts`

**Interfaces:**
- Consumes: `parseMakerSuiteChunk(raw:string)->MakerSuiteParsedResult {text, thought?, thoughtSignature?}`
- Produces: adapter `parseStream` branch for `ai-studio-web` yielding text_delta+done on non-SSE MakerSuite residual; `parseResponse` collects via parseStream

- [ ] Step 1: Write failing test for `parseMakerSuiteChunk` extracting `[null,"text"]`, `[true,"thought"]`, and ErQ signature
- [ ] Step 2: Run fail
- [ ] Step 3: Implement minimal parser (regex for [null,".."], [true,".."], sig regex, JSON-unescaped decode)
- [ ] Step 4: Write failing test for `google.ts` ai-studio-web parseStream handling non-SSE residual via parseMakerSuiteChunk (text_delta then done, else error)
- [ ] Step 5: Wire parseStream + parseResponse branches for ai-studio-web (reuse cloud-code-assist SSE collect pattern)
- [ ] Step 6: Verify
- [ ] Step 7: Commit

### Task 3: Relay Hub & Browser Bridge + Extension

**Files:**
- Modify: `src/server/aistudio-ws-hub.ts`
- Modify: `src/server/index.ts`
- Modify: `integrations/aistudio-extension/manifest.json`
- Modify: `integrations/aistudio-extension/popup.js`
- Modify: `integrations/aistudio-extension/popup.html`
- Test: `tests/aistudio-ws-hub.test.ts`
- Test: `tests/aistudio-bridge-endpoint.test.ts`
- Test: `tests/aistudio-extension.test.ts`

**Interfaces:**
- Consumes: hub `register/unregister`, `dispatchRequest`, bridge HTML/WS routes
- Produces: `/aistudio/bridge` HTML, WS relay, extension harvesting of cookies+selectedProject+windowId into base64 bundle with copy+auto-sync

- [x] Step 1: Write failing test for hub multiplexing (pending map, disconnect fails pending, ignores wrong session)
- [x] Step 2: Implement/register logic, pending promises, broadcast
- [x] Step 3: Write failing test for bridge endpoint HTML and WS upgrade
- [x] Step 4: Wire server index bridge routes
- [x] Step 5: Write failing test for extension manifest V3 permissions and popup harvesting (SAPISID present, localStorage selectedProject, sessionStorage windowId, btoa bundle)
- [x] Step 6: Implement popup.js harvest/copy/auto-sync to http://127.0.0.1:10100/api/aistudio/session
- [x] Step 7: Verify
- [x] Step 8: Commit

### Task 4: Native WebKit Daemon & Hardening / Quota / Discovery

**Files:**
- Modify: `integrations/aistudio-daemon/main.swift`
- Modify: `src/oauth/aistudio-native-daemon.ts`
- Modify: `src/providers/registry.ts` (already has pacing, verify)
- Test: `tests/aistudio-native-webkit.test.ts`
- Test: `tests/google-aistudio-hardening.test.ts`
- Test: `tests/google-aistudio-quota.test.ts`
- Test: `tests/google-aistudio-discovery.test.ts`

**Interfaces:**
- Consumes: registry requestPacing, quota inspection, model discovery over bridge
- Produces: isNativeWebKitSupported, main.swift hardened WebKit (WKWebView config, no browsingData leak), quota reporting for ai-studio-web, live model discovery dispatch over bridge (/v1beta/models parse)

- [ ] Step 1: Write failing test for isNativeWebKitSupported darwin check and main.swift hardened configs (processIsolation, nonPersistent datastore etc)
- [ ] Step 2: Implement/verify swift hardened flags
- [ ] Step 3: Write failing test for quota reporting (rate limits + relay status) and pacing backfill via routedProviderConfig
- [ ] Step 4: Verify registry pacing (8 RPM, 7500ms, 1500ms jitter) and routed backfill
- [ ] Step 5: Write failing test for GET /v1beta/models dispatch over AiStudioHub and parse model list
- [ ] Step 6: Wire quota + discovery shims
- [ ] Step 7: swiftc compiles main.swift
- [ ] Step 8: Verify + commit
