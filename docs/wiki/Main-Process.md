# Main process

File: `src/main/main.js`

Responsibilities
- Load layered config (resources/config.json → repo config.json → src/config.json → %APPDATA%/<AppName>/config.json)
- Persist merged settings to userData only
- Create fullscreen BrowserWindow on a non‑persistent partition
- Seed cookies before first navigation (prefer `cookies[]`; else legacy `SESSION`)
- Auto‑reload + rolling window
- Navigate‑back + child tab timeout
- Proxy via `session.setProxy`
- 2FA (TOTP with optional NTP‑corrected clock)
- Optional tray, loopback relay, reverse proxy streamer

Security
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- Never write secrets to packaged resources; only to userData (encrypted)

Contracts (IPC used by Settings)
- `get-config`, `save-config`, `get-version`
- 2FA: `get-2fa-state`, `set-2fa-enabled`, `set-2fa-secret`, `remove-2fa-secret`, `get-totp-code`
- Time/Proxy: `set-ntp-preference`, `set-proxy-preference`, `restart-app`
