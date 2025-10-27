# Security model

Hard requirements
- Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Use a non‑persistent session partition; seed cookies before navigation.
- Persist merged settings only to `%APPDATA%/<AppName>/config.json`.
- Encrypt credentials (`userEnc`) and 2FA secret (`twoFAEnc`) with AES‑256‑GCM.

Auth precedence
- If `cookies[]` present, seed exactly those for the destination domain.
- Else synthesize a single legacy `SESSION` cookie prior to `loadURL`.

Network
- Proxy via `session.setProxy` when enabled; toggle HTTPS routing via `proxyUseHttps`.
- Preload issues HEAD pings only to the target origin.

Reverse proxy
- WS-only viewer; never forwards cookies or secrets.
- Host machine should be on a trusted network or protected by an authenticated reverse proxy/VPN.
