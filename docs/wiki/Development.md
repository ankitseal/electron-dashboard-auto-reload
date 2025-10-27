# Development & packaging

## Dev run
```powershell
npm install
npm start
```
If `npm start` fails in a OneDrive path, try cloning to a local path like `C:\dev\electron-auto-reload`.

## Packaging
- Windows portable: `npm run dist` or `npm run dist:portable`
- Linux AppImage: `npm run dist:linux`
- MSI (Forge + WiX v3): `npm run make:wix`

## Project tips
- When adding new settings: extend defaults in loadConfig(), include in getUiConfig(), validate/coerce in save-config, wire UI in `src/renderer/settings/index.html`.
- Relay API: add under `/api/...` in `local-server.js`, delegate to existing main callbacks, and never return secrets.
- Cookie seeding happens before any `win.loadURL` and is verified with `session.cookies.get`.
