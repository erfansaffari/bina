const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bina', {
  // Native dialogs
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showInFinder: (filePath) => ipcRenderer.invoke('shell:showInFinder', filePath),

  // Confirmation dialog (for destructive actions like workspace delete)
  confirm: (message, detail) => ipcRenderer.invoke('dialog:confirm', message, detail),

  // API helpers
  api: {
    get: (endpoint) => ipcRenderer.invoke('api:get', endpoint),
    post: (endpoint, body) => ipcRenderer.invoke('api:post', endpoint, body),
    patch: (endpoint, body) => ipcRenderer.invoke('api:patch', endpoint, body),
    delete: (endpoint, body) => ipcRenderer.invoke('api:delete', endpoint, body),
  },
})
