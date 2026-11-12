// Exposes exactly one function to the page: armup.request(method, path, body, token).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('armup', {
  request: (method, path, body, token) =>
    ipcRenderer.invoke('api:request', method, path, body, token),
});
