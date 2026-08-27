# AI Studio Web Provider Spec

## Overview
Provide Browser-relayed Google AI Studio (Playground & Build) provider using user's existing Pro session. No API key; uses SAPISIDHASH + browser bridge with fallback to direct cookie header if bridge idle.

## Requirements
- Provider id `google-aistudio`, label "Google AI Studio (Web)", baseUrl `https://alkalimakersuite-pa.clients6.google.com`, authKind local, googleMode ai-studio-web, models [gemini-3.7-flash, gemini-3.1-pro-preview, gemini-2.5-pro, gemini-2.5-flash, gemini-3.5-flash], requestPacing 8 RPM / 7500ms / 1500ms jitter.
- Session bundle: base64(JSON{selectedProject, windowId, cookies[]}) importable from extension popup; saved to ~/.opencodex/aistudio-session.json; cookieHeaderFromSession joins name=value; reject tampered/invalid bundles.
- CLI login `ocx login google-aistudio` prompts for paste token; on token>20 chars save via saveAiStudioSessionFromToken else offer native WebKit window on darwin else open bridge URL. Registry note mentions /aistudio/bridge.
- Parser: parseMakerSuiteChunk extracts [null,"text"], [true,"thought"], ErQ signature via JSON-decode of captured group.
- Adapter: google ai-studio-web parseStream treats non-SSE residual via parser -> text_delta+done, else error; parseResponse delegates via parseStream collect path like cloud-code-assist.
- Hub: AiStudioRelayHub register/unregister, dispatchRequest over WS, pending map, disconnect fails pending, ignores wrong session, multiplexed broadcast.
- Bridge: GET /aistudio/bridge HTML + WS /aistudio/ws relay, GET /api/aistudio/session POST ingest.
- Extension: Manifest V3 permissions cookies/storage/tabs + host aistudio.google.com/* + 127.0.0.1/*, popup harvests SAPISID + selectedProject + maker_suite_browser_window_id into btoa bundle, Copy + Auto-sync to localhost:10100.
- Daemon: isNativeWebKitSupported darwin-only, main.swift hardened (nonPersistent store, process isolation), swiftc compiles.
- Discovery: GET /v1beta/models dispatch over hub, parse model list; quota surface reports pacing + relay status.
- Security: parseGoogleCookieJar rejects CR/LF, no token logging.
