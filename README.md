# Electron Auto Reload

Electron-based replacement for the Python/Selenium app. It loads the configured URL with a pre-set `SESSION` cookie, optionally keeps the session alive, and refreshes periodically.

## Configure

Edit `config.json`:

- `url`: Full dashboard URL to load (e.g., `https://eu1.mindsphere.io/some/path`).
- `session`: Value of the `SESSION` cookie to use.
- `keepAliveSec`: Number of seconds between same-origin HEAD pings to keep the session active. `0` disables.
- `reloadAfterSec`: Seconds to wait before reloading the page. Default `300`. If set to `0`, auto reload is disabled.
- `waitForCss`: Optional CSS selector to confirm authenticated UI is ready before starting timers.
- `user.email` and `user.password`: Optional credentials. If present and the page redirects to a login form (e.g., Microsoft/Siemens), the app attempts to auto-fill and submit.
 - `timeWindow.enabled`: Set to `true` to add `from`/`to` query params for a rolling 24h window.
 - `timeWindow.start`: Daily start time (local) in `HH:MM` (e.g., `"05:30"`). The app computes `from` at today’s start time and `to` at the next day’s start time.

- `autoReloadEnabled`: Boolean toggle for auto reload. When you disable via menu or Settings, `reloadAfterSec` is persisted as `0` and the input is greyed out in Settings.
- `navigateBackEnabled`: When `true`, the app enforces returning to the configured URL if you navigate away, and participates in child tab cleanup.
- `tabTimeoutSec`: Number of seconds before child tabs are auto-closed. `0` disables child tab cleanup and automatically disables `navigateBackEnabled`. The Settings UI greys this field out and sets it to `0` when Navigate Back is OFF; when ON, the field enforces a minimum of `1`.

## Project structure

Key files after refactor:

- `src/main/main.js` — Electron main process (creates BrowserWindow, loads config, menu, watchdog)
- `src/preload/preload.js` — Preload for the main window (login automation, keep-alive, auto-reload)
- `src/preload/settings-preload.js` — Preload for the Settings window (IPC bridge)
- `src/renderer/settings/index.html` — Settings UI
- `config.json` — Runtime configuration (bundled and/or overridden in userData)

## Run

1. Install Node.js 18+.
2. From this folder, install dependencies:

```powershell
npm install
```

3. Start the app:

```powershell
npm start
```

The window opens fullscreen and auto-reloads per your settings.

Keyboard shortcuts:

- Ctrl+/ → Open Settings

### Settings and Menu behavior

- Auto Refresh
	- Toggle in Settings or menu. Enabling requires a positive `Reload After (sec)`; if missing, defaults to `250`.
	- Disabling sets `reloadAfterSec` to `0` and greys out the field in Settings.
- Navigate Back & Tab Timeout
	- When Navigate Back is OFF, `Close child tabs after (sec)` is disabled and set to `0`.
	- When Navigate Back is ON, the timeout must be at least `1` second. Setting it to `0` automatically turns Navigate Back OFF.
	- Links that open in new tabs are opened as child windows; stale child tabs are auto-closed based on `tabTimeoutSec`, and the app returns to the default URL.

## Packaging

Build a portable Windows executable with electron-builder:

1) Install dependencies

```powershell
npm install
```

2) Package for Windows (portable exe):

```powershell
npm run dist
```

Artifacts will be under `dist/`. You can also run:

```powershell
npm run dist:portable   # explicit portable target
npm run dist:dir        # unpacked app directory
```

Notes:
- The packaged app bundles `config.json`. On first run, you can also place an override at `%APPDATA%/Dashboard Auto Reload/config.json` (Electron userData). The app writes updated `session` there if packaged resources are read-only.
- If you want a different target (e.g., nsis installer), we can adjust the `build.win.target` accordingly.

### Troubleshooting build on Windows

If the build fails with a 7-Zip error about creating symbolic links ("A required privilege is not held by the client"), do one of the following and re-run `npm run dist`:

- Run the terminal as Administrator, or
- Enable Windows Developer Mode: Settings > Privacy & security > For developers > Developer Mode (then restart your terminal), or
- Move the project to a local folder outside OneDrive/redirected profiles.

## Login and CAPTCHA handling

If redirected to a login page, the app attempts to fill email and password (when configured). Some providers present a CAPTCHA challenge:

- The app waits for common CAPTCHA widgets to be solved (Cloudflare Turnstile, Google reCAPTCHA, and Auth0/ULP variants).
- If a visible “Verify you are human” checkbox appears, the app attempts to click it automatically; otherwise, complete the challenge manually. Once solved, the app continues the login flow and re-submits if needed.
