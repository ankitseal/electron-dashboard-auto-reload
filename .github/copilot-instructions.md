# Copilot Instructions

Purpose: enable safe, minimal edits to this Electron app that loads a dashboard URL with seeded auth cookies, auto-reloads on a schedule, and exposes optional local/remote relays. Keep contextIsolation true, sandbox true, and never enable nodeIntegration.

## Architecture (map)
- Main: `src/main/main.js` — loads layered config (resources/config.json → repo config.json → src/config.json → %APPDATA%/<AppName>/config.json) and always writes to userData. Runs a fullscreen BrowserWindow on a non‑persistent partition; seeds cookies before first navigation. Features: auto‑reload, rolling `from`/`to`, navigate‑back + child tab timeout, proxy, 2FA (TOTP with optional NTP), optional loopback relay, optional reverse‑proxy streamer, optional tray.
- Preload: `src/preload/preload.js` (keep‑alive HEAD pings, auto‑reload timer, login helpers; exposes `window.App.*` and `window.AutoReload.ping()`); `src/preload/settings-preload.js` (bridges Settings UI to IPC).
- Renderer: `src/renderer/settings/index.html` (live URL preview + validates: when rolling window ON, `reloadAfterSec` < duration); `src/renderer/missing.html` (first‑run “Open Settings”).
- Local services: loopback relay `src/main/local-server.js` (GET `/open?url=...` navigates after seeding cookies; `/api/*` mirrors IPC → `{ ok: boolean, ... }`); reverse‑proxy streamer `src/main/proxy-server.js` + `src/main/offscreen-renderer.js` + `src/renderer/proxy/*` (WebSocket‑only viewer), all gated by `reverseProxy` in config.

## Persistence & secrets
- Persist merged settings only to `%APPDATA%/<AppName>/config.json`; never write secrets to packaged resources.
- Credentials are stored as `userEnc` and 2FA secret as `twoFAEnc` (AES‑256‑GCM). In memory, `cfg.user` remains plaintext only.
- Auth precedence: use `cookies[]` if present; else synthesize legacy single `SESSION` cookie for the destination domain before `win.loadURL`.

## Runtime behaviors that matter
- Auto‑reload active when `autoReloadEnabled` and `reloadAfterSec > 0`; if toggled ON with invalid/<=0, coerces to 250s. Menu toggles persist.
- Rolling window updates `from`/`to` on the URL; on save, enforce `reloadAfterSec` < window duration (coerces when needed).
- Navigate‑back + child tabs: if `navigateBackEnabled` and `tabTimeoutSec > 0`, off‑target pages are redirected back after a grace period; stale child windows close.
- Keep‑alive HEAD pings only on target origin from preload. TOTP uses NTP‑corrected clock unless `useSystemTime` is true. Proxy via `session.setProxy` when `proxyEnabled` with valid host/port; HTTPS routing toggled by `proxyUseHttps`.

## IPC surface used by Settings
- `get-config`, `save-config`, `get-version`
- 2FA: `get-2fa-state`, `set-2fa-enabled`, `set-2fa-secret`, `remove-2fa-secret`, `get-totp-code`
- Time/Proxy: `set-ntp-preference`, `set-proxy-preference`, and `restart-app` when server host/port or tray behavior changes.

## Dev/build (Windows/Linux)
- Dev: `npm install` then `npm start` (Electron Forge). OneDrive paths can break builds—use a local folder like `C:\dev\electron-auto-reload`.
- Packaging (electron‑builder): Windows portable `npm run dist` or `dist:portable`; Linux AppImage `npm run dist:linux`. MSI (Forge + WiX v3): `npm run make:wix`.

## Safe-edit patterns
- Security: keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- New setting: extend defaults in `loadConfig()` and include in `getUiConfig()`; coerce/validate in `save-config`; wire UI in `src/renderer/settings/index.html` via `window.Settings.saveConfig(...)`.
- Relay API: add under `/api/...` in `local-server.js` delegating to existing main callbacks; never return secrets. Cookie seeding happens before any `win.loadURL` and is verified with `session.cookies.get`.

## Handy snippets
- Read config (renderer): `await window.Settings.getConfig()`
- Save config: `await window.Settings.saveConfig({ url, autoReloadEnabled: true, reloadAfterSec: 250 })`
- Navigate via relay: `GET http://127.0.0.1:793/open?url=https://example.com/path`

Note: An Android WebView module lives under `android-app/` (Kotlin) and reads the same config model; Electron remains the primary target for edits here.
