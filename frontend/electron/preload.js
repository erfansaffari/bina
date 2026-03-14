const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bina', {
  // Native dialogs
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showInFinder: (filePath) => ipcRenderer.invoke('shell:showInFinder', filePath),

  // API helpers
  api: {
    get: (endpoint) => ipcRenderer.invoke('api:get', endpoint),
    post: (endpoint, body) => ipcRenderer.invoke('api:post', endpoint, body),
    delete: (endpoint, body) => ipcRenderer.invoke('api:delete', endpoint, body),
  },
})
