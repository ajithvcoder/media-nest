import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mediaNest', {
  chooseFolder: () => ipcRenderer.invoke('library:choose-folder'),
  getState: () => ipcRenderer.invoke('library:get-state'),
  scan: () => ipcRenderer.invoke('library:scan'),
  getTracks: (filePath: string) => ipcRenderer.invoke('media:get-tracks', filePath),
  prepareAudio: (filePath: string, streamIndex: number) => ipcRenderer.invoke('media:prepare-audio', filePath, streamIndex),
  prepareSubtitle: (filePath: string, streamIndex: number) => ipcRenderer.invoke('media:prepare-subtitle', filePath, streamIndex),
  saveProgress: (id: number, position: number, audioTrack: number, subtitleTrack: number) => ipcRenderer.invoke('playback:save', { id, position, audioTrack, subtitleTrack }),
  onScanProgress: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('library:progress', handler);
    return () => ipcRenderer.removeListener('library:progress', handler);
  }
});
