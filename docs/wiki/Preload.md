# Preload script

File: `src/preload/preload.js`

Runs in the renderer with contextIsolation and sandbox on. Exposes minimal, safe APIs via `window.*`.

## Features
- Keep-alive HEAD pings to the target origin
- Auto-reload timer (respecting `autoReloadEnabled` and `reloadAfterSec`)
- Login helpers (if applicable)

## Surface
- `window.AutoReload.ping()` — optional hook for heartbeat
- `window.App.*` — small helpers exposed by preload

Keep the surface area small and never expose Node APIs.
