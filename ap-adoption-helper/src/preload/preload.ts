import { contextBridge, ipcRenderer } from 'electron';

const api: HeidiFiApi = {
  scan: () => ipcRenderer.invoke('scan'),
  adopt: (req) => ipcRenderer.invoke('adopt', req),
  preflight: () => ipcRenderer.invoke('preflight'),
  adoptionSession: (req) => ipcRenderer.invoke('adoption:session', req),
  adoptionVenue: (req) => ipcRenderer.invoke('adoption:venue', req),
  adoptionPrecheck: (req) => ipcRenderer.invoke('adoption:precheck', req),
  adoptionClaim: (req) => ipcRenderer.invoke('adoption:claim', req),
  adoptionStatus: (req) => ipcRenderer.invoke('adoption:status', req),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveSettings: (settings) => ipcRenderer.invoke('config:set', settings),
  getLog: () => ipcRenderer.invoke('log:getAll'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  onDevice: (cb) => {
    ipcRenderer.on('scan:device', (_event, device: DiscoveredDevice) => cb(device));
  },
  onLog: (cb) => {
    ipcRenderer.on('log:line', (_event, line: string) => cb(line));
  },
};

contextBridge.exposeInMainWorld('heidifi', api);
