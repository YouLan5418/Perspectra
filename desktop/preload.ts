import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopAPI', {
  state: () => ipcRenderer.invoke('desktop:state'),
  choosePack: () => ipcRenderer.invoke('desktop:choose-pack'),
  start: (request: unknown) => ipcRenderer.invoke('desktop:start', request),
  open: () => ipcRenderer.invoke('desktop:open'),
  stop: () => ipcRenderer.invoke('desktop:stop'),
})
