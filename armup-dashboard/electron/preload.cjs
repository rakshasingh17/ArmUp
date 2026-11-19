// Exposes a few functions to the page. request() is the API call the pages use
// (armup.request(method, path, body, token)); the server.* ones belong to the
// connection box that shows whether the server is reachable.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('armup', {
  request: (method, path, body, token) =>
    ipcRenderer.invoke('api:request', method, path, body, token),
  server: {
    get: () => ipcRenderer.invoke('server:get'),
    set: (address) => ipcRenderer.invoke('server:set', address),
    ping: () => ipcRenderer.invoke('server:ping'),
  },
  // "Download my report (PDF)": hands finished HTML to the main process, which
  // prints it to PDF and asks where to save it.
  report: {
    savePdf: (html, suggestedName) => ipcRenderer.invoke('report:savePdf', html, suggestedName),
  },
});
