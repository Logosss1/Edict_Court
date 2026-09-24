// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('edict', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('rt:invoke', method, args),
  onEvent: (fn: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => fn(e);
    ipcRenderer.on('rt:event', h);
    return () => ipcRenderer.removeListener('rt:event', h);
  },
  onTerm: (fn: (e: { id: string; kind: string; payload: string }) => void) => {
    const h = (_: unknown, e: { id: string; kind: string; payload: string }) => fn(e);
    ipcRenderer.on('term:event', h);
    return () => ipcRenderer.removeListener('term:event', h);
  },
  platform: process.platform,
});
