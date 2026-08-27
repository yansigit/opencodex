# Google AI Studio Web: macOS Direct-Session Design

## Status

Approved on 2026-08-27. This design supersedes the browser-relay runtime in
`aistudio-web-provider-spec.md` for Google AI Studio Web authentication and
inference.

## Goal

Make Google AI Studio Web a macOS-only provider for now, using native WebKit to
capture or refresh the user's Google session and direct authenticated HTTP for
all inference. Retain the Brave/Chrome extension only as a temporary credential
extraction and auto-sync workaround for Chromium-bound passkeys.

Windows and Linux authentication are future work. This design adds no dormant
cross-platform implementation.

## Architecture

The provider has one inference transport:

```text
Native WKWebView login/refresh OR Brave credential export
                         |
                         v
             validated 0600 session file
                         |
                         v
       direct SAPISIDHASH HTTP inference and probe
```

Native WebKit authenticates and harvests cookies. It does not automate the AI
Studio prompt editor, click the Run button, intercept XHR, or register as a
WebSocket relay.

The Brave extension may read Chromium cookies and AI Studio storage, copy a
session bundle, or auto-sync it to the local proxy. It may not execute inference,
create a pinned AI Studio tab, or register a relay session.

## Authentication

`ocx login google-aistudio` on macOS opens the native login window unless the
user supplies a session bundle. Successful login requires a harvested SAPISID
and a completed atomic session-file write before the command reports success.

Closing or cancelling the window terminates the Swift process and returns a
clear cancellation result. The CLI must not wait indefinitely. The dashboard
login endpoint likewise waits for the login result and verifies the saved
session before reporting success.

On Windows and Linux, the CLI and dashboard return an explicit macOS-only setup
message. They do not open the legacy bridge page.

The extension auto-sync endpoint validates the same session shape used by native
login. Its port comes from the live proxy configuration or an explicit extension
setting; no inference code or hidden hard-coded relay port remains.

Base64 is transport encoding, not tamper protection. The product must not claim
that a Base64 bundle is authenticated. Admission, schema validation, control-
character rejection, cookie validation, loopback restrictions, and 0600 storage
remain required trust-boundary checks.

## Credential Resolution

One shared resolver defines whether Google AI Studio Web has usable credentials.
Inference, safe dashboard configuration, provider connection tests, and status
views all call it.

The resolver accepts:

- a valid saved AI Studio session; or
- a valid configured cookie header, matched case-insensitively.

An arbitrary non-empty API-key string is not a valid AI Studio Web credential.
Usability requires a parseable cookie jar containing SAPISID and no prohibited
control characters.

## Inference

Every request uses the existing private MakerSuite endpoint and direct
SAPISIDHASH HTTP authentication. No active relay can override this transport,
and no relay disconnect can change the request path.

Responses preserve the real upstream status and headers. HTML Google sign-in
pages, sign-in redirects, and authentication failures map to one actionable
reauthentication-required error without returning response contents.

The existing request pacing, Google wire compiler, MakerSuite parser, streaming,
tool-call translation, tool-result continuation, and thought-signature behavior
remain in place.

## Status And Reauthentication

Configured is not connected. The dashboard displays Connected only after a
bounded live upstream authentication probe succeeds for the credential identity
currently in use.

The status model distinguishes:

- connected: the current session passed its upstream probe;
- needs reauthentication: credentials are missing, invalid, expired, or redirected
  to Google sign-in;
- checking: native login or a bounded probe is still running; and
- unsupported platform: AI Studio Web authentication is unavailable outside
  macOS in this release.

Native reauthentication reports success only after the Swift process completes,
the session file validates, and the live probe succeeds. Cancellation and probe
failure remain visible and actionable.

## Browser-Relay Deprecation

The Brave/Chrome inference relay, generated userscript, bridge-page setup flow,
and native headless relay are deprecated immediately.

For one release, legacy bridge and userscript HTTP endpoints return migration
instructions instead of registering or advertising relay workers. The runtime no
longer chooses or accepts a relay for inference. After the compatibility release,
the endpoints, relay hub, WebSocket message types, dead offscreen worker, native
headless relay, and relay-only tests are deleted.

Documentation must identify the extension as an optional credential exporter,
not a background relay, and must describe direct MakerSuite cookie inference
accurately.

## Model Discovery And Quota

AI Studio Web keeps its configured static model catalog. The mismatched relay GET
to the public Generative Language `/v1beta/models` endpoint is removed.

The dashboard does not invent an upstream quota percentage or window. It may show
local request pacing and usage, and it directs users to AI Studio for authoritative
quota information.

## Error Handling

The following all converge on the reauthentication-required state:

- missing or malformed SAPISID credentials;
- expired cookies;
- HTTP 401 or 403 authentication failures;
- HTML sign-in responses or redirects; and
- a completed native login that did not produce a valid session.

Native cancellation is separate from authentication failure. Network failures,
rate limits, and upstream server errors retain their existing classifications and
must not be mislabeled as reauthentication.

No request bodies, cookies, session bundles, account identifiers, or upstream
HTML bodies are logged.

## Tests And Completion Gates

Production changes follow test-driven development. Regression coverage includes:

- shared credential resolution and case-insensitive Cookie headers;
- rejection of arbitrary API-key strings and malformed sessions;
- native success, cancellation, window close, and failed-harvest behavior;
- dashboard login waiting for completion and probing before success;
- accurate connected, checking, needs-reauthentication, and unsupported states;
- extension credential export and custom-port auto-sync without relay behavior;
- direct streaming and buffered inference;
- expired-session and HTML-login detection;
- tool calls, comprehensive tool schemas, tool-result continuation, and
  collaboration/subagent-spawn tool output;
- static catalog behavior and removal of relay discovery; and
- deprecation responses from legacy bridge endpoints.

Mocked protocol tests are named integration tests, not live E2E tests. Completion
also requires a real macOS run against the installed branch covering native login,
simple streaming inference, a tool-call continuation, comprehensive tool schemas,
and a subagent-spawn tool call.

Required automated gates are the focused AI Studio suites, full Bun test suite,
TypeScript typecheck, GUI lint and build, privacy scan, core/Lab boundary test,
and Swift compilation. Live tests must be reported separately from mocked tests.

## Migration

Existing saved sessions continue to work if they pass the shared validator.
Existing extension users keep Copy Session and Auto-Sync; relay status and
background-tab behavior disappear. Existing userscript or bridge-relay users see
the one-release migration response directing them to native login or extension
credential sync.

No provider id, model id, request format, or public OpenAI-compatible endpoint
changes.

