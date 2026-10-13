'use strict';

/**
 * Bridge for the screenshot selection overlay. Deliberately tiny: it can read
 * its own frozen screen snapshot, hand back a cropped PNG, or bail out.
 */

const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

contextBridge.exposeInMainWorld('capture', {
  windowId: Number(arg('capture-window-id')),
  snapshot: () => ipcRenderer.invoke('capture:snapshot'),
  submit: (dataUrl, rect) => ipcRenderer.invoke('capture:submit', dataUrl, rect),
  cancel: () => ipcRenderer.invoke('capture:cancel'),
});