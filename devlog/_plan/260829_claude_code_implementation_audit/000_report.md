# Claude Code implementation audit: OpenCodex parity and external reference landscape

**Snapshot:** 2026-08-29
**OpenCodex commit:** `261b87f30472c0061cbf845259b0e34abb984d08`
**Scope:** Claude Code's Anthropic Messages surface, its bridge into the OpenCodex routing/runtime core, comparison with the Codex harness, and a `gh`-verified survey of related public implementations.
**Method:** GSD-style parallel codebase mapping with three Muse subagents (`opencode-go/muse-spark-1.2-contributor`), followed by primary-agent source verification. External repository metadata, trees, releases, and pinned source snapshots were inspected with GitHub CLI rather than inferred from README search snippets.

## Executive verdict

OpenCodex's Claude Code support is **solid and production-usable**, but it is not yet as protocol-complete or lifecycle-managed as its Codex support.

The distinction is important:

- **Native Anthropic passthrough is excellent.** For an unmapped Claude model and a real Anthropic credential, OpenCodex forwards the Messages request and its end-to-end headers essentially verbatim. This preserves beta negotiation, thinking signatures, prompt-cache markers, and Anthropic billing identity.
- **Mapped/routed Claude requests use a sophisticated but lossy bridge.** They are translated from Anthropic Messages to OpenAI Responses, sent through the mature Codex routing core, then translated back to Anthropic SSE or JSON. This correctly reuses routing, policy, account selection, failover, sidecars, request logging, and bounded translation buffers. It also necessarily loses any Claude feature that the inbound translator does not explicitly understand.
- **Codex remains the first-class harness.** Its wire format is the internal runtime format, so it has direct WebSocket, compaction, continuation, encrypted reasoning, runtime discovery, shim, and version-aware integration. Claude Code gets most runtime behavior by replaying through that core, but its protocol and client lifecycle sit outside it.

My practical grading is therefore:

| Surface | Grade | Meaning |
|---|---:|---|
| Codex harness | A | Native protocol and lifecycle integration; broad conformance and regression depth. |
| Claude native Anthropic passthrough | A- | Very high wire fidelity, good auth isolation, streaming guards, and usage normalization. |
| Claude mapped/routed translation | B | Strong ordinary text/image/function-tool operation, but incomplete preservation of evolving Claude feature pairs. |
| Claude client lifecycle | B- | Good launcher and model discovery, but no Codex-equivalent runtime resolver/version policy or installed-client matrix. |

The most important conclusion is not “rewrite Claude support.” The translate-and-replay architecture is the correct reuse seam. The missing piece is a **wire-aware preservation decision before translation**: Anthropic-shaped targets should receive semantic passthrough, while non-Anthropic targets should receive explicit, tested feature translation or a clear capability rejection.

## Evidence baseline

### Current local environment

- Installed Claude Code: `2.1.201`
- Installed Codex CLI: `0.147.0`
- Bun: `1.3.14`
- Dedicated top-level test files: 28 `claude-*.test.ts`, 113 `codex-*.test.ts`
- Core implementation size:
  - `src/server/responses/core.ts`: 6,622 lines
  - `src/server/claude-messages.ts`: 1,030 lines
  - `src/claude/inbound.ts`: 578 lines
  - `src/claude/outbound.ts`: 939 lines

Focused validation run during this audit:

- Claude/Anthropic-focused tests: **666 passed, 0 failed** across 47 files.
- Selected Codex harness suites: **98 passed, 0 failed** across 5 files.

These results establish that the current intended behavior is stable. The findings below are contract and parity gaps, not evidence that the existing test suite is red.

### Current upstream contract

Anthropic's current [Claude Code gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) is unusually specific:

- `/v1/messages` is required; `/v1/messages/count_tokens` is optional.
- Inference must stream and long silent gaps require forwarded or synthesized pings.
- `anthropic-version` and `anthropic-beta` must be forwarded unchanged to Anthropic-format upstreams.
- `anthropic-*`, `x-claude-code-*`, and body fields are open lists, because new capabilities arrive with Claude Code releases.
- `cache_control` must remain attached to the original system/message block.
- Header/body capability pairs must be preserved together; preserving only one side produces hard 400s.
- The explicit session and subagent headers are `x-claude-code-session-id`, `x-claude-code-agent-id`, and `x-claude-code-parent-agent-id`.
- Model discovery currently accepts IDs containing `claude` or `anthropic` anywhere. The older starts-with-only rule applied before Claude Code 2.1.223.

Anthropic's [thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking) also requires thinking blocks involved in tool and multi-turn workflows to be preserved coherently. This matters even when the next provider is not Anthropic: a bridge must either carry a recoverable representation or explicitly discard the unsupported state.

## Architecture comparison

```text
Codex client
  -> POST/WS /v1/responses
  -> Responses core
  -> route / account / adapter / retry / sidecars
  -> Responses SSE

Claude Code
  -> POST /v1/messages
  -> [unmapped Claude + Anthropic credential]
       -> native Anthropic passthrough
     [mapped/routed model]
       -> Anthropic-to-Responses translation
       -> synthetic internal POST /v1/responses
       -> the same Responses core
       -> Responses-to-Anthropic SSE/JSON translation
```

Key entry points:

- Claude Messages route: [`src/server/index.ts`](../../../src/server/index.ts#L1603)
- Claude token-count route: [`src/server/index.ts`](../../../src/server/index.ts#L1585)
- Codex Responses route: [`src/server/index.ts`](../../../src/server/index.ts#L1534)
- Codex compact route: [`src/server/index.ts`](../../../src/server/index.ts#L1420)
- Codex WebSocket upgrade: [`src/server/index.ts`](../../../src/server/index.ts#L978)
- Claude request orchestration: [`src/server/claude-messages.ts`](../../../src/server/claude-messages.ts#L566)
- Claude inbound translation: [`src/claude/inbound.ts`](../../../src/claude/inbound.ts#L1)
- Claude outbound translation: [`src/claude/outbound.ts`](../../../src/claude/outbound.ts#L1)
- Shared Responses core: [`src/server/responses/core.ts`](../../../src/server/responses/core.ts#L2366)

### Detailed parity matrix

| Dimension | Codex implementation | Claude implementation | Assessment |
|---|---|---|---|
| Wire ownership | Responses is the internal/native request model. | Messages is translated into Responses except on native passthrough. | Fundamental reason Claude has a narrower compatibility edge. |
| Endpoints | HTTP Responses, compact, and WebSocket Responses. | Messages and optional count_tokens. | Correct for the Claude gateway contract; Claude does not need Codex-only endpoints. |
| Routing and failover | Native path through profiles, policy, combos, account pools, adapter overrides, retries, and sidecars. | Inherits the same machinery after translation. | Strong. Earlier claims that Claude bypasses profiles/combos are incorrect. |
| Native provider passthrough | Native OpenAI/Codex forwarding with strict credential and header handling. | Native Anthropic forwarding for eligible requests, with end-to-end headers and caller credential. | Strong and worth preserving. |
| Session continuity | Explicit Codex thread/session headers, continuation owner, `previous_response_id`, prompt-cache affinity, encrypted reasoning replay. | Stable key from `metadata.user_id`, synthetic native `session_id`, and an existing `_reasoningReplayScope`. Does not consume the newer explicit Claude session/agent headers. | Better than “stateless,” but behind current Claude contract. |
| Thinking | Native Responses reasoning items and credential-scoped replay. | Request effort is mapped well; raw assistant `thinking`/`redacted_thinking` blocks are dropped and outbound signatures are synthetic. Adapter-specific thought replay still exists beneath the bridge. | Main semantic fidelity gap. |
| Tools | Functions, custom/namespace tools, hosted tools, image generation, MCP and provider repairs. | Client tools become functions; hosted web search has a good server-tool pair; other Claude server-tool schemas are dropped. | Good Claude Code basics, incomplete modern Messages surface. |
| Prompt caching | Body/header affinity plus backend-specific handling and detailed usage. | Stable `prompt_cache_key` is generated; native Anthropic preserves block markers; translated paths drop per-block `cache_control`. | OpenAI caching works; Anthropic block semantics do not survive translation. |
| Streaming | Mature terminal guards, retries, idle behavior, WebSocket and SSE paths. | Valid Anthropic SSE sequencing, idle pings, tool argument buffering, web-search blocks, usage, stop reasons, 529/error mapping, and bounded buffers. | Strong. “No keepalive” is not a finding. |
| Model discovery | Codex catalog and runtime-aware model integration. | Anthropic ModelInfo response, aliases, context variants, gateway cache pre-write, and Desktop handling. | Strong, though prefix assumptions are now conservative/stale. |
| Runtime lifecycle | Runtime resolver, source precedence, version probing, persisted selection, shim/log guard. | Launches the `claude` found on PATH after proxy bootstrap. | Material operational parity gap. |
| OAuth/account pool | Deep Codex pool with quota scopes, soft avoidance, probe leases, and mid-session rules. | Opt-in Anthropic pool with affinity, quota-aware new-session pick, cooldown, and 429 failover; intentionally omits mid-session quota rotation and probe leases. | Deliberately narrower, not accidentally missing. |

## What is already strong

1. **Translate-and-replay is the right architectural seam.** The Claude layer does not duplicate policy, routing, quota, auth, failover, request logging, or sidecar orchestration. [`handleClaudeMessages`](../../../src/server/claude-messages.ts#L566) builds a valid internal Responses request and invokes the shared core.

2. **Native Anthropic passthrough has the right trust boundary.** [`wantsNativePassthrough`](../../../src/server/claude-messages.ts#L125) requires an Anthropic-shaped model, a real non-admission Anthropic credential, and no alias/model-map claim. The native path strips hop-by-hop and proxy-only headers while preserving future Anthropic and Claude Code headers.

3. **The bridge is not unbounded.** Request copies, SSE framing, tool arguments, and replay are charged to the shared translator budget. Oversized translation buffers become a 413 rather than an unbounded allocation.

4. **Streaming fidelity is good.** The outbound translator emits the expected `message_start`, content blocks/deltas, `message_delta`, and `message_stop`; sends pings; maps terminal errors; and keeps web-search `server_tool_use` separate from client-executed `tool_use`.

5. **Cache and usage accounting have already received serious work.** [`anthropicUsageToOcx`](../../../src/server/claude-messages.ts#L159) normalizes Anthropic's cache-inclusive totals into OpenCodex's canonical usage, and [`anthropicUsage`](../../../src/claude/outbound.ts#L89) performs the inverse without double-counting reads/writes.

6. **Session continuity exists.** [`anthropicToResponsesTranslation`](../../../src/claude/inbound.ts#L523) hashes `metadata.user_id` into a stable `prompt_cache_key`; [`handleClaudeMessages`](../../../src/server/claude-messages.ts#L742) synthesizes a ChatGPT `session_id` for a true per-session key; and [`responses/core.ts`](../../../src/server/responses/core.ts#L2492) creates a reasoning replay scope for Anthropic ingress. This invalidates the simplistic finding that every Claude turn is stateless.

7. **Token counting is implemented.** [`estimateClaudeRequestTokens`](../../../src/server/claude-messages.ts#L923) includes system, messages, tools, images, documents, and tool-result attachments; [`handleClaudeCountTokens`](../../../src/server/claude-messages.ts#L985) uses native Anthropic counting when eligible and otherwise returns the bounded estimate. This is an accuracy tradeoff, not a missing endpoint.

8. **Model aliases and discovery are unusually comprehensive.** The implementation distinguishes readable Claude Code aliases from Desktop-safe hashed aliases, publishes context windows and capabilities, and pre-writes the gateway cache with restrictive file permissions.

## Findings, ordered by priority

### P0 — Routed Anthropic semantics need a wire-aware preservation path

This is the root finding. Today, after native first-party passthrough is ruled out, every mapped request is translated into Responses before the final route/wire is settled:

- [`handleClaudeMessagesWithBudget`](../../../src/server/claude-messages.ts#L646) selects native passthrough or immediately calls `anthropicToResponsesTranslation`.
- The effective target adapter is not settled until later in [`routeModel`](../../../src/server/claude-messages.ts#L681).
- The synthetic request forwards only the OpenAI-oriented `FORWARD_HEADERS` list, which does not include `anthropic-beta`, `anthropic-version`, or `x-claude-code-*` ([`src/adapters/openai-responses.ts`](../../../src/adapters/openai-responses.ts#L35), [`src/server/claude-messages.ts`](../../../src/server/claude-messages.ts#L722)).
- System block arrays are folded to text ([`src/claude/inbound.ts`](../../../src/claude/inbound.ts#L303)).
- Message-level `cache_control` is not represented.
- `context_management` and unrecognized top-level feature fields are not represented.
- Client tool schemas are reduced to function or web-search tools; other server tools are dropped ([`src/claude/inbound.ts`](../../../src/claude/inbound.ts#L394)).

This is acceptable for a non-Anthropic target only when the bridge explicitly implements the feature. It is avoidable loss when the selected target itself speaks Anthropic Messages.

Why it matters under the current protocol:

- Anthropic says `anthropic-beta` and `anthropic-version` are open-list, forward-unchanged headers for an Anthropic-format upstream.
- Context management, structured output/effort, and beta tool fields arrive as header/body pairs. Dropping only one side produces a 400; dropping both disables the feature.
- Prompt-cache markers are positional. Folding block-form `system` into one string both loses the marker and can defeat Claude Code's system attribution behavior.

Recommended minimum design:

1. Resolve the mapped model and effective wire before destructive translation.
2. If the target wire is Anthropic Messages, preserve the original body and open-list Anthropic/Claude headers; rewrite only the model and fields that the target explicitly requires.
3. If the target wire is Responses/chat/Gemini, run the current translator under an explicit compatibility requirement set. Translate known feature pairs together and return a clear unsupported-capability error for hard requirements that cannot be preserved.
4. Keep using the existing routing, logging, auth, failover, and response wrappers. Do not create a second Claude router.

This is the same boundary that OmniRoute calls semantic passthrough and workweave/router calls translation compatibility. It prevents a new field-by-field patch every time Claude Code adds a beta.

### P0 — Preserve recoverable thinking state across the Messages/Responses boundary

The current behavior is deliberately lossy:

- Assistant `thinking` and `redacted_thinking` input blocks are dropped ([`src/claude/inbound.ts`](../../../src/claude/inbound.ts#L359)).
- Outbound thinking ends with a timestamp-based synthetic signature ([`src/claude/outbound.ts`](../../../src/claude/outbound.ts#L298)).

This does **not** mean all provider thought continuity is absent. The Responses core already creates `_reasoningReplayScope`, and adapters such as Gemini can remember signatures by call ID. The problem is narrower: the public Anthropic block returned to Claude Code is not a recoverable representation of the internal Responses reasoning item, so the next tool-result turn cannot faithfully reconstruct that item from the Claude history alone.

Recommended minimum design:

- Reuse the existing credential-scoped reasoning replay/envelope machinery.
- When a Responses reasoning item becomes a Claude thinking block, emit an opaque OpenCodex signature that can recover the internal reasoning item for the same session/credential.
- On the next assistant-history translation, decode only OpenCodex-owned signatures. Reject malformed owned signatures and treat foreign signatures according to the selected target wire; never forward one provider's opaque signature to another provider blindly.
- Preserve native Anthropic thinking blocks byte-for-byte on the semantic-passthrough path.

Good external patterns are CLIProxyAPI's bounded per-session replay cache and claudex's small signed-envelope round trip. The former is operationally mature; the latter is conceptually clean but currently has no detected license and therefore should not be copied.

### P1 — Consume the explicit Claude session and agent headers

OpenCodex currently derives its stable key from `metadata.user_id` and does not consume the documented:

- `x-claude-code-session-id`
- `x-claude-code-agent-id`
- `x-claude-code-parent-agent-id`

The current fallback is effective for known CLI payloads, but the explicit header is now the contract-level identity. Ignoring it has three costs:

- A client that omits or changes `metadata.user_id` loses per-session cache/replay affinity even though it sent the session header.
- Parallel Claude subagents cannot be attributed separately in usage/telemetry.
- The current Desktop system-hash fallback remains intentionally shared and therefore cannot provide true conversation replay scope.

Recommended minimum change: prefer the explicit session header for `prompt_cache_key`, replay scope, and log correlation; fall back to `metadata.user_id`; keep the system/tool cohort hash only as a cache-routing fallback. Record agent IDs as bounded metadata, not as user identity and not as upstream credentials.

CCR's [`responses-session-affinity.ts`](https://github.com/musistudio/claude-code-router/blob/aec22a00cc9f934b8ab793522731cf1c71864d39/packages/core/src/gateway/core-runtime/responses-session-affinity.ts#L26-L87) is a concise reference.

### P1 — Add a release-driven Claude conformance matrix

The bridge handles ordinary Claude Code traffic well, but its supported surface is manually enumerated:

- Functions and web search are translated; newer server tools are dropped.
- Images are mapped; documents become a textual attachment marker ([`src/claude/inbound.ts`](../../../src/claude/inbound.ts#L347)).
- `context_management` is ignored.
- Per-block `cache_control` is ignored on translated routes.
- ModelInfo conservatively reports no citations, code execution, context management, PDF, or batch support ([`src/claude/model-info.ts`](../../../src/claude/model-info.ts#L46)).

This is not all P0 functionality for Claude Code today: many tools Claude Code sends are client-executed function tools and already work. The risk is release drift. Anthropic explicitly warns that new Claude Code releases add body fields and beta values.

The smallest useful matrix is fixture-based and target-wire-aware:

| Fixture | Native Anthropic | Anthropic-compatible route | Responses route | Chat/Gemini route |
|---|---|---|---|---|
| beta/version open-list headers | byte-preserve | byte-preserve | consume/translate | consume/translate |
| system and message cache_control | preserve | preserve | map or declare loss | map or declare loss |
| thinking + tool_result continuation | preserve | preserve | recoverable envelope | provider replay mapping |
| context_management | preserve | preserve | client-side edit or reject | client-side edit or reject |
| strict/deferred/tool-search fields | preserve | preserve | translate or reject | translate or reject |
| document/PDF block | preserve | preserve | native file input or reject | provider-specific mapping or reject |

Spock's compact client-side `context_management` implementation is a useful behavioral reference. Portkey's Messages types cover current advanced tool shapes.

### P2 — Improve token count accuracy only where measurements justify it

The current implementation is valid and better than several surveyed gateways:

- Native Anthropic requests use the real count endpoint.
- Routed requests use a nontrivial estimate that includes tools and attachment-aware image/document accounting.
- Anthropic defines the endpoint as optional and Claude Code has an inference fallback.

The remaining gap is provider-tokenizer accuracy for large or unusual routed requests. OmniRoute's hybrid algorithm is the best reference: compute the local estimate first, call a provider count endpoint when one exists, reject implausible provider results, and fall back to the estimate.

Do not add a tokenizer dependency or a per-provider count implementation without measured drift. First log privacy-safe estimate-versus-reported deltas for providers that return real usage; upgrade only providers that exceed an agreed bound.

### P2 — Bring Claude client lifecycle closer to Codex

Codex has a dedicated runtime resolver with source precedence, version probing, persistence, fallback, and diagnostics ([`src/codex/runtime.ts`](../../../src/codex/runtime.ts#L9)). The Claude launcher starts the `claude` available on PATH ([`src/cli/claude.ts`](../../../src/cli/claude.ts#L325)).

The launcher itself is good: it boots the proxy, sets base URL/auth/model-discovery environment, handles root permission behavior, and writes the discovery cache. What is missing is operational compatibility control:

- no recorded selected Claude binary/version,
- no minimum/maximum known-compatible range,
- no diagnostics when an old client lacks a gateway feature,
- no hermetic installed-Claude smoke matrix in CI.

The audit host's Claude Code is 2.1.201, while the current protocol documentation describes behavior introduced through at least 2.1.248. That does not prove a runtime failure; it proves the launcher cannot currently explain client-version-dependent behavior.

The minimum useful change is version detection plus a warning/diagnostic and a small smoke matrix. A full Claude runtime manager should wait until PATH ambiguity becomes a real support burden.

### P2 — Keep the Anthropic OAuth pool intentionally narrower

[`src/oauth/anthropic-routing.ts`](../../../src/oauth/anthropic-routing.ts#L1) is explicit: the pool is opt-in and supports sticky affinity, quota-aware new-session choice, cooldown, and bounded 429 failover, while deliberately omitting Codex's mid-session quota rotation, soft-avoid ladders, and probe leases because Anthropic OAuth is policy-sensitive.

This is a parity difference, not a defect. External projects such as CLIProxyAPI demonstrate richer credential weighting and rotation, but OpenCodex should not copy those behaviors without an explicit policy decision. Session correctness and consent matter more than symmetric feature counts.

### P3 — Modernize model discovery assumptions

Current tests require every discovered ID to start with `claude` or `anthropic` ([`tests/claude-models-discovery.test.ts`](../../../tests/claude-models-discovery.test.ts#L73)). Current Claude Code accepts either token anywhere in the ID, including provider-prefixed IDs.

This is not breaking current OpenCodex aliases; they intentionally satisfy the stricter rule. It is now safe to expose more readable provider-prefixed IDs if desired, but there is no need to churn stable aliases merely for parity.

## Corrected non-findings

Several plausible findings did not survive source verification and should not drive work:

1. **“Claude count_tokens is missing.” — False.** Native counting plus a routed estimator exists and is tested.
2. **“Claude sessions are single-turn/stateless.” — False.** Stable prompt-cache affinity, native session synthesis, and reasoning replay scope exist. The real gap is not consuming the new explicit Claude session/agent headers and not round-tripping public thinking blocks.
3. **“Claude bypasses profiles and combo failover.” — False.** The translated request enters the same Responses routing core; route policy and combos apply after translation.
4. **“Claude streams have no keepalive.” — False.** The outbound translator emits interval pings and has pre-output/idle protection.
5. **“Web search should set stop_reason=tool_use.” — Not generally.** Hosted `server_tool_use` is executed server-side and is intentionally represented as a completed pair; only client-executed function tools require `tool_use` continuation.
6. **“The bridge has no thought-signature continuity.” — Overstated.** Provider-specific reasoning replay exists underneath it. The actual gap is the lossy public Messages representation.
7. **“The raw request can allocate without a translator budget.” — False.** Request parsing and retained translated copies are charged to the shared budget and overflow as 413.

## GitHub landscape, verified with `gh`

The name “onmiroute” appears to refer to **[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)**. GitHub name search found that as the only substantial exact OmniRoute project in this space.

Snapshot metadata below was obtained with `gh repo view`, `gh api`, `gh release view`, and shallow `gh repo clone` checkouts. Stars are discovery signals, not quality scores.

| Repository | Snapshot | License | Why it matters to OpenCodex | Recommendation |
|---|---|---|---|---|
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 58,038★; `2b8d3a8`; release v3.8.50 on 2026-08-26 | MIT | Broadest Claude-compatible TypeScript gateway; semantic passthrough, beta policy, robust tool repair, heartbeats, hybrid token counting, many provider workarounds. | **Primary TypeScript reference; borrow small modules/tests, not the product architecture.** |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 49,229★; `f0de1d0`; v7.2.145 on 2026-08-28 | MIT | Deep Claude/Codex/Gemini translators, bounded thinking replay, provider token counting, rich account pool and protocol tests. | **Primary protocol/replay reference; port concepts and fixtures from Go.** |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | 36,966★; `aec22a0`; v3.0.22 on 2026-08-24 | MIT | Mature Claude Code control plane with OAuth, model discovery, session affinity, virtual models, hosted web tools, and gateway tests. | **Primary launcher/session/header reference.** |
| [LiteLLM](https://github.com/BerriAI/litellm) | 57,550★; `194a3cc`; v1.98.0 on 2026-08-23 | MIT outside enterprise-restricted areas | Broadest provider conformance matrix; native Anthropic endpoints, count-tokens hierarchy, beta merging, cache controls, thinking repairs, usage normalization. | **Behavioral oracle and fixture source; avoid importing its architecture.** |
| [Portkey gateway](https://github.com/Portkey-AI/gateway) | 12,854★; `669825c`; v1.15.2 on 2026-01-12 | MIT | Clean Messages/count_tokens handlers and current advanced tool types across Anthropic, Bedrock and Vertex. | **Reference for modern tool/body shapes and target recursion.** |
| [workweave/router](https://github.com/workweave/router) | 2,642★; `16b1480`; active 2026-08-29 | Elastic License 2.0 | Explicit ingress translation requirements, route filtering, session pins, cross-model thinking invalidation, semantic observability. | **Strong design reference; do not copy code without license review.** |
| [vexxvakan/claudex](https://github.com/vexxvakan/claudex) | New/small; `336294e`; active 2026-07-20 | No license detected | Very small Bun/TypeScript Messages↔Responses bridge with recoverable reasoning envelope, strict unsupported-field errors, model discovery, and token estimation. | **Excellent idea/test reference; no code reuse until licensed.** |
| [satindergrewal/Spock](https://github.com/satindergrewal/Spock) | New; `8b3063d`; v0.3.0 on 2026-08-24 | MIT | Compact Rust bridge with client-side context-management edits, tool/server-tool flattening, effort mapping, token estimation, OAuth and smoke tests. | **Useful fixture/reference source; maturity is still low.** |
| [smg-project/smg](https://github.com/smg-project/smg) | 489★; `0b79671`; active 2026-08-29 | Apache-2.0 | Rust Anthropic router with streaming/non-streaming separation, MCP/tool tests and prompt-cache context. | Secondary reference for typed protocol separation. |
| [AmazingAng/auth2api](https://github.com/AmazingAng/auth2api) | 572★; `a34c011`; active 2026-07-01 | No license detected | Focused Anthropic→Codex Responses bridge and streamed-response draining. | Useful comparison; weaker than OpenCodex and not reusable without a license. |
| [decolua/9router](https://github.com/decolua/9router) | 26,629★; active 2026-08-29 | MIT | Older JavaScript multi-provider gateway with a similar translator tree. | Prefer OmniRoute's newer TypeScript implementation for reference. |
| [mylxsw/llm-gateway](https://github.com/mylxsw/llm-gateway) | 70★; `6934624`; active 2026-08-29 | No license detected | IR-oriented Anthropic conversion and token counter. | Conceptual only; not sufficiently mature/licensed to lead. |
| [glidea/claude-worker-proxy](https://github.com/glidea/claude-worker-proxy) | 274★; `9ef3a88`; active 2026-07-10 | MIT | Thin Cloudflare Worker bridge. | Too narrow for OpenCodex parity work. |
| [LangQi99/Openai2Anthropic](https://github.com/LangQi99/Openai2Anthropic) | 6★; `37eae31`; active 2026-05-20 | No license detected | Minimal translator that explicitly drops thinking. | Avoid as a fidelity reference. |
| [suparious/claude-code-proxy](https://github.com/suparious/claude-code-proxy) | 4★; `45f4fa5`; active 2026-08-26 | MIT | Small passthrough proxy. | No capability OpenCodex lacks. |

### Deep reference findings

#### 1. OmniRoute: best TypeScript reference for wire-aware Claude compatibility

Pinned snapshot: [`2b8d3a8291094bb03c0d1c9d99d07262c8b896fb`](https://github.com/diegosouzapw/OmniRoute/commit/2b8d3a8291094bb03c0d1c9d99d07262c8b896fb)

Most relevant patterns:

- [Hybrid count_tokens](https://github.com/diegosouzapw/OmniRoute/blob/2b8d3a8291094bb03c0d1c9d99d07262c8b896fb/src/app/api/v1/messages/count_tokens/route.ts#L23-L125): local estimate first, real provider count when supported, plausibility check, fallback on failure.
- [Anthropic beta handling](https://github.com/diegosouzapw/OmniRoute/blob/2b8d3a8291094bb03c0d1c9d99d07262c8b896fb/open-sse/config/anthropicHeaders.ts#L11-L115): explicit beta composition, client values, deduplication, and model gating.
- [Format-aware SSE heartbeat](https://github.com/diegosouzapw/OmniRoute/blob/2b8d3a8291094bb03c0d1c9d99d07262c8b896fb/open-sse/utils/sseHeartbeat.ts#L1-L130): Anthropic ping, Responses in-progress, OpenAI chunk, and strict-client comment behavior.
- Claude→Claude semantic passthrough preserves document blocks, tool chains, cache markers, and unknown content types instead of normalizing valid Messages requests.
- Translator tests cover split tool names, orphan/mismatched tool pairs, invalid IDs, text-encoded tool calls, empty completions, cache-boundary movement, and provider-specific quirks.

What to adopt:

- The semantic-passthrough decision and its tests.
- The hybrid count algorithm if measurement shows OpenCodex's estimator drifting.
- Beta/body-pair and cache-boundary fixtures.

What not to adopt:

- Its full provider registry, UI, compression stack, combo engine, or Claude-client fingerprint/cloaking machinery. OpenCodex already has equivalents or deliberately different policy boundaries.
- A fixed beta allowlist as the generic Anthropic-upstream policy. Anthropic's current gateway contract now says to forward open-list values unchanged. Allowlisting is only appropriate for a destination with a narrower known contract.

#### 2. CLIProxyAPI: best reference for bounded thought replay

Pinned snapshot: [`f0de1d008fe8881dcb7431cf97b147295874c2b2`](https://github.com/router-for-me/CLIProxyAPI/commit/f0de1d008fe8881dcb7431cf97b147295874c2b2)

Most relevant patterns:

- [Bounded Claude thinking replay cache](https://github.com/router-for-me/CLIProxyAPI/blob/f0de1d008fe8881dcb7431cf97b147295874c2b2/internal/cache/claude_thinking_replay_cache.go#L19-L125): TTL, per-session bytes/turns/blocks, global byte cap, generation snapshots and optional shared KV persistence.
- [Byte-for-byte signature survival tests](https://github.com/router-for-me/CLIProxyAPI/blob/f0de1d008fe8881dcb7431cf97b147295874c2b2/internal/runtime/executor/claude_executor_thinking_signature_test.go#L15-L130): base64 padding, quotes, escapes, Unicode, controls, and oversized signatures through request mutation stages.
- Extensive translator trees cover Claude↔Responses, Codex↔Claude, count_tokens, tool-result media, beta/header casing, provider fingerprints, MCP/tool references and session-bound replay.

What to adopt:

- Test vectors and invariants for replay, not the whole cache implementation.
- Apply OpenCodex's existing translator-budget and credential-scope rules to the same invariants.
- Use generation/ownership checks if a replay update can race.

What not to adopt:

- A second global replay cache alongside OpenCodex's existing reasoning replay store.
- The Go executor/plugin structure or aggressive credential rotation policy.

#### 3. Claude Code Router: best reference for gateway UX and session/header affinity

Pinned snapshot: [`aec22a00cc9f934b8ab793522731cf1c71864d39`](https://github.com/musistudio/claude-code-router/commit/aec22a00cc9f934b8ab793522731cf1c71864d39)

Most relevant patterns:

- [Responses session affinity](https://github.com/musistudio/claude-code-router/blob/aec22a00cc9f934b8ab793522731cf1c71864d39/packages/core/src/gateway/core-runtime/responses-session-affinity.ts#L26-L87) prefers Claude session headers, falls back to metadata, and avoids adding unsupported fields to Codex backends.
- [OAuth beta merge regression tests](https://github.com/musistudio/claude-code-router/blob/aec22a00cc9f934b8ab793522731cf1c71864d39/packages/core/test/unit/gateway/gateway-claude-code-oauth.test.mjs#L8-L85) ensure provider auth defaults do not erase client capability negotiation.
- Its gateway HTTP handler supports Messages, count_tokens, and model discovery; its integration tests cover virtual models, hosted web search, thinking, tool-use stop reasons, profile allowlists and request logging.

OpenCodex already has stronger core routing and should not transplant CCR's control plane. The useful references are its session-header precedence, OAuth/header merge tests, and installed-client/model-discovery UX.

#### 4. claudex: the cleanest small translator, with a license caveat

Pinned snapshot: [`336294e340b6c4dd723a73929c21d0c0bed6f4d1`](https://github.com/vexxvakan/claudex/commit/336294e340b6c4dd723a73929c21d0c0bed6f4d1)

Most relevant patterns:

- [Recoverable reasoning signatures](https://github.com/vexxvakan/claudex/blob/336294e340b6c4dd723a73929c21d0c0bed6f4d1/src/translate.ts#L7-L65) encode a Responses reasoning item into an owned envelope, reject foreign/malformed signatures, and distinguish deliberately discarded reasoning.
- [Assistant history recovery](https://github.com/vexxvakan/claudex/blob/336294e340b6c4dd723a73929c21d0c0bed6f4d1/src/translate.ts#L200-L246) turns an owned Claude thinking block back into the original Responses reasoning item before a tool call.
- [Token estimation](https://github.com/vexxvakan/claudex/blob/336294e340b6c4dd723a73929c21d0c0bed6f4d1/src/token-count.ts#L1-L25) clearly labels an `o200k_base` count as preflight estimation rather than billing truth.

Its code is useful precisely because it is small and strict. However, `gh repo view` and the checked-out tree expose no license. Treat it as an algorithm/test oracle only unless the author adds a compatible license.

#### 5. workweave/router: best compatibility-requirement design, not a code donor

Pinned snapshot: [`16b1480edf5d012f544516df514b1b28ee4ea83e`](https://github.com/workweave/router/commit/16b1480edf5d012f544516df514b1b28ee4ea83e)

Its [`TRANSLATION_COMPATIBILITY.md`](https://github.com/workweave/router/blob/16b1480edf5d012f544516df514b1b28ee4ea83e/docs/TRANSLATION_COMPATIBILITY.md) separates quality hints from semantic requirements and supports off/shadow/enforce rollout. It also records session pins and invalidates or strips stale thinking signatures after a cross-model switch.

The idea fits OpenCodex well: determine whether a candidate can preserve the request before selecting it. The Elastic License 2.0 is not a permissive code-reuse license for a gateway product, so use the design and write an independent minimal implementation.

#### 6. Portkey and LiteLLM: broad conformance oracles

Portkey's pinned [`MessagesRequest.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/types/MessagesRequest.ts) includes current tool-search, code-execution, `defer_loading`, `allowed_callers`, and `input_examples` shapes. Its [`messagesCountTokensHandler.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/messagesCountTokensHandler.ts) shows a small provider-dispatch boundary.

LiteLLM's pinned Anthropic endpoint and common-utils trees demonstrate broad production behavior: native/pass-through Messages endpoints, count_tokens, beta merging, prompt-cache detection, adaptive/always-on thinking differences, invalid-thinking recovery, tool-ID normalization, and Anthropic model-list generation. It is best used to derive fixtures and edge cases, not as a dependency or architectural template.

## Recommended OpenCodex adoption plan

### Phase 0 — conformance fixtures before runtime changes

Add a compact fixture matrix covering:

1. Anthropic-compatible target preserves unknown `anthropic-*`, `x-claude-code-*`, beta values and body fields.
2. `cache_control` remains attached to the same system/message/tool block.
3. A thinking → tool_use → tool_result turn reconstructs the correct Responses reasoning item.
4. Session header wins over metadata; metadata remains fallback; agent IDs reach logs without becoming user IDs.
5. Unsupported hard requirements fail clearly instead of disappearing.
6. Provider-switch replay cannot send an opaque signature to the wrong provider identity.

Sources: official gateway protocol, CLIProxyAPI signature fixtures, OmniRoute cache/beta/tool-pair fixtures, CCR session/header fixtures, and Portkey advanced tool shapes.

### Phase 1 — smallest root runtime change

Introduce one pre-translation branch:

1. Resolve inbound alias/model and the effective route wire.
2. Anthropic target: semantic passthrough with model rewrite, existing auth/account selection, request logging, failover, stream guards and usage tap.
3. Non-Anthropic target: current translate-and-replay path, plus a small requirement check for fields that cannot be safely translated.

Do not add a parallel router, provider registry, or generic intermediate representation. The existing Responses core remains authoritative.

### Phase 2 — thinking and session continuity

1. Prefer `x-claude-code-session-id` for prompt cache/replay/log correlation.
2. Feed agent and parent-agent IDs into bounded telemetry fields.
3. Reuse the existing reasoning replay store to produce and consume an OpenCodex-owned Claude signature envelope.
4. Preserve native/Anthropic-compatible signatures byte-for-byte.

### Phase 3 — release compatibility and measured refinements

1. Add `claude --version` detection and diagnostics.
2. Run a small installed-Claude smoke matrix against supported releases.
3. Add hybrid provider token counting only where estimate drift is measured.
4. Expand translated server tools/context management in response to real Claude Code traffic, not merely the full theoretical Anthropic API surface.

## Enhancement architecture: advanced Claude support without a second runtime

The desired end state is a **first-class Claude protocol surface over the existing Responses execution core**. Claude should own its ingress contract, semantic preservation rules, and outbound framing; the mature Responses core should continue to own routing, provider selection, account pools, failover, policy, sidecars, admission, request logging, and cancellation.

```text
Claude Code /v1/messages
          |
          v
Parse once and retain the original body + open-list headers
          |
          v
Resolve alias, route candidate, effective adapter and capabilities
          |
          +-------------------------------+
          |                               |
          v                               v
effective adapter = anthropic       other effective adapter
          |                               |
semantic passthrough                requirements check
          |                               |
preserve Claude semantics           Messages -> Responses
          |                               |
          |                         existing Responses core
          |                               |
          |                         Responses -> Claude SSE
          +---------------+---------------+
                          |
                          v
                  Claude Code client
```

This is not a new generic intermediate representation. It is one early dispatch decision in `src/server/claude-messages.ts`, using the effective adapter that OpenCodex already resolves later in that handler. The translation path remains the default for OpenAI, Google, DeepSeek, local and other non-Anthropic wires.

### The two execution contracts

| Contract | Required behavior | Deliberate boundary |
|---|---|---|
| **Anthropic semantic passthrough** | Preserve body block order, unknown body fields, `cache_control` position, native thinking/redacted-thinking signatures, `anthropic-version`, every `anthropic-*` header, and every `x-claude-code-*` header. Rewrite only model, authentication and provider-required transport fields. | Use only when the settled effective adapter is `anthropic`; do not infer it from a model-name substring. |
| **Responses translation** | Translate known message, image, tool, thinking-effort and usage shapes; use the shared Responses runtime; synthesize Claude SSE deterministically; reject hard requirements that would otherwise be silently erased. | Do not claim exact cache/signature/server-tool semantics on a wire that cannot provide them. Soft losses may be diagnosed; hard contract violations must fail before upstream dispatch. |

### Capability requirements, not provider folklore

The compatibility decision should be driven by a small, pure request analyzer. It should report only features that change correctness, for example:

- native thinking-signature replay;
- positional `cache_control`;
- explicit context-management edits;
- advanced tool descriptors such as deferred tools or tool search;
- server-executed tools or result block types;
- structured-output fields that the chosen adapter cannot translate;
- beta-gated body/header pairs.

Do not start with a large capability ontology. A short set of requirements derived from captured Claude Code traffic is enough. Run it in diagnostic-only mode first, then use it to reject only proven hard incompatibilities. This preserves today's broad routing behavior while removing silent corruption.

### Thinking continuity should reuse `ocxr1`, not invent another store

OpenCodex already has the correct primitive in `src/responses/reasoning-envelope.ts`: the `ocxr1:` envelope carries Anthropic signatures, redacted blocks and hidden thinking text through the Responses `encrypted_content` slot. The Claude ingress should reuse that envelope and the existing `_reasoningReplayScope` ownership checks.

The invariant should be:

1. Native Anthropic-to-Anthropic turns replay native blocks byte-for-byte.
2. Translated turns encode recoverable Claude thinking state in the existing `ocxr1` envelope.
3. OpenCodex decodes only its own envelope prefix.
4. Opaque provider signatures are never forwarded to a different provider identity after fallback or model switching.
5. All replay state remains bounded by the existing translator/replay budgets and credential/session ownership rules.

That removes the current synthetic timestamp-signature weakness without adding a Claude-specific database or cache.

### Session and agent identity

Use current Claude Code headers as the primary identity inputs:

1. `x-claude-code-session-id` becomes the first choice for prompt-cache affinity, reasoning replay scope and conversation correlation.
2. Existing `metadata.user_id` remains the compatibility fallback.
3. The current system-prompt cohort remains only a shared-cache hint, never a user or conversation identity.
4. `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` become bounded, privacy-safe trace fields so subagent activity can be related without collapsing it into the user ID.

Never log raw prompts or turn bodies to gain this observability. Normalize length, hash where persistence is unnecessary, and preserve the existing opt-in debug-ring privacy model.

### Advanced feature roadmap

| Priority | Capability | Minimal implementation | Proof of completion |
|---|---|---|---|
| **P0** | Wire-aware preservation | Move effective-adapter resolution ahead of destructive translation and reuse the current native forwarding guards/logging/failover seams. | A mapped Anthropic route preserves unknown fields, beta/version/session headers, block-level cache markers and native signatures. |
| **P0** | Requirements gate | Detect only known hard incompatibilities before choosing a translated route; return an Anthropic `invalid_request_error` naming the unsupported requirement. | No tested Claude field or block disappears silently. Existing compatible requests route unchanged. |
| **P0** | Thinking/tool-loop continuity | Decode/encode the existing `ocxr1` envelope and scope replay by explicit Claude session plus provider identity. | Multi-turn thinking -> tool_use -> tool_result works on one provider and remains safe across failover. |
| **P1** | Header/session fidelity | Forward the protocol's open header lists on Anthropic targets and ingest session/agent/parent-agent headers on all targets. | Header-forwarding fixtures include unknown future `anthropic-*` and `x-claude-code-*` names, not a frozen allowlist. |
| **P1** | Cache semantics | Preserve positional cache markers on Anthropic targets; on translated targets use existing prompt-cache affinity only when it has equivalent meaning. | Cache read/write usage and placement fixtures match the selected adapter's contract. |
| **P1** | Error and stream fidelity | Preserve retry-relevant status/type/code, pings, cancellation and terminal ordering across native and translated streams. | Chunk-boundary, long-idle, mid-stream error, disconnect and 429/529 tests pass without unbounded buffering. |
| **P1** | Advanced client tools | Add deferred tools, tool search/reference, input examples and known server-tool/result pairs one observed feature at a time. | Each added feature has native-preservation and translated-or-rejected fixtures. |
| **P2** | Context management | Preserve native `context_management`; implement only Claude Code's observed edit operations on translated history. | Long tool sessions compact deterministically and never orphan a tool result or thinking signature. |
| **P2** | Structured output and effort | Map `output_config`, JSON schema and effort only where the target exposes a compatible control; retain existing model-specific effort clamps. | Supported targets receive valid fields; unsupported targets get an explicit compatibility result. |
| **P2** | Client lifecycle diagnostics | Resolve `claude`, record `claude --version`, refresh gateway-model metadata and expose a small `ocx claude doctor`/status report. | Current and supported-previous Claude releases pass launch, discovery and one tool-loop smoke test. |
| **P3** | Token-count refinement | Keep the current estimator; delegate to a native/provider counter only for providers where measured drift materially affects admission. | A corpus reports error bounds by content type and the fallback remains bounded and dependency-free. |

### Recommended delivery slices

Each slice should be independently releasable and should reuse an existing seam before adding a new abstraction.

#### Slice 1 — preserve mapped Anthropic traffic

Expected runtime scope: `src/server/claude-messages.ts`, the existing Anthropic forwarding helper/adapter only if required, and focused tests.

- Add a failing fixture for a mapped model whose settled adapter is `anthropic`.
- Resolve the effective adapter before `anthropicToResponsesTranslation` destroys Anthropic-only structure.
- Send that request through semantic passthrough with the mapped model and selected OpenCodex credential.
- Preserve the protocol's open header lists and original block structure.
- Keep current body-size, redirect, stall, cancellation, logging and usage guards.

Exit gate: the fixture proves `cache_control`, thinking signatures and an unknown future header/body field survive. Existing Claude and selected Responses/Codex suites stay green.

#### Slice 2 — make thinking and sessions durable

Expected runtime scope: `src/server/claude-messages.ts`, `src/claude/inbound.ts`, `src/claude/outbound.ts`, and the already-shared reasoning envelope/replay hooks.

- Prefer explicit session headers over metadata-derived keys.
- Convert replayed Claude thinking blocks to/from `ocxr1`.
- Replace timestamp-like synthetic signatures with recoverable OpenCodex-owned envelopes.
- Bind envelopes to the same provider/session ownership policy already used by Responses reasoning replay.

Exit gate: a real multi-turn Claude Code tool loop survives restart-free replay; switching to an incompatible provider never leaks an opaque foreign signature.

#### Slice 3 — turn silent losses into declared compatibility

Expected scope: one small Claude requirements helper plus ingress and focused fixtures.

- Detect only fields and blocks currently proven to be dropped.
- Preserve them on Anthropic routes, translate them where a tested mapping exists, or reject them explicitly.
- Record the decision in bounded telemetry without request content.
- Add new requirements only when a captured Claude release or an official fixture introduces one.

Exit gate: every supported fixture is classified as preserved, translated or rejected; none is silently ignored.

#### Slice 4 — release hardening and feature expansion

- Test the installed current Claude Code plus at least one supported previous release.
- Smoke discovery, normal streaming, long-idle ping, tool loop, thinking loop, cache control, token count, client cancellation and transient-error retry.
- Add advanced tools and context management in descending order of real traffic frequency.
- Add version diagnostics before building a Claude shim or profile manager; those larger lifecycle features should wait for measured launcher/config failures.

### Solidness gates

A feature is not complete until all applicable gates hold:

- **Protocol:** unknown open-list headers/fields survive on semantic passthrough; event order and terminal state are valid.
- **Correctness:** native semantics are preserved, translated semantics are tested, and unsupported semantics are explicit.
- **Ownership:** signatures, cache affinity and session state cannot cross provider/account/session boundaries accidentally.
- **Resource safety:** request copies, SSE buffers, tool arguments and replay state remain bounded by existing budgets.
- **Privacy:** diagnostics contain feature names, hashes and routing decisions, never prompts, credentials or raw account identifiers.
- **Compatibility:** current Claude Code and the supported previous version pass the smoke matrix.
- **Regression:** the shared Responses/Codex path remains authoritative and its focused/full gates run whenever the shared core is touched.

### Expected result

After Slices 1-3, Claude Code would be advanced in the places that matter most: native fidelity, cross-provider safety, thinking continuity, session/subagent affinity and predictable failures. Slice 4 then adds breadth based on observed traffic. This should move the implementation from a strong compatibility bridge to a first-class harness without importing another gateway or growing a second runtime.

## What not to import

- A second routing or account-pool framework. OpenCodex's core is already stronger and shared by both harnesses.
- OmniRoute's full provider/UI/compression system.
- CLIProxyAPI's Go runtime or a duplicate replay cache.
- CCR's entire control plane.
- LiteLLM as a dependency.
- Unlicensed code from claudex, auth2api, or other no-license repositories.
- Elastic-licensed workweave/router code without explicit legal review.
- Claude fingerprint/cloaking behavior that imitates a first-party client. OpenCodex's current native passthrough and consent/auth boundaries are clearer.

## GitHub CLI audit trail

Representative commands used for this report:

```bash
gh auth status

gh search repos 'claude code proxy router in:name,description,readme' \
  --limit 20 \
  --json fullName,description,stargazersCount,forksCount,updatedAt,url,license

gh search repos 'omniroute in:name' \
  --limit 20 \
  --json fullName,description,stargazersCount,url

gh repo view diegosouzapw/OmniRoute \
  --json nameWithOwner,description,url,licenseInfo,stargazerCount,forkCount,updatedAt,defaultBranchRef,primaryLanguage,isArchived

gh repo view router-for-me/CLIProxyAPI \
  --json nameWithOwner,description,url,licenseInfo,stargazerCount,forkCount,updatedAt,defaultBranchRef,primaryLanguage,isArchived

gh api 'repos/OWNER/REPO/git/trees/BRANCH?recursive=1' --jq '.tree[].path'
gh api repos/OWNER/REPO/commits/SHA --jq '{sha:.sha,date:.commit.committer.date,url:.html_url}'
gh release view --repo OWNER/REPO --json tagName,publishedAt,isPrerelease

gh repo clone diegosouzapw/OmniRoute .tmp/claude-code-audit-repos/omniroute \
  -- --depth=1 --branch release/v3.8.51
gh repo clone router-for-me/CLIProxyAPI .tmp/claude-code-audit-repos/cliproxyapi -- --depth=1
gh repo clone musistudio/claude-code-router .tmp/claude-code-audit-repos/ccr -- --depth=1
gh repo clone BerriAI/litellm .tmp/claude-code-audit-repos/litellm -- --depth=1
gh repo clone Portkey-AI/gateway .tmp/claude-code-audit-repos/portkey-gateway -- --depth=1
gh repo clone workweave/router .tmp/claude-code-audit-repos/workweave-router -- --depth=1
gh repo clone vexxvakan/claudex .tmp/claude-code-audit-repos/claudex -- --depth=1
gh repo clone satindergrewal/Spock .tmp/claude-code-audit-repos/spock -- --depth=1
```

The reference clones are under the repository's ignored `.tmp/` directory and are not part of the report diff.

## Final recommendation

OpenCodex should continue treating the Responses core as the single runtime authority. Claude support does not need a rewrite and does not need Codex-only features copied for symmetry.

The highest-return work is:

1. **Select preserve-vs-translate after resolving the target wire.**
2. **Round-trip thinking through the existing replay machinery.**
3. **Adopt the explicit Claude session/agent headers.**
4. **Gate routing on semantic compatibility and test it against Claude releases.**

For external references, use:

- **OmniRoute** for TypeScript wire preservation, beta/cache/tool edge cases, heartbeats and hybrid token counting.
- **CLIProxyAPI** for bounded replay and signature conformance tests.
- **Claude Code Router** for session/header affinity, OAuth beta merging and gateway UX.
- **Portkey/LiteLLM** as broad protocol-shape and provider-conformance oracles.
- **claudex/Spock** as small conceptual test beds, subject to license and maturity caveats.
- **workweave/router** for the compatibility-requirement model, implemented independently.

That path closes the real Claude gaps without importing another gateway into OpenCodex or duplicating the mature Codex core.

## Addendum — 2026-08-29 M2 pin + reference SHA refresh

### Claude Code versions (gh api repos/anthropics/claude-code)
- Latest stable: **v2.1.251** (2026-08-28T18:19:32Z, target main)
- Previous stable: **v2.1.250** (2026-08-28T00:49:16Z)
- The checked-in compatibility manifest pins **251 + 250**, retains **248 + 247** as the implementation baseline, and retains **2.1.201** as the smoke floor.

### Reference repo SHAs (gh api, 2026-08-29)
- **diegosouzapw/OmniRoute** (canonical): 4febee9415e7f07709a08f3029bfcedab639a570 (main)
- **router-for-me/CLIProxyAPI**: f0de1d008fe8881dcb7431cf97b147295874c2b2 @ 2026-08-28T17:20:46Z
- **musistudio/claude-code-router**: aec22a00cc9f934b8ab793522731cf1c71864d39 @ 2026-08-27T14:41:36Z
- **BerriAI/litellm**: e55dbaf34710783ce263a2d1a3039953c4a05148 (main); stable release v1.98.0
- **Portkey-AI/gateway**: 669825cbe89ee51569918b8f78a9db486fd69dd4 (main); stable release v1.15.2

### SDK + fingerprint
- Development-only `@anthropic-ai/sdk` is exact-pinned to `0.122.0` and representative Messages/tool-search fixtures are type-checked with `import type`.
- The runtime fingerprint remains `0.74.0`, independently locked by characterization tests.
- Production `src/` imports of the SDK, including subpaths, are prohibited by a repository test.

### Implemented harness result
- Routed Claude requests are parsed and routed once through the existing Responses core. The caller-supplied final-route callback runs on initial selection, refresh, recovery, rotation, and combo re-resolution without importing Claude into the core.
- Anthropic final routes clone and preserve the sanitized source body per attempt, including unknown fields, ordering, positional cache markers, documents, thinking blocks, betas, and provider-derived OAuth identity.
- Reasoning replay preserves genuine signatures only for the same serving identity. Malformed or cross-identity continuity returns a clear `400`; OpenCodex/Kiro-owned envelopes are never emitted as genuine Anthropic signatures.
- Official Claude tool-search declarations, `server_tool_use`, result blocks, deferred definitions, loaded references, IDs, failure status, tool choice, JSON, and streaming argument frames map through the existing Responses lifecycle.
- Function, tool-search, and supported web-search completions now produce Anthropic `stop_reason: "tool_use"`.
- Compatibility defaults to `enforce`; `shadow` remains the explicit migration escape hatch. Anthropic-only and unknown semantic fields fail closed on translated targets, while Anthropic routes retain source fidelity.
- Diagnostics update one bounded request row across retries and store only feature codes, adapter, decision, and process-salted HMAC-8 identity tags.

### Evidence-bound remaining gate
- The routed token estimator remains dependency-free and conservative, but this change does **not** claim the plan's empirical `<=5%` undercount bound because no sanitized count-token corpus with observed Claude counts was available locally. Pin observed counts before asserting that threshold; do not fabricate a benchmark or add a tokenizer merely to make the test green.
