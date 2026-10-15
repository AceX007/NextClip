'use strict';

// Deliberately replaces the real preload. No production main, vault, clipboard,
// settings file, shell command, or network connection is loaded by this test.
const { contextBridge, ipcRenderer } = require('electron');
const methods = [
  'status', 'create', 'unlock', 'lock', 'list', 'restore', 'remove', 'pin',
  'clear', 'undo', 'changePassphrase', 'setPaused', 'activity', 'saveImage',
  'screenshot', 'openScreenshotDir', 'saveSettings', 'revealVaultFile', 'hide', 'quit',
];
const api = Object.fromEntries(methods.map((method) => [method,
  (...args) => ipcRenderer.invoke('ui-test:call', method, args),
]));
for (const [method, channel] of Object.entries({
  onState: 'vault:state', onChanged: 'vault:changed', onShown: 'panel:shown',
  onOpenSettings: 'panel:open-settings', onToast: 'toast',
})) {
  api[method] = (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
contextBridge.exposeInMainWorld('clipvault', api);
