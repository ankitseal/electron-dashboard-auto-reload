# Electron Dashboard Auto Reload

Electron app to display a dashboard URL with a pre-set `SESSION` cookie, optional keep-alive, and periodic auto-refresh. Includes a modern Settings UI, a first-run “missing settings” screen, and a rolling time window.

## First run

- If no URL is configured, the app shows a full-screen message and opens Settings automatically.
- Behaviors requiring a URL (auto-refresh, navigate-back) are disabled until a URL is set.

## Configure

You can configure via Settings (recommended) or by editing `config.json`.

Config keys:

- `url` — Full dashboard URL (e.g., `https://example.com/path`).
- `session` — Value of the `SESSION` cookie to use. The app also learns and saves it when you log in.
- `keepAliveSec` — Seconds between same-origin HEAD pings to keep sessions alive. `0` disables.
- `reloadAfterSec` — Seconds between reloads. Default `300`. If set to `0`, auto-refresh is off.
- `waitForCss` — Optional CSS selector; timers start only after it appears.
- `user.email` / `user.password` — Optional; the app attempts to auto-fill common SSO forms. Stored encrypted on save.
- `timeWindow.enabled` — Append `from`/`to` timestamps to the URL and keep them updated.
- `timeWindow.start` — Daily start time (local) in `HH:MM`. This is the “from” time.
- `timeWindow.duration` — Window length, one of: `1h`, `2h`, `6h`, `12h`, `1d`, `2d`, `5d`, `7d`. The “to” time is `start + duration`.
- `autoReloadEnabled` — Toggle for auto-refresh (UI also controls this).
- `navigateBackEnabled` — Return to the configured URL if the page navigates away.
- `tabTimeoutSec` — Auto-close child tabs after this many seconds. `0` disables and turns off `navigateBackEnabled`.

Validation rule:
- When Rolling Window and Auto Refresh are both enabled, `reloadAfterSec` must be less than the rolling window duration. The Settings UI prevents saving otherwise; the app also enforces this on save.

## Project structure

- `src/main/main.js` — App lifecycle, config, menu, rolling window, session handling.
- `src/preload/preload.js` — Keep-alive, auto-reload timer, login helpers (contextIsolation-safe).
- `src/preload/settings-preload.js` — IPC bridge for Settings.
- `src/renderer/settings/index.html` — Settings UI with tooltips, live URL preview, and validation.
- `src/renderer/missing.html` — First-run screen when URL is missing.
- `config.json` — Default config included with the app.

## Run (dev)

1) Install dependencies

```powershell
npm install
```

2) Start the app

```powershell
npm start
```

Keyboard shortcut: Ctrl+/ → Open Settings.

Note on icons (dev vs packaged): in dev, Windows taskbar shows the default Electron icon; your custom icon appears after packaging.

## Settings behavior

- Auto Refresh
	- Toggle on/off. If enabled with a non-positive value, defaults to `250` seconds.
	- Disabled state sets the field to `0`.
- Rolling Window
	- “Daily start” sets the from time; “Duration” sets the to time.
	- The app auto-updates the URL’s `from`/`to` when the window rolls over.
	- Live preview shows the effective URL.
	- Rule: Reload interval must be less than the window duration.
- Navigation
	- When Navigate Back is OFF, the “Close child tabs after” field is disabled and set to `0`.
	- When ON, a minimum of `1` second is enforced; setting it to `0` toggles Navigate Back OFF.

## Packaging (Windows)

Build with electron-builder:

```powershell
npm run dist           # Windows build (portable by default per config)
npm run dist:portable  # explicit portable target
npm run dist:dir       # unpacked app directory
```

Artifacts are in `dist/`.

Icons:
- The Windows executable uses `icon.ico` from the project root (declared in `package.json > build.win.icon`).
- Use a multi-size ICO including 256, 128, 64, 48, 32, 24, 16 px (256 may be PNG-compressed). An invalid ICO causes packaging warnings or fallback icons.

Troubleshooting:
- Error “invalid icon file size”: regenerate `icon.ico` with the sizes above.
- 7-Zip symlink privilege errors: run terminal as Administrator, enable Windows Developer Mode, or build outside OneDrive/redirected folders.

## Persistence & where config is saved

- The app loads defaults from the bundled `config.json`, then applies overrides from the user data path.
- Saving in Settings writes to: `%APPDATA%/<App Name>/config.json` (e.g., `%APPDATA%/ankitseal-dashboard-auto-reload/config.json`).
- Credentials are encrypted and saved as `userEnc`; plaintext `user` is not persisted.

## Login & CAPTCHA

When redirected to SSO, the app attempts to fill email/password and proceeds after common CAPTCHA challenges (e.g., Turnstile, reCAPTCHA). Manual interaction may still be required depending on the provider.
