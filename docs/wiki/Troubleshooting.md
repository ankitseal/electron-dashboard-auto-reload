# Troubleshooting

## App fails to start with npm start
- On Windows, OneDrive sync paths can cause issues. Try moving the repo to `C:\dev\electron-auto-reload`.
- Run `npm install` again to ensure dependencies.

## Dashboard shows as logged out
- Verify cookies[] in Settings are correct for the destination domain.
- If using legacy SESSION, ensure `domain`, `path`, and `secure` flags match the site.
- Confirm cookies are seeded: check `session.cookies.get({ url: targetOrigin })` in logs if available.

## Auto‑reload not working
- Ensure `autoReloadEnabled` is ON and `reloadAfterSec > 0` (UI coerces to 250s if invalid).
- If rolling window is ON, confirm `reloadAfterSec < window duration`.

## Navigate‑back keeps redirecting
- Off-target pages will be redirected after `tabTimeoutSec`; either increase the grace period or disable Navigate Back.

## Reverse proxy black/blank frames
- Try disabling hardware acceleration on launch.
- Reduce frame rate or resolution in the proxy viewer.
- Check network stability; WS drops will interrupt streaming.

## Proxy settings don’t apply
- Changing proxy host/port requires an app restart; use the `restart-app` IPC or Settings action.
