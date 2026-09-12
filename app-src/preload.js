const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getPreviewData: () => ipcRenderer.invoke('get-preview-data'),
  enterSleepMode: () => ipcRenderer.invoke('enter-sleep-mode'),
  restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, payload) => callback(payload));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, payload) => callback(payload));
  },
});
