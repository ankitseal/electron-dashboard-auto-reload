# Settings UI

File: `src/renderer/settings/index.html`

Provides a live URL preview and validates constraints:
- When rolling window is ON, `reloadAfterSec` must be less than window duration; coerces when needed.
- Toggling Auto‑reload ON with invalid/<=0 interval coerces interval to 250s.

## What you can change
- Target URL (including query params for from/to)
- Auto‑reload and interval
- Rolling window (updates from/to on each reload)
- Navigate‑back and child tab timeout
- Cookies and optional legacy SESSION value
- Proxy settings (host, port, HTTPS)
- 2FA preferences and secret management
- Reverse Proxy and Loopback relay toggles

## Save from UI
```js
await window.Settings.saveConfig({ url, autoReloadEnabled: true, reloadAfterSec: 250 })
```

On save, the app writes merged settings to `%APPDATA%/<AppName>/config.json` and applies safe coercions.
