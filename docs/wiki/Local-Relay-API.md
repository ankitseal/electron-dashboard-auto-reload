# Local Relay API (loopback)

File: `src/main/local-server.js` — a local HTTP server (default http://127.0.0.1:793) that lets you navigate the main window and call select IPC actions over HTTP.

Security: Only available on loopback by default. It never returns secrets.

## Endpoints

- GET `/open?url=<encoded>` — Seeds cookies (per current config) then navigates the main window to the provided URL.
  - Example:
    ```powershell
    # PowerShell
    curl "http://127.0.0.1:793/open?url=https%3A%2F%2Fexample.com%2Fpath"
    ```
  - Response: `{ ok: true }` on success

- GET `/api/get-config` — Returns the UI-safe configuration (no secrets).
- POST `/api/save-config` — Persists provided config partial. Body: JSON.
- GET `/api/get-version` — App version info.
- 2FA-related (if exposed):
  - GET `/api/get-2fa-state`
  - POST `/api/set-2fa-enabled`
  - POST `/api/set-2fa-secret`
  - POST `/api/remove-2fa-secret`
  - GET `/api/get-totp-code`
- Time/Proxy:
  - POST `/api/set-ntp-preference`
  - POST `/api/set-proxy-preference`
  - POST `/api/restart-app` — Used after proxy host/port changes or tray behavior changes.

Note: The actual `/api/*` routes mirror the IPC surface in main.js. Check the current implementation for exact shapes; responses follow `{ ok: boolean, ... }`.

## Typical uses
- From a startup script, point the kiosk to a specific URL via `/open`.
- Remote control from the same machine (e.g., scheduled tasks) without touching the UI.
