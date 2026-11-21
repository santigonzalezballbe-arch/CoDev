// Pont segur entre la interfície i el procés principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codev', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  hostServer: (port) => ipcRenderer.invoke('host-server', port),
  setupProject: (opts) => ipcRenderer.invoke('setup-project', opts),
  copy: (text) => ipcRenderer.invoke('copy', text),
  ptyCreate: (opts) => ipcRenderer.invoke('pty-create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty-write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty-resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty-kill', id),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, id, data) => cb(id, data)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, id, code) => cb(id, code)),
});
