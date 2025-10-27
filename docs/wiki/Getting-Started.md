# Getting started

## Prerequisites
- Windows or Linux desktop
- Node.js LTS and npm

## Run in development
1. Install dependencies
2. Start the app

Commands (PowerShell):
```
npm install
npm start
```
Tip: OneDrive paths can break builds on Windows. If you see build failures, clone to a simple path like C:\dev\electron-auto-reload.

## First run
- You’ll see the “Missing settings” screen. Click Open Settings.
- Fill in the target URL and optional auth cookies (or legacy SESSION cookie).
- Toggle Auto‑reload and choose a reload interval.
- Save. The app will persist merged config to %APPDATA%/<AppName>/config.json and open the dashboard.

## Packaging (optional)
- Windows portable: `npm run dist` or `npm run dist:portable`
- Linux AppImage: `npm run dist:linux`
- MSI (Forge + WiX v3): `npm run make:wix`

See Development for details.
