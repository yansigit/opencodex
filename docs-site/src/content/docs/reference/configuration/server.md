---
title: Server and Runtime Configuration
description: Listener, remote access, admission keys, timeouts, storage, sidecars, shadow calls, and startup behavior.
---

Server settings control how the local proxy listens, protects remote traffic, manages resources, and
runs helper features around provider requests.

## Server fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Proxy listen port. |
| `hostname?` | `string` | `"127.0.0.1"` | Bind address. Non-loopback binds require TLS and a data-plane credential. |
| `tls?` | `{ certFile: string; keyFile: string; publicOrigin: string }` | — | Serve HTTPS with the supplied readable certificate and private-key files. `publicOrigin` must be the exact HTTPS origin (for example `https://proxy.example.com`) used for generated callback and client URLs; paths, credentials, queries, and fragments are rejected. |
| `proxy?` | `string` | — | Outbound HTTP(S) proxy URL, `${ENV_VAR}`, or `"auto"`. Applied to `HTTP_PROXY` / `HTTPS_PROXY` only when those variables are unset; loopback remains in `NO_PROXY`. `"auto"` reads the Windows system proxy (WinINET `ProxyEnable`/`ProxyServer`, `https=` then `http=` entry) once at process start and logs the host it chose. On other platforms, or when the system proxy is off, SOCKS-only, or unreadable, it uses direct egress and says so. PAC/WPAD and live proxy changes are not followed; restart the service after changing the system proxy. |
| `noProxy?` | `string \| string[]` | — | Hosts that bypass `proxy`, merged with inherited `NO_PROXY` and loopback entries. A string may use comma-separated `NO_PROXY` syntax or `${ENV_VAR}`. |
| `emptyCompletionRetry?` | `boolean` | `false` | Opt in to one identical Responses retry when a turn has no text or tool call, including a stream that ends before a terminal event. The retry may be billable. `OCX_EMPTY_COMPLETION_RETRY=0` disables it without changing config; combo and routed-compaction turns remain excluded. |
| `stallTimeoutSec?` | `number` | `300` | Seconds without upstream data before `response.incomplete`. Minimum 1. |
| `oauthOpenBrowser?` | `boolean` | `true` | Whether a login may open a browser on the machine running the proxy. Absent and `true` both open, so an existing install is unchanged; only an explicit `false` declines. Decline when you need the authorization link in a different browser profile, or when the dashboard is not on the proxy's machine — the login still starts and the URL is still returned and displayed. `POST /api/oauth/login` and `POST /api/codex-auth/login` accept a per-request `openBrowser` boolean that overrides this, and the dashboard exposes the same choice beside the login button. Device-code flows never open a browser either way. |
| `connectTimeoutMs?` | `number` | `200000` | Per-attempt DNS/TCP/TLS/final-header deadline; it ends before body generation. |
| `shutdownTimeoutMs?` | `number` | `5000` | Graceful drain deadline before active turns are aborted. |
| `websockets?` | `boolean` | `false` | Advertise and admit the client-facing Responses WebSocket path. False keeps clients on HTTP/SSE; it does not disable an eligible canonical ChatGPT upstream WS optimization. Complete-input requests may reuse an upstream connection within the same selected credential, account, thread and turn; changed handshake policy or missing identity keeps requests on separate connections. This does not trim HTTP input or create previous-response IDs. |
| `corsAllowOrigins?` | `string[]` | `[]` | Additional exact origins allowed by CORS. Loopback origins are always allowed. Authority-based browser extension origins such as `chrome-extension://<extension-id>` are supported; `*` is not a wildcard. Firefox and Safari regenerate the extension UUID (per install / per browser launch), so update the entry when the origin changes. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Generated `ocx_…` data-plane credentials accepted on non-loopback binds. Dashboard-managed; management routes require the separate admin token. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | Opt-in archived-session cleanup policy. Never enabled implicitly. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Cap in MiB for evictable app-owned logs, caches, blobs, and continuation payloads. Range 64–4096; not an RSS cap. |
| `codexAutoStart?` | `boolean` | `true` | Let the Codex shim run `ocx ensure` before launching Codex. False makes ensure a no-op. |
| `codexShimAutoRestore?` | `boolean` | `true` | Restore an installed shim after a completed external Codex update replaces it. Environment opt-out: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `codexDesktopAuthless?` | `boolean` | `false` | Opt-in authless Codex Desktop routing on a loopback bind: inject the dedicated `opencodex` provider with `requires_openai_auth = false` so Desktop opens without a ChatGPT login. Ignored on non-loopback binds. `ocx system settings --desktop-authless on`. See [Codex integration](/guides/codex-integration/#authless-codex-desktop-opt-in). |
| `resetCreditAutoRedeem?` | `{ enabled?: boolean; leadTimeMinutes?: number }` | off | Opt-in: redeem the main Codex account's soonest-expiring reset credit `leadTimeMinutes` (1–60, default 10) before it expires. Every attempt re-reads the upstream credit list first and skips when the credit is gone (for example, redeemed by hand); the `redeem_request_id` is journaled in `$OPENCODEX_HOME/reset-credit-auto-redeem.json` before the call so a crash replays the same idempotent request instead of spending a second credit. Logs carry a hashed account key only. |
| `syncResumeHistory?` | `boolean` | `true` | Reversible Codex App history compatibility. Original metadata is backed up and restored by `ocx stop` / `ocx restore`. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | Redirect recognized Codex helper/shadow calls to a chosen model while preserving the request's configured reasoning effort. The default source prefix is `gpt-5.6-luna`; older clients through 0.144.x used `gpt-5.4-mini`, which `sourceModels` can restore. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on when usable | Web-search sidecar options. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on when usable | Image-description sidecar options. |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Standalone Images relay options for Codex `image_gen`. |

`noProxy` accepts either a comma-separated string or an array. Both forms add entries without
replacing an inherited `NO_PROXY`:

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": "internal.example,10.0.0.0/8" }
```

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": ["internal.example", "10.0.0.0/8"] }
```

If an older development build changed resume-history metadata before backup support existed, run
`ocx recover-history --legacy-openai --yes` to force native-provider recovery.
It force-relabels every user-message `opencodex` row, including legitimate dedicated-provider
history; review the full-scope warning in the lifecycle reference before running it.

## Codex quota network diagnostics

The main Codex account row may include `quotaRefresh` when a quota fetch was
attempted. This describes that fetch, not remaining quota, model access or
permission to retry. Cached reads and rows without a fetch may omit it; absence
does not mean success. A `null` quota value means unavailable, not zero quota.

To request fresh data and display only the diagnostic in PowerShell:

```powershell
$quotaReport = ocx account list openai --quota --refresh --json | ConvertFrom-Json
$quotaReport.accounts |
    ForEach-Object { if ($_.quotaRefresh) { $_.quotaRefresh } } |
    ConvertTo-Json -Depth 3
```

If no diagnostic is present, this projection produces no diagnostic object. Share
only these fields when comparing network modes, rather than the full account list.

| `quotaRefresh.status` | Meaning |
| --- | --- |
| `ok` | The fetch completed and a quota object was parsed. |
| `not_reported` | The response contained no usable quota object. |
| `http_error` | The upstream returned an HTTP failure; `httpStatus` contains its status code. |
| `timeout` | The quota fetch timed out. |
| `network_error` | The request failed before a classified HTTP response. |
| `invalid_response` | The response was not a usable quota document. |
| `internal_error` | An internal refresh step failed. |

Only `http_error` includes `httpStatus`. Other statuses do not imply HTTP 0 or an
account entitlement problem.

### Which proxy path is used?

The running proxy service fetches quota. It uses its own environment, not the
interactive shell that later runs `ocx account list`. Configure the service's
proxy setting or environment, then restart it; changing variables in another
terminal does not update an already running service.

An unset `proxy` leaves inherited proxy variables unchanged. An explicit HTTP(S)
proxy URL fills `HTTP_PROXY` and `HTTPS_PROXY` only where they are unset.
`"proxy": "auto"` reads the Windows static WinINET proxy once at startup; existing
proxy environment variables take precedence. Auto discovery does not resolve
PAC/WPAD, SOCKS-only settings or live proxy changes. Use a supported static HTTP
proxy setting or an explicit HTTP(S) proxy URL when needed.

Compare the diagnostic on the same machine and account under the two network
modes. A successful TUN test alone does not identify why the service's HTTP proxy
path failed, and does not establish a general fix.

## Remote access

The default `127.0.0.1` bind is loopback-only. A non-loopback address such as `0.0.0.0` requires
native TLS and a data-plane credential. A remote dashboard also needs the separate admin token
(`OPENCODEX_ADMIN_AUTH_TOKEN`, or the generated admin-token file); `apiKeys` do not grant management
access. Configure the listener and export the data-plane token before starting:

```jsonc
{
  "hostname": "0.0.0.0",
  "tls": {
    "certFile": "/etc/opencodex/server.crt",
    "keyFile": "/etc/opencodex/server.key",
    "publicOrigin": "https://proxy.example.com"
  }
}
```

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

The proxy refuses a remote bind when either requirement is missing. Certificate and listener changes
take effect after restart; certificate trust and renewal remain the operator's responsibility. For a
background service, export the token before `ocx service install` so launchd, systemd, or Task
Scheduler receives it. SSH port forwarding to the loopback listener is the plaintext-free alternative.
Data-plane clients should send:

```text
x-opencodex-api-key: your-secret-token
```

| Endpoint | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | not accepted | **required** | not accepted |
| `/v1/chat/completions` | not accepted | **required** | not accepted |
| `/v1/messages` | accepted | accepted | accepted |
| `/v1/messages/count_tokens` | accepted | accepted | accepted |
| `/v1/models` | accepted | accepted | accepted |

Responses and Chat Completions reserve `Authorization` for possible Codex Direct passthrough, so only
the dedicated admission header is accepted there. Dashboard-generated `apiKeys` may replace the
environment token after startup; candidates are compared in constant time.

Messages and `count_tokens` keep accepting all three admission forms for routed-client compatibility. Native
Anthropic passthrough is stricter on a non-loopback bind: proxy admission must use
`x-opencodex-api-key`, while `Authorization` and `x-api-key` are reserved for Anthropic credentials.
Any proxy admission secret placed in those provider headers is removed before forwarding.

:::caution[LAN exposure]
A `0.0.0.0` bind exposes the proxy and configured provider access to the LAN. Use it only on trusted
networks with a strong token.
:::

### Local clients that cannot receive the token

A remote bind requires a credential from every caller, including local ones. That breaks a specific
case: a `codex app-server` launched by a host process that resolves the Codex entrypoint directly
(`require.resolve('@openai/codex/bin/codex.js')`) never passes through the generated `codex` shim,
so it never inherits `OPENCODEX_API_AUTH_TOKEN` and every model call fails with `401` before a
stream opens.

`unauthenticatedLoopbackListener` opens a second listener bound to `127.0.0.1` that admits without a
credential. The main listener is untouched — remote callers still need the token.

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

`ocx sync` then writes `base_url = "http://127.0.0.1:10200/v1"` into the managed Codex provider block
and omits the auth header, so a directly spawned app-server works without any credential plumbing.

The port is required and must differ from the proxy port. It is never OS-assigned: an ephemeral port
would change across restarts while already-running app-servers kept the previous `base_url`.

The listener serves only `POST /v1/responses`, its WebSocket upgrade, `POST /v1/responses/compact`,
`POST /v1/alpha/search` (the native Codex web-search relay), `GET /v1/models`, `POST /v1/messages`,
`POST /v1/messages/count_tokens`, and the realtime voice surface: standalone WebSocket upgrades,
WebRTC call creation (`POST /v1/live`, `POST /v1/realtime/calls`), and keyed sideband join upgrades
(`/v1/live/{callId}`, `/v1/realtime/calls/{callId}`, `/v1/realtime?call_id=`). The two Messages routes
support local Claude Code clients speaking the Anthropic protocol. Everything else, including `/api/*`
and the dashboard, returns `404`.

:::danger[This is an unauthenticated surface]
Every process on the machine can use this listener. It spends account quota and paid provider
credentials, and it can exhaust the shared turn capacity that authenticated remote clients depend
on. Do not enable it on a shared or multi-tenant host.

Binding to `127.0.0.1` means the kernel refuses remote connections, but it does not stop a browser:
a page you visit can make your browser connect to `127.0.0.1`. The listener therefore applies the
same `Host` and `Origin` checks as an ordinary loopback bind. Off by default.
:::

### Troubleshooting: invalid peer certificate UnknownIssuer

If Codex shows `invalid peer certificate: UnknownIssuer`, the Codex client has not trusted the proxy certificate. A self-signed certificate is not trusted until its CA is installed on the Codex machine.

- For a private network, select **Loopback + SSH** in the dashboard, save, restart the proxy, and use SSH forwarding. This avoids certificate trust setup.
- For a direct remote bind, select **Remote TLS** and use a certificate whose CA is trusted on the Codex machine. Its SAN must include the hostname or IP used in `tls.publicOrigin`.

The server-mode selector updates the saved listener configuration. Listener changes take effect after restarting the proxy.

### SSH port forwarding

Remote use does not require a remote bind. Keep OpenCodex on loopback, then run this temporary
tunnel on the computer where you want to open the dashboard:

```bash
ssh -N -L 127.0.0.1:20100:127.0.0.1:10100 user@10.0.0.51
```

Keep that terminal open, then visit `http://127.0.0.1:20100/#dashboard`. Use HTTP at the forwarded
address: SSH encrypts the connection between the two computers. Replace the SSH user and host, and
choose another local port if `20100` is occupied.

Requests whose Host resolves to `localhost`, `127.0.0.1`, or `::1` remain loopback regardless of
port, so `http://127.0.0.1:20100/v1` also works as a client base URL. `ocx` writes only the default
local `127.0.0.1` address into managed client config.

Provider OAuth callbacks listen on a fixed remote port. Log in on the remote machine or forward that
port too:

```bash
ssh -N -L 127.0.0.1:20100:127.0.0.1:10100 -L 127.0.0.1:1455:127.0.0.1:1455 user@10.0.0.51
```

If a registered callback port is already in use and the login surface offers manual input, OpenCodex
keeps the registered redirect URI and still returns the provider authorization URL. Complete the
provider login, then paste the final redirect URL from the browser address bar or the authorization
code into OpenCodex. The pending flow preserves state and PKCE validation. Callers without manual
input still fail closed.

:::caution[Forwarded loopback is unauthenticated]
Always bind the forwarded port explicitly to `127.0.0.1`. Do not use `ssh -g`, broad container
publishing, or forwarding modes that expose the client side on `0.0.0.0`; doing so can make the
unauthenticated loopback dashboard and provider access reachable by other machines.
:::

### Persistent macOS SSH tunnel

A per-user LaunchAgent can keep the same tunnel running after login. The dashboard cannot install
this for you; create it on the Mac where you open the dashboard.

First create a dedicated SSH key, verify the server's host-key fingerprint, and authorize the public
key on the OpenCodex host. The first two SSH connections may request the remote account password:

```bash
ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/opencodex-dashboard" -C "opencodex dashboard tunnel"
ssh user@10.0.0.51 true
cat "$HOME/.ssh/opencodex-dashboard.pub" | ssh user@10.0.0.51 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
ssh -i "$HOME/.ssh/opencodex-dashboard" -o BatchMode=yes user@10.0.0.51 true
```

Only continue when the final command exits successfully without a password prompt. Create the log
directory, then save the following as
`~/Library/LaunchAgents/me.opencodex.dashboard-tunnel.plist`. Replace `example`, the SSH user, and host
value; LaunchAgent paths must be absolute, so do not put `$HOME` or `~` in the plist.

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/OpenCodex"
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>me.opencodex.dashboard-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-T</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-i</string><string>/Users/example/.ssh/opencodex-dashboard</string>
    <string>-L</string><string>127.0.0.1:20100:127.0.0.1:10100</string>
    <string>user@10.0.0.51</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/example/Library/Logs/OpenCodex/dashboard-tunnel.log</string>
  <key>StandardErrorPath</key><string>/Users/example/Library/Logs/OpenCodex/dashboard-tunnel.error.log</string>
</dict>
</plist>
```

Validate and load it, then verify both the agent and tunnel:

```bash
plutil -lint "$HOME/Library/LaunchAgents/me.opencodex.dashboard-tunnel.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/me.opencodex.dashboard-tunnel.plist"
launchctl print "gui/$(id -u)/me.opencodex.dashboard-tunnel"
curl -fsS http://127.0.0.1:20100/healthz
open http://127.0.0.1:20100/#dashboard
```

Inspect failures in `~/Library/Logs/OpenCodex/dashboard-tunnel.error.log`. After editing the plist,
unload and reload it; `kickstart -k` restarts the already-loaded agent without rereading the plist:

```bash
tail -f "$HOME/Library/Logs/OpenCodex/dashboard-tunnel.error.log"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/me.opencodex.dashboard-tunnel.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/me.opencodex.dashboard-tunnel.plist"
launchctl kickstart -k "gui/$(id -u)/me.opencodex.dashboard-tunnel"
```

## Storage cleanup

`storageCleanupPolicy` is disabled by default. When enabled, it runs on `startup`, `daily`, `weekly`,
or `manual` after archived bytes exceed `trigger.archivedBytesOver`. It selects oldest archives toward
either `target.reduceToBytes` or `target.removeOldestPercent`. `mode` defaults to `quarantine`; use
`permanent` only as an explicit destructive choice. The policy persists `lastRun` and `nextRun`.
Configure it on the Storage page or with `GET`/`PUT /api/storage/cleanup-policy`; trigger a manual run
with `POST /api/storage/cleanup-policy/run`.

## Quota-reset notifications (`quotaResetNotify`)

Off by default. When the section is absent, no detection runs, no timer starts, and no state
file is written.

Enable it to be told when a usage window resets — both the scheduled rollover you can predict
and an out-of-band reset you cannot:

```json
{
  "quotaResetNotify": {
    "enabled": true,
    "webhookUrl": "https://hooks.slack.com/services/...",
    "kinds": ["scheduled", "surprise"],
    "pollSeconds": 900
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Also requires at least one sink, below. |
| `kinds` | both | `scheduled` (the deadline passed) or `surprise` (quota returned early). |
| `pollSeconds` | `900` | Idle poll interval; floor 600. `0` observes live traffic only. |
| `webhookUrl` | — | `https` POST target for the event JSON. Treated as a secret. |
| `allowPrivateNetwork` | `false` | Permit a loopback or private-network webhook target. |
| `timeoutMs` | `5000` | Webhook timeout. |
| `command` | — | Argv array run with the event JSON on stdin. |

`enabled: true` with neither `webhookUrl` nor `command` resolves to off: an enabled subsystem
with nowhere to deliver is a misconfiguration, not a half-on state.

The floor is 600 seconds because a faster poll cannot see anything new: observation is bounded
by the 10-minute per-account cache, so a shorter interval only adds load to a quota endpoint
that rate-limits. A configured value is adopted on the next tick without a restart.

Set `pollSeconds` to `0` only if you accept that a reset happening while the proxy is idle is
noticed on the next request rather than when it happens. The poll exists because the overnight
case is the one worth knowing about.

### The delivered event

```json
{
  "type": "quota_reset",
  "kind": "surprise",
  "scope": "codex",
  "accountTag": "k3f9x2ab",
  "window": "weekly",
  "percentBefore": 96,
  "percentAfter": 4,
  "previousResetAt": 1772000000000,
  "resetAt": 1772400000000,
  "detectedAt": 1771900000000
}
```

`accountTag` is a per-install salted hash, not an account identifier: it distinguishes your
accounts from each other without telling the receiver who they are. No email, token, path, or
URL is ever included.

`detectedAt` is when the proxy NOTICED, not when the reset happened. Observation is bounded by
the 5-minute provider cache and the 10-minute per-account cache, so the reset instant can only
be bracketed between two observations.

### Security notes

`webhookUrl` is a credential — for Slack and Discord, holding the URL is sufficient to post —
so it is redacted by `ocx config show` and excluded from `ocx config export`.

A webhook target that resolves to a private or loopback address is refused unless you set
`allowPrivateNetwork: true`. The proxy can reach hosts your browser cannot, including cloud
metadata endpoints, so the default assumes an external receiver.

`webhookUrl` must use `https`. The payload and the URL itself are both sensitive, and an
`http` target would put them in cleartext; an `http` value is rejected when the config is
written rather than downgraded silently.

A redirect is refused rather than followed. The destination check above validates the URL you
configured, so following a `3xx` would deliver the payload somewhere unvalidated — a public
endpoint could bounce the POST to loopback or a metadata address. Configure the final URL
directly; a redirected delivery reports `blocked-destination`.

`command` is an argv array and is never passed through a shell, so its values cannot become a
shell-injection surface. Delivery is attempted once; there is no retry.

Read recent detections with `ocx provider resets` or `GET /api/quota-resets`.

## Claude Code (`claudeCode`)

These settings govern `/v1/messages`, `/v1/messages/count_tokens`, the `ocx claude` launcher, and the Claude dashboard page.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Native-passthrough body inactivity budget in seconds while a read is pending, not total duration. Minimum 1; exactly `0` disables. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Cumulative native-passthrough body cap for streamed and buffered responses. Exactly `0` disables. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | How launch handles `ANTHROPIC_AUTH_TOKEN`. Auto detects auth each launch; an explicit value is never overridden. |
| `claudeCode.authModeMigratedAt?` | `string` | unset | Internal one-time upgrade marker. Do not set manually. |
| `claudeCode.classifierModel?` | `string` | unset | Explicit target for Claude Code Auto Mode classifier turns, as a qualified `provider/model` (for example `RelayA/claude-opus-5`). Auto Mode sends bare safety checks such as `claude-opus-5` with no provider, so without this they fall through to `defaultProvider` — which may not speak Anthropic at all. Nothing is inferred automatically: only a target you declare here is used. |
| `claudeCode.classifierFallbacks?` | `string[]` | unset | Ordered classifier targets used when `classifierModel` is not set. Same qualified `provider/model` form; the first usable entry wins. An explicit `modelMap` entry for the classifier model still outranks both. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | Effort written to generated `~/.claude/agents/ocx-*.md`; separate from Codex guidance and proxy caps. Restart through `ocx claude` to regenerate. |
| `claudeCode.compatibility?` | `"shadow" \| "enforce"` | `enforce` | Compatibility gate for routed Claude ingress: `enforce` rejects unsupported requests before upstream activity with `400 invalid_request_error`; `shadow` records ordinary incompatibilities without rejecting, but signed-thinking ownership and other safety invariants still fail closed. |

Auto auth selects subscription when stored Claude auth is found, proxy when none is found, and
subscription with a warning when detection is inconclusive. See
[Claude Code auth mode](/guides/claude-code/#auth-mode).

When `unauthenticatedLoopbackListener.enabled` is explicitly `true`, its Claude compatibility
surface admits exactly `POST /v1/messages` and `POST /v1/messages/count_tokens` (POST only).
No other Claude path is admitted there; the listener is off by default, its `port` is required,
and that port must differ from the proxy port. Public-listener authentication is unchanged by
the secondary listener. See
[Local clients that cannot receive the token](#local-clients-that-cannot-receive-the-token).

### Claude directive trust and token benchmark

Generated `~/.claude/agents/ocx-*.md` definitions carry signed route and optional effort
directives. OpenCodex verifies a present signature before provider dispatch; a malformed or
invalid signature fails closed with `400 invalid_request_error`. A definition with no signature
may use compatibility fallback only when its directive exactly matches an active OpenCodex-owned
roster entry; arbitrary unsigned text is ignored. Diagnostics never show key material.

To compare routed token estimates with authoritative Anthropic counts, run
`bun run benchmark:claude-tokens -- --provider <provider> --model <model> --confirm-live-provider-charges [--json]`
deliberately. The confirmation flag is explicit consent: confirmed runs send real requests and
may incur provider charges, so do not automate or run them unattended. The benchmark uses a
deterministic sanitized fixture set, sends fixtures sequentially without retries or fallback,
and emits only a non-persistent allowlist of fixture ids/digests, states, metrics, provider kind,
and model id (never request bodies, credentials, or account identifiers). A fixture passes when
its absolute error is within `max(32 tokens, 20%)`; the weighted aggregate must remain within
10%. Routed `/v1/messages/count_tokens` remains a local approximation for routed models; only
native Anthropic requests with an `sk-ant-` credential pass through to Anthropic.

## Shadow calls

Codex uses small helper models for tasks such as titles and commit messages. Enable
`shadowCallIntercept` to redirect recognized source-model prefixes to another configured model. The
replacement keeps the request's configured reasoning effort. Set `sourceModels` only when a client
uses different helper ids.
Interception is model-based: every request whose bare model id matches `sourceModels` can be
redirected, including normal `request_kind: "turn"` requests. `x-codex-turn-metadata` does not exempt
a matching request.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## Sidecars

### `images` (`OcxImagesConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider?` | `string` | automatic OpenAI selection | Explicit custom API-key `openai-responses` provider for `/v1/images/generations` and `/v1/images/edits`. Registry-managed ids are rejected. |
| `timeoutMs?` | `number` | `300000` | Whole-request timeout for one standalone Images request. |

Explicit selection fails closed when the provider is missing, disabled, incompatible, or lacks a
usable key; it never falls back to another paid upstream. The endpoint must implement the OpenAI
Images API paths and response shape expected by Codex.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Master switch. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | Explicit wins; unset always resolves to `openai`. `anthropic` and `xai` run only when explicitly configured; `gemini` and `exa` remain reserved until their executors ship. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` for OpenAI, `claude-sonnet-5` for Anthropic, or `grok-4.6` for xAI. Legacy explicit `gpt-5.4-mini` migrates on start. |
| `exaApiKey?` | `string` | none | Operator key for the `exa` backend. Write-only: management reads never return the stored value. |
| `xSearch?` | `object` | omitted | xAI-only opt-in for hosted `x_search`: `enabled`, mutually exclusive `allowedXHandles` / `excludedXHandles` arrays (maximum 20), and ISO `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Sidecar effort. `minimal` is rejected with web search. |
| `maxSearchesPerTurn?` | `number` | `3` | Real searches allowed per main-model turn. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Config-file-only routed-model raw-body inactivity deadline. Integer 1–2147483647; every non-empty chunk resets it. |
| `timeoutMs?` | `number` | `60000` | Deadline for one hosted search. |

The OpenAI backend requires a ChatGPT login and enabled ChatGPT `forward` provider. Claude-inbound
routed replays inject main ChatGPT auth into the internal request. The Anthropic backend uses the
active stored credential from an enabled Anthropic OAuth provider. An explicitly selected Anthropic
backend with no usable account fails closed instead of falling back. The Anthropic executor uses its
native `web_search_20250305` tool. The xAI backend requires a usable stored Grok OAuth account, uses
hosted `web_search`, and adds hosted `x_search` when `xSearch.enabled` is true. Malformed `xSearch`
management input returns `400`; a malformed persisted block fails closed during planning. The
`gemini` and `exa` lanes never activate from credential discovery or fallback; the operator must
select them explicitly. `exaApiKey` is accepted on writes but omitted from management responses.

Four clocks govern search: base `stallTimeoutSec`, `connectTimeoutMs`, routed-model inactivity, and
hosted-search timeout. The effective bridge watchdog is the maximum plus 30 seconds. Routed stall is
an inactivity guard, not a total generation deadline.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Master image-description switch. |
| `backend?` | `"openai" \| "anthropic"` | auto | Explicit wins; unset prefers a usable stored Anthropic OAuth credential, else `openai`. |
| `model?` | `string` | backend-dependent | `gpt-5.4-mini` for OpenAI or `claude-sonnet-5` for Anthropic. |
| `maxDescriptionsPerTurn?` | `number` | `8` | New description cache misses admitted per main turn. `0` disables calls; invalid values use default. |
| `timeoutMs?` | `number` | `45000` | Sidecar fetch timeout. Integer 1–2147483647. |

Vision activates only for images sent to a model in its provider's `noVisionModels`. OpenAI has the
same login/forward requirements as search; explicitly selected Anthropic fails closed without a usable
credential. Successful `data:` descriptions use a bounded cache keyed by backend, model, detail,
image bytes, and normalized message context. Hits and same-turn duplicates do not consume the limit.
Remote `https:` images and failed or empty descriptions are not cached.

Anthropic OAuth sidecars reuse opencodex's existing Claude Code OAuth fingerprint. Soak-test the
intended account and workload.

## Remote Hub keys and defaults

`runtimeRole` defaults to `standalone`. A hub uses `hub.managementPublicOrigin`, loopback-only `hub.managementIngress` (`enabled:false` when absent), and exact `remoteGui.allowedTailscaleUsers` (empty when absent). A client data key lives in `service-api-token`, never `config.json`; rotation may temporarily create `service-api-token.prev`. Usage stores are not mirrored.

| Key | Type | Default when absent | What it does |
| --- | --- | --- | --- |
| `hub.managementPublicOrigin` | string | unset | The canonical browser-reachable management origin a hub advertises, for example the HTTPS origin Tailscale Serve prints. It is what `/readyz` reports as `managementUrl` while `runtimeRole` is `hub`; with it unset the hub falls back to whatever origin each request arrived on, so a client behind a different frontend can be handed an address it cannot reach. |
| `hub.managementIngress` | `{enabled:false}` or `{enabled:true, port}` | `{enabled:false}` | An extra management-only listener for a local HTTPS frontend. The hostname is not configurable: when enabled the socket always binds `127.0.0.1`, and only GUI, session-bootstrap, and management API routes are admitted. Data-plane routes are rejected before dispatch. |
| `remoteGui.allowedTailscaleUsers` | string[] | `[]` (empty — nobody) | Exact Tailscale login identities allowed to be issued an automatic remote GUI session. The `Tailscale-User-Login` header is trusted **only** on the separate management ingress; an empty list means no remote identity can mint a session, which is the safe default rather than an oversight. Identities are compared exactly, so a typo silently denies access. |
| `remoteGui.allowInsecureHttp` | boolean | unset | **Retired — has no effect.** It once permitted a one-time pairing exchange over non-loopback plaintext HTTP. A pairing grant now crosses loopback or authenticated HTTPS only. The key is still parsed so an existing `config.json` keeps loading (the schema is strict, and dropping the key outright would make an older config fail to load entirely); a persisted `true` is reported once and then ignored. Remove it from your config. |

A hub that is reachable from a browser needs `hub.managementPublicOrigin` and at least one entry
in `remoteGui.allowedTailscaleUsers`. Setting the origin without the user list produces a hub that
advertises itself correctly and then refuses every session; setting the user list without the
origin produces sessions pointed at whichever origin the request happened to use.
