# Files overview

This page maps the important files in the Electron app and what they do.

## Main process
- src/main/main.js — Loads layered config, seeds cookies, creates the fullscreen BrowserWindow, handles auto‑reload, rolling from/to, navigate‑back + child tab timeout, proxy, 2FA (TOTP + optional NTP), optional tray, optional relays.
- src/main/local-server.js — Loopback relay (default 127.0.0.1:793). Endpoints to navigate/open and an /api/* surface that mirrors IPC. No secrets returned.
- src/main/proxy-server.js — Reverse‑proxy streamer HTTP/WS server for remote viewing of the dashboard.
- src/main/offscreen-renderer.js — Offscreen BrowserWindow to render the target page and stream frames to the proxy server.

## Preload scripts
- src/preload/preload.js — Runs in the renderer context with isolation. Implements keep‑alive HEAD pings, auto‑reload timer, and login helpers. Exposes window.App.* and window.AutoReload.ping().
- src/preload/settings-preload.js — Bridge between Settings UI and main IPC. Exposes window.Settings.getConfig/saveConfig/etc.

## Renderer
- src/renderer/settings/index.html — Settings UI. Live URL preview and validation rules (e.g., when rolling window is ON, reloadAfterSec < duration).
- src/renderer/missing.html — First run page prompting to open Settings.
- src/renderer/proxy/index.html — WS‑only reverse proxy viewer UI.
- src/renderer/proxy/sw.js — Service worker for the viewer (if used).

## Config and Android
- config.json — Root repo config defaults (merged on startup; final persisted config goes to %APPDATA%/<AppName>/config.json).
- android-app/ — Android WebView client that reads the same config model. Electron remains the primary target.

See also: Architecture and specific guides for each component.
