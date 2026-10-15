'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  toggle: () => ipcRenderer.invoke('bubble:toggle'),
  unpin: () => ipcRenderer.invoke('bubble:unpin'),
});
