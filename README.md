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

Remote setup navigation (optional):

- `cookies` — Optional array of cookie definitions to seed auth when opening dashboards. Each item: `{ name, value, domain, path, secure, httpOnly }`.
- `remoteSetup` — Settings for a tiny HTTP endpoint to navigate the existing window with cookies in place:
	- `enabled` — `true` to start the server.
	- `host` — Defaults to `0.0.0.0` (binds on all interfaces). Use `127.0.0.1` to restrict to local-only.
	- `port` — Defaults to `793`.
	- `apiKey` — Shared secret for future authenticated calls (defaults to `change-me`).

Backwards compatibility:

- If `cookies` is present with items, it’s used as the source of truth for auth.
- Else if legacy `session` exists, a single `SESSION` cookie is synthesized at runtime for the destination hostname (leading `.` domain, path `/`, `secure` only for HTTPS, `httpOnly: true`).

Validation rule:
- When Rolling Window and Auto Refresh are both enabled, `reloadAfterSec` must be less than the rolling window duration. The Settings UI prevents saving otherwise; the app also enforces this on save.

## Project structure

- `src/main/main.js` — App lifecycle, config, menu, rolling window, session handling.
- `src/preload/preload.js` — Keep-alive, auto-reload timer, login helpers (contextIsolation-safe).
- `src/preload/settings-preload.js` — IPC bridge for Settings.
- `src/renderer/settings/index.html` — Settings UI with tooltips, live URL preview, and validation.
- `src/renderer/missing.html` — First-run screen when URL is missing.
- `src/main/local-server.js` — Remote setup relay for `/open` and Settings API.
- `src/main/proxy-server.js` — Optional reverse proxy streamer (WebSocket-only) serving a landing page and remote viewer.
- `src/renderer/proxy/index.html` — Landing page and remote viewer UI for the reverse proxy (WebSocket-only stream).
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

## Remote setup /open endpoint

Purpose: allow another local process to ask the running app to open a URL in the existing window, with authentication cookies pre-seeded so dashboards under the same cookie domain open without prompting.

How to enable:

- In `config.json`, set:
	- `remoteSetup.enabled: true` (defaults to false; legacy `loopback.enabled` is still accepted)
	- optionally adjust `host` (default `0.0.0.0`) and `port` (default `793`). Use `127.0.0.1` to restrict to local-only.
- Optionally add `cookies` array to persist multiple auth cookies. If omitted, legacy `session` is used to synthesize a single `SESSION` cookie.

How to call it (verbally described):

- Send an HTTP GET request to `http://127.0.0.1:<port>/open?url=<your-https-or-http-url>` (replace `<port>`; default 793). If the server binds to `0.0.0.0`, you can also reach it via `http://<lan-ip>:<port>/`.
- On success, the app responds with `{ ok: true, loaded: <url> }` and navigates the existing window.
- On error (e.g., invalid protocol), a JSON `{ ok: false, error: "..." }` is returned with an appropriate status.

Security notes:

- When binding to `0.0.0.0`, the endpoint is accessible from your LAN. Ensure your network and firewall policies are appropriate.
- The app never returns or logs raw cookie/token values.
- Cookies are only seeded for the destination origin being opened, and `secure` cookies are set only for HTTPS URLs.

## Reverse proxy viewer (optional; WebSocket-only)

If enabled by config, a lightweight reverse proxy streamer runs alongside the app and serves:

- A landing page listing streams and an “Open viewer” link per stream.
- A remote viewer that renders JPEG frames over WebSocket and forwards mouse/keyboard input.

Notes:

- Transport is WebSocket only (no WebRTC).
- Authentication cookies are still seeded by the main app before navigation; secrets are not exposed by the viewer.

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

## Packaging (Windows/Linux)

Windows portable EXE (electron-builder):

```powershell
npm install
npm run dist           # builds Windows portable exe
npm run dist:portable  # portable x64 explicitly
npm run dist:dir       # unpacked app directory
```

Artifacts land in `dist/`.

Icons:
- The Windows executable uses `image/icon.ico` (configured in `package.json > build.win.icon`).
- Use a multi-size ICO including 256, 128, 64, 48, 32, 24, 16 px (256 may be PNG-compressed). An invalid ICO causes packaging warnings or fallback icons.

Troubleshooting:
- “invalid icon file size”: regenerate `icon.ico` with the sizes above.
- Builds failing under OneDrive paths: try a local folder (e.g., `C:\dev\electron-auto-reload`) or run PowerShell as Administrator. Developer Mode can also help.

Linux AppImage (electron-builder):

```bash
npm install
npm run dist:linux    # builds AppImage into dist/
```

Notes:
- Ensure build deps are installed (e.g., libX11, libXext, libXcursor, libXi, libXtst, libc6, libglib2.0, libgtk3 or 4 depending on Electron, etc.). On Debian/Ubuntu, use build-essential, libglib2.0-0, libnss3, libx11-6, libxkbfile1, libgtk-3-0, libasound2.
- Make the AppImage executable: `chmod +x *.AppImage` then run it.

### Windows MSI (Electron Forge + WiX)

This project can build a native MSI installer using Electron Forge's WiX maker.

Prerequisites (Windows):

- Install WiX Toolset v3 (3.14+ recommended): https://wixtoolset.org/releases/
- Ensure `candle.exe` and `light.exe` are on your PATH (WiX v3 installs to `C:\Program Files (x86)\WiX Toolset v3.x\bin`). You can either add that folder to PATH or open a Developer Command Prompt that has it.

Install dependencies (first time):

```powershell
npm install
```

Build MSI:

```powershell
npm run make:wix
```

Outputs will be under `out/make/wix/` (Forge default) with an `.msi` file. The MSI includes:
- App icon and shortcuts named "Dashboard Auto Reload"
- Per-machine install UI simplified to a single directory (no choose-directory dialog)

Troubleshooting WiX:
- 'light.exe' not found: add WiX `bin` directory to PATH and restart the shell.
- OneDrive path issues: build from a non-synced folder like `C:\dev\electron-auto-reload`.
- Code signing: if you later need signing, configure a certificate and pass signtool options via Forge's WiX maker `config.signAndEditExecutable` or use an afterMake hook.

## Persistence & where config is saved

- The app loads defaults from the bundled `config.json`, then applies overrides from the user data path.
- Saving in Settings writes to: `%APPDATA%/<App Name>/config.json` (e.g., `%APPDATA%/ankitseal-dashboard-auto-reload/config.json`).
- Credentials are encrypted and saved as `userEnc`; plaintext `user` is not persisted.
- The app may snapshot useful auth cookies after navigation (names matching `SESSION`, `sid`, `sso`, `jwt`, `auth` prefixes) into `cookies` for future runs, and keeps the legacy `session` in sync with the first such cookie for backwards compatibility.

## Login & CAPTCHA

When redirected to SSO, the app attempts to fill email/password and proceeds after common CAPTCHA challenges (e.g., Turnstile, reCAPTCHA). Manual interaction may still be required depending on the provider.

## Developer test plan (manual)

- Launch the app and authenticate once on the primary dashboard.
- Trigger a local call to `/open` with a different path on the same origin; confirm no login prompt appears.
- Trigger `/open` with an invalid protocol (e.g., `file:`); confirm a safe error JSON.
- Verify auto-reload and existing hotkeys still behave as before.
- Exit the app and confirm the remote setup server has closed (port no longer listening).
