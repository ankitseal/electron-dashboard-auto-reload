# Settings and configuration

The app merges layered config and persists only to userData: `%APPDATA%/<AppName>/config.json`.

## Key settings
- url: Target dashboard URL
- autoReloadEnabled: boolean
- reloadAfterSec: number — coerced to 250 if toggled ON with <= 0
- rollingWindowEnabled: boolean — when ON, URL query `from`/`to` is updated each reload
- navigateBackEnabled: boolean
- tabTimeoutSec: number — grace period before redirecting back / closing stale child tabs
- cookies: array of cookie objects to seed before first navigation
- userEnc: encrypted credentials (AES‑256‑GCM)
- twoFAEnc: encrypted TOTP secret (AES‑256‑GCM)
- proxyEnabled, proxyHost, proxyPort, proxyUseHttps
- reverseProxy: boolean — enables the reverse‑proxy streamer
- loopbackRelay: boolean — enables the 127.0.0.1:793 local relay

## Validation rules in Settings UI
- When rolling window is ON, `reloadAfterSec` must be less than the window duration; UI coerces when needed.
- Auto‑reload requires `reloadAfterSec > 0`; otherwise coerced to 250s.

## Minimal examples
Basic auto‑reload:
```json
{
  "url": "https://example.com/dashboard?from=now-1h&to=now",
  "autoReloadEnabled": true,
  "reloadAfterSec": 300
}
```

Cookies seeding (preferred over legacy SESSION):
```json
{
  "url": "https://example.com/",
  "cookies": [
    { "name": "SESSION", "value": "abc123", "domain": "example.com", "path": "/", "secure": true }
  ]
}
```

Proxy example:
```json
{
  "proxyEnabled": true,
  "proxyHost": "proxy.myco.local",
  "proxyPort": 3128,
  "proxyUseHttps": false
}
```

## Where configuration lives
- Default templates: repo `config.json` and packaged `resources/config.json`
- Persisted/merged: `%APPDATA%/<AppName>/config.json` (this is the only file written)

## Saving from UI
Use in renderer:
```js
await window.Settings.saveConfig({ url, autoReloadEnabled: true, reloadAfterSec: 250 })
```
