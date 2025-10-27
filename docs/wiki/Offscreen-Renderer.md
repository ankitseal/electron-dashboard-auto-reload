# Offscreen renderer

File: `src/main/offscreen-renderer.js`

Runs an offscreen BrowserWindow that renders the target dashboard without showing it on screen. Its frames are streamed to the reverse-proxy server for remote viewing.

## Responsibilities
- Create offscreen window with the same isolation flags.
- Load the target URL after cookies are seeded.
- Stream frames (as images or binary data) to proxy-server.
- Respect navigate-back and auto-reload settings where applicable.

## Edge cases
- Offscreen rendering can be GPU-sensitive; if you see black frames, try disabling hardware acceleration at app launch.
- Long pages with animations may require throttling frame rate to keep CPU/GPU in check.

## Minimal control flow
```mermaid
sequenceDiagram
  participant Proxy as proxy-server.js
  participant Off as offscreen-renderer.js
  participant Sess as session

  Proxy->>Off: startStream(resolution, fps)
  Off->>Sess: ensure cookies + proxy
  Off->>Off: create offscreen BrowserWindow
  Off->>Proxy: onFrame(imageData)
  Proxy-->>Client: push via WebSocket
```
