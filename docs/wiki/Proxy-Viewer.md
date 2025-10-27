# Proxy viewer UI

Files: `src/renderer/proxy/index.html`, `src/renderer/proxy/sw.js`

A minimal WebSocket-only viewer for remote access to the offscreen-rendered dashboard.

Features
- Connect/disconnect to the reverse proxy
- Select resolution / scale
- Show connection status and simple diagnostics

Deployment
- Served by `proxy-server.js` when `reverseProxy` is enabled.
- Consider placing behind an authenticated reverse proxy if exposed outside a trusted network.
