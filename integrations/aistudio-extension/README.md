# OpenCodex AI Studio Session Exporter

A lightweight Manifest V3 browser extension for Brave and Google Chrome that extracts your active Google AI Studio session credentials and exports them to OpenCodex.

## Usage

1. Open `brave://extensions` or `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this directory (`integrations/aistudio-extension`).
3. Log in to [AI Studio](https://aistudio.google.com).
4. Add the exact extension origin shown by `chrome.runtime.id` to `corsAllowOrigins`, then enter an OpenCodex data-plane API key before Auto-Sync.
5. Click the extension icon and click **Auto-Sync to OpenCodex** (or **Copy Session Token** to paste into `ocx login`).

## Security
- Credentials are exported directly to your local loopback OpenCodex proxy (`http://127.0.0.1:10100`).
- No background workers, tab automation, or relay tunnels are used.
