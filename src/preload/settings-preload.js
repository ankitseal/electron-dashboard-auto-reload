const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Settings', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  startAuto: () => ipcRenderer.send('auto-reload-start'),
  stopAuto: () => ipcRenderer.send('auto-reload-stop'),
  openSettings: () => ipcRenderer.send('open-settings')
});
