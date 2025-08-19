const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Settings', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  startAuto: () => ipcRenderer.send('auto-reload-start'),
  stopAuto: () => ipcRenderer.send('auto-reload-stop'),
  openSettings: () => ipcRenderer.send('open-settings'),
  // 2FA controls (secret is persisted encrypted in config)
  set2FASecret: (secret) => ipcRenderer.invoke('set-2fa-secret', secret || ''),
  set2FAEnabled: (enabled) => ipcRenderer.invoke('set-2fa-enabled', !!enabled),
  get2FAState: () => ipcRenderer.invoke('get-2fa-state'),
  getTOTPCode: () => ipcRenderer.invoke('get-totp-code'),
  remove2FASecret: () => ipcRenderer.invoke('remove-2fa-secret')
});
