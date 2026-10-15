'use strict';

/**
 * The only bridge between the panel and the vault. Everything is an explicit,
 * named call - no generic "invoke anything" escape hatch, and no Node access
 * is exposed to the page.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('clipvault', {
  status: () => ipcRenderer.invoke('vault:status'),
  create: (passphrase, remember) => ipcRenderer.invoke('vault:create', passphrase, remember),
  unlock: (passphrase, remember) => ipcRenderer.invoke('vault:unlock', passphrase, remember),
  lock: () => ipcRenderer.invoke('vault:lock'),
  list: () => ipcRenderer.invoke('vault:list'),
  restore: (id) => ipcRenderer.invoke('vault:restore', id),
  remove: (id) => ipcRenderer.invoke('vault:remove', id),
  pin: (id) => ipcRenderer.invoke('vault:pin', id),
  clear: () => ipcRenderer.invoke('vault:clear'),
  undo: () => ipcRenderer.invoke('vault:undo'),
  changePassphrase: (current, next) => ipcRenderer.invoke('vault:changePassphrase', current, next),
  setPaused: (value) => ipcRenderer.invoke('vault:setPaused', value),
  activity: () => ipcRenderer.invoke('vault:activity'),
  saveImage: (id) => ipcRenderer.invoke('vault:saveImage', id),
  screenshot: () => ipcRenderer.invoke('screenshot:start'),
  openScreenshotDir: () => ipcRenderer.invoke('shell:openScreenshotDir'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  revealVaultFile: () => ipcRenderer.invoke('shell:openVaultFile'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('window:quit'),

  onState: on('vault:state'),
  onChanged: on('vault:changed'),
  onShown: on('panel:shown'),
  onOpenSettings: on('panel:open-settings'),
  onToast: on('toast'),
});
