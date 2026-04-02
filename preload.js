const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onApiStatus: (cb)  => ipcRenderer.on('api-status',  (_e, status) => cb(status)),
  onServerLog: (cb)  => ipcRenderer.on('server-log',  (_e, msg)    => cb(msg)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
