# Settings preload bridge

File: `src/preload/settings-preload.js`

Bridges the Settings UI to IPC. It exposes a `window.Settings` namespace with safe functions.

## Common methods
- `get-config` → `window.Settings.getConfig()`
- `save-config` → `window.Settings.saveConfig(partial)`
- `get-version` → `window.Settings.getVersion()`
- 2FA: `get-2fa-state`, `set-2fa-enabled`, `set-2fa-secret`, `remove-2fa-secret`, `get-totp-code`
- Time/Proxy: `set-ntp-preference`, `set-proxy-preference`
- `restart-app` — use after proxy host/port changes or tray behavior changes

Avoid returning secrets. All sensitive data stays encrypted in persisted config.
