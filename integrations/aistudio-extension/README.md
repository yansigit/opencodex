# OpenCodex AI Studio Browser Extension (Chrome & Brave)

Seamless background relay for Google AI Studio Web / Pro session with `opencodex`.

## Features
- **Zero-Tab Overhead**: Relays requests via a Manifest V3 background offscreen worker. You do not need to keep an active AI Studio tab open.
- **Direct Session Sharing**: Uses your browser's existing Google login cookies.
- **Fast Local Bridge**: Connects to `opencodex` at `ws://127.0.0.1:10100/v1/ws/aistudio`.

## Installation in Brave / Chrome

1. Open `brave://extensions` (or `chrome://extensions`) in your browser.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this directory:
   ```
   <path-to-opencodex>/integrations/aistudio-extension
   ```
5. Verify the extension shows active. It will automatically connect to `opencodex`.

