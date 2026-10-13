'use strict';

/**
 * ClipVault - encrypted clipboard history.
 *
 * The window is a small always-on-top panel. The main process owns everything
 * sensitive: the vault key never leaves this process, and the renderer only ever
 * receives already-decrypted rows over a narrow contextBridge surface.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, screen, Tray, Menu, nativeImage, shell, desktopCapturer, dialog } = require('electron');
const { Vault } = require('./crypto-store');
const { Monitor } = require('./monitor');
const { drawPadlock } = require('./icon');

const POLL_MS = 450;

const DEFAULT_SETTINGS = {
  hotkey: 'Control+Shift+V',
  screenshotHotkey: 'Control+Shift+S',
  maxEntries: 300,
  autoLockMinutes: 10,
  hideOnBlur: true,
  captureImages: true,
  retentionHours: 72,        // auto-delete unpinned items older than this
  autoSaveScreenshots: false,
  screenshotDir: '',
  autoStart: true,           // launch when the user signs in
  density: 'comfortable',    // comfortable | compact
  hideOnRestore: true,       // hide the panel after copying an entry back
};

let win = null;
let tray = null;
let vault = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = null;

// clipboard monitor state
let monitor = null;
let pollTimer = null;
let pruneTimer = null;
let lastActivity = Date.now();
let paused = false; // true when locked: capture stops entirely

// One-level undo for destructive actions, kept out of the renderer.
let undoState = null; // { label, snapshot, at }

/* ------------------------------------------------------------ diagnostics */

const LOG_MAX_BYTES = 256 * 1024;

function logPath() {
  return userDataFile('clipvault.log');
}

/** Append a line to the rolling log; never let logging break the app. */
function log(level, ...parts) {
  const line = `[${new Date().toISOString()}] ${level} ${parts.map((p) =>
    (p && p.stack) ? p.stack : (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  const stamp = level === 'ERROR' ? '[clipvault] ' : '';
  (stamp ? process.stderr.write(line) : null);
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > LOG_MAX_BYTES) fs.rmSync(file, { force: true }); // roll over
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* logging is best-effort */
  }
}

function installCrashHandlers() {
  // A clipboard manager should survive a transient failure rather than vanish
  // from the tray: log and keep the poll loop alive.
  process.on('uncaughtException', (err) => log('ERROR', 'uncaughtException', err));
  process.on('unhandledRejection', (reason) => log('ERROR', 'unhandledRejection', reason));
  app.on('render-process-gone', (_event, contents, details) => {
    log('ERROR', 'render-process-gone', details);
    if (win && !win.isDestroyed() && contents === win.webContents) {
      log('WARN', 'panel renderer gone - reloading');
      win.reload();
    }
  });
  app.on('child-process-gone', (_event, details) => log('WARN', 'child-process-gone', details.type));
}

/* ----------------------------------------------------------- auto start */

/**
 * Register (or clear) the login item.
 * In development the executable is the Electron binary, so the app directory
 * has to be passed through as an argument or the entry would launch nothing.
 */
/**
 * The exact options used to register the login item. Reading back must pass
 * the same path/args, otherwise the OS looks up a different entry than the one
 * that was written (this bites in development, where the executable is the
 * shared Electron binary).
 */
function loginItemOptions() {
  return app.isPackaged
    ? { path: process.execPath }
    : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
}

function applyAutoStart() {
  const wanted = Boolean(settings.autoStart);
  try {
    app.setLoginItemSettings({ openAtLogin: wanted, ...loginItemOptions() });
    log('INFO', `autoStart set to ${wanted} (packaged=${app.isPackaged})`);
  } catch (err) {
    log('ERROR', 'could not set login item', err);
  }
}

function autoStartActive() {
  try {
    return Boolean(app.getLoginItemSettings(loginItemOptions()).openAtLogin);
  } catch (err) {
    log('WARN', 'could not read login item settings', err);
    return false;
  }
}

// screenshot state
let captureWindows = new Map(); // windowId -> { win, display, dataUrl }
let nextCaptureId = 1;
let capturing = false;

/* ------------------------------------------------------------------ setup */

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function loadSettings() {
  settingsFile = userDataFile('settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[clipvault] could not save settings:', err.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // A translucent, rounded panel reads as a floating tool rather than a
    // plain rectangle sitting on top of everything.
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A clipboard panel should never navigate anywhere or spawn windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.on('blur', () => {
    if (settings.hideOnBlur && win && !win.webContents.isDevToolsOpened()) hidePanel();
  });

  win.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    hidePanel();
  });
}

function positionNearCursor() {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const { width, height } = win.getBounds();
  const x = Math.min(Math.max(cursor.x - Math.round(width / 2), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(cursor.y - 80, area.y), area.y + area.height - height);
  win.setPosition(x, y, false);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only one fade may run at a time; a newer one supersedes whatever is in
// flight so rapid hotkey presses never leave the window stuck half-transparent.
let fadeToken = 0;

async function fadeWindow(target, from, to, ms = 120, steps = 10) {
  const token = (fadeToken += 1);
  const dt = ms / steps;
  for (let i = 0; i <= steps; i += 1) {
    if (token !== fadeToken || !win || win.isDestroyed()) return;
    win.setOpacity(from + (to - from) * (i / steps));
    await sleep(dt);
  }
}

async function showPanel() {
  if (!win) return;
  positionNearCursor();
  // Windows blocks focus-stealing from a background process, so ask for the
  // top-most slot explicitly and re-assert focus once the window is mapped.
  win.setAlwaysOnTop(true);
  const wasHidden = !win.isVisible();
  if (wasHidden) win.setOpacity(0);
  win.show();
  win.focus();
  win.webContents.focus();
  setTimeout(() => {
    if (win && win.isVisible()) {
      win.focus();
      win.webContents.focus();
    }
  }, 60);
  if (wasHidden) await fadeWindow(win, 0, 1, 130);
  win.webContents.send('panel:shown');
}

async function hidePanel() {
  if (!win || !win.isVisible()) return;
  await fadeWindow(win, win.getOpacity() || 1, 0, 90);
  if (!win.isDestroyed() && win.isVisible()) win.hide();
  if (!win.isDestroyed()) win.setOpacity(1);
}

function togglePanel() {
  if (!win) return;
  if (win.isVisible()) hidePanel();
  else showPanel();
}

function createTray() {
  const icon = nativeImage.createFromBuffer(drawPadlock(vault.locked ? 16 : 16, vault.locked));
  tray = new Tray(icon);
  tray.setToolTip('ClipVault - encrypted clipboard history');
  tray.on('click', togglePanel);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const count = vault.locked ? null : vault.stats().entries;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: vault.locked ? 'Unlock…' : `History (${count} items)`, click: showPanel },
    { label: `Take a screenshot (${settings.screenshotHotkey})`, click: () => takeScreenshot() },
    { type: 'separator' },
    { label: 'Lock now', click: () => lockVault(true) },
    { label: 'Pause capture', click: () => setPaused(!paused) },
    { type: 'separator' },
    { label: 'Settings', click: showPanel },
    { label: 'Quit ClipVault', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

/* ----------------------------------------------------------- vault state */

function setPaused(next) {
  paused = next;
  pushState();
  refreshTrayMenu();
}

function lockVault(announce) {
  if (vault.locked) return;
  vault.lock();
  monitor?.reset();
  refreshTrayMenu();
  pushState();
  if (announce && win) win.webContents.send('toast', 'Vault locked');
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('vault:state', stateSnapshot());
}

function stateSnapshot() {
  return {
    hasVault: vault.hasVault(),
    locked: vault.locked,
    paused,
    stats: vault.locked ? { entries: 0, text: 0, images: 0, pinned: 0 } : vault.stats(),
    settings,
    hotkeyBound: globalShortcut.isRegistered(settings.hotkey),
    screenshotHotkeyBound: globalShortcut.isRegistered(settings.screenshotHotkey),
    autoStartActive: autoStartActive(),
    packaged: app.isPackaged,
    undoAvailable: Boolean(undoState),
  };
}

/** Register a shortcut, falling back through alternatives if it is already taken. */
function registerWithFallback(primary, fallbacks, handler) {
  globalShortcut.unregister(primary);
  try {
    if (globalShortcut.register(primary, handler)) return primary;
  } catch {
    /* fall through to the alternatives */
  }
  for (const candidate of fallbacks) {
    globalShortcut.unregister(candidate);
    try {
      if (globalShortcut.register(candidate, handler)) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function registerHotkey() {
  globalShortcut.unregisterAll();

  const bound = registerWithFallback(
    settings.hotkey,
    ['Control+Alt+V', 'Control+Shift+Space', 'CommandOrControl+Shift+V'],
    togglePanel,
  );
  if (!bound) {
    settings.hotkey = 'Control+Shift+V';
  } else if (bound !== settings.hotkey) {
    settings.hotkey = bound;
    saveSettings();
    if (win) win.webContents.send('toast', `Panel hotkey was busy - using ${bound}`);
  }

  const shotBound = registerWithFallback(
    settings.screenshotHotkey,
    ['Control+Alt+S', 'Control+Shift+P', 'CommandOrControl+Shift+S'],
    () => takeScreenshot(),
  );
  if (!shotBound) {
    settings.screenshotHotkey = 'Control+Shift+S';
  } else if (shotBound !== settings.screenshotHotkey) {
    settings.screenshotHotkey = shotBound;
    saveSettings();
    if (win) win.webContents.send('toast', `Screenshot hotkey was busy - using ${shotBound}`);
  }

  pushState();
}

/* --------------------------------------------------------- screenshots */

function screenshotDir() {
  if (settings.screenshotDir) return settings.screenshotDir;
  return path.join(app.getPath('pictures'), 'ClipVault');
}

function timestampedName(extension) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `clipvault-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`;
}

function closeCaptureWindows() {
  for (const entry of captureWindows.values()) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
  }
  captureWindows.clear();
  capturing = false;
}

/**
 * Freeze every display, then drop one selection overlay per display on top.
 * The screens are captured *before* the overlays exist, so they never show up
 * in the result.
 */
async function takeScreenshot() {
  if (capturing) return;
  capturing = true;

  const displays = screen.getAllDisplays();
  const shots = [];

  for (const display of displays) {
    const { width, height } = display.bounds;
    const scale = display.scaleFactor || 1;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      });
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (source && !source.thumbnail.isEmpty()) {
        shots.push({ display, dataUrl: source.thumbnail.toDataURL() });
      }
    } catch (err) {
      console.error('[clipvault] screen capture failed:', err.message);
    }
  }

  if (!shots.length) {
    capturing = false;
    if (win) win.webContents.send('toast', 'Could not capture the screen');
    return;
  }

  for (const shot of shots) {
    const id = nextCaptureId++;
    const overlay = new BrowserWindow({
      x: shot.display.bounds.x,
      y: shot.display.bounds.y,
      width: shot.display.bounds.width,
      height: shot.display.bounds.height,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      backgroundColor: '#000000',
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        additionalArguments: [`--capture-window-id=${id}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Stay above everything, including other always-on-top windows.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Windows may clamp a non-resizable frameless window to the work area,
    // which would shrink the overlay relative to the frozen snapshot and skew
    // every crop. Re-assert the true display bounds after creation.
    try {
      overlay.setBounds({ ...shot.display.bounds }, false);
    } catch {
      /* best effort - the renderer also guards against aspect drift */
    }
    captureWindows.set(id, {
      win: overlay,
      display: shot.display,
      dataUrl: shot.dataUrl,
      cssWidth: shot.display.bounds.width,
      cssHeight: shot.display.bounds.height,
    });

    overlay.loadFile(path.join(__dirname, 'capture', 'index.html'));
    overlay.once('ready-to-show', () => {
      if (!overlay.isDestroyed()) overlay.show();
    });
    // If the last overlay goes away for any reason, release the capture lock
    // so the hotkey keeps working instead of silently doing nothing.
    overlay.on('closed', () => {
      captureWindows.delete(id);
      if (captureWindows.size === 0) capturing = false;
    });
  }
}

async function finishCapture(dataUrl, rect) {
  closeCaptureWindows();

  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return { ok: false, error: 'Could not read the captured region' };

  const size = image.getSize();
  let savedTo = null;

  if (settings.autoSaveScreenshots) {
    try {
      const dir = screenshotDir();
      fs.mkdirSync(dir, { recursive: true });
      savedTo = path.join(dir, timestampedName('png'));
      fs.writeFileSync(savedTo, buffer);
    } catch (err) {
      console.error('[clipvault] could not save screenshot:', err.message);
    }
  }

  // Put it on the clipboard; the monitor then files it in the history like any
  // other copy. Deliberately not suppressed as a self-copy.
  clipboard.writeImage(image);
  // Re-prime the monitor so this capture is recognised as new content.
  if (monitor) monitor.lastImageKey = null;

  if (win) {
    win.webContents.send('toast', savedTo
      ? `Captured ${size.width}×${size.height} — copied and saved`
      : `Captured ${size.width}×${size.height} — copied to clipboard`);
  }
  // Give the overlay a moment to play its confirm flash before it goes away.
  setTimeout(closeCaptureWindows, 320);
  return { ok: true, savedTo };
}

/* ------------------------------------------------- clipboard monitoring */

function tick() {
  if (!monitor) return;
  if (monitor.tick() === 'captured') {
    vault.trim(settings.maxEntries);
    pushState();
    if (win && win.isVisible()) win.webContents.send('vault:changed');
    refreshTrayMenu();
  }
}

function restoreToClipboard(id) {
  return monitor ? monitor.restore(id) : { ok: false, error: 'Monitor not ready.' };
}

/* ------------------------------------------------------------ auto-lock */

function checkAutoLock() {
  const minutes = Number(settings.autoLockMinutes);
  if (!minutes || vault.locked) return;
  if (Date.now() - lastActivity > minutes * 60_000) lockVault(true);
}

/** Sweep out unpinned entries that have aged past the retention window. */
function runRetentionSweep(announce) {
  if (!vault || vault.locked) return 0;
  const hours = Number(settings.retentionHours);
  if (!hours || hours <= 0) return 0;
  const removed = vault.pruneOlderThan(hours);
  if (removed) {
    pushState();
    refreshTrayMenu();
    if (win && win.isVisible()) win.webContents.send('vault:changed');
    if (announce && win) win.webContents.send('toast', `Removed ${removed} item${removed === 1 ? '' : 's'} older than ${hours}h`);
  }
  return removed;
}

/* ------------------------------------------------------------------- ipc */

function windowIdFromEvent(event) {
  // The overlay windows identify themselves through their own preload args.
  const sender = event && event.sender;
  if (!sender) return null;
  for (const [id, entry] of captureWindows) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents.id === sender.id) return id;
  }
  return null;
}

function registerIpc() {
  ipcMain.handle('vault:status', () => stateSnapshot());

  // Electron's IPC drops custom error properties, so failures are returned as
  // explicit results instead of thrown errors - otherwise the panel can never
  // tell "wrong passphrase" from "corrupt file".
  ipcMain.handle('vault:create', (_e, passphrase) => {
    try {
      vault.create(String(passphrase || ''));
    } catch (err) {
      return { ok: false, code: err.code || 'unknown', message: err.message };
    }
    refreshTrayMenu();
    return { ok: true, state: stateSnapshot() };
  });

  ipcMain.handle('vault:unlock', (_e, passphrase) => {
    try {
      vault.unlock(String(passphrase || ''));
    } catch (err) {
      return { ok: false, code: err.code || 'unknown', message: err.message };
    }
    lastActivity = Date.now();
    refreshTrayMenu();
    const state = stateSnapshot();
    // Age out stale entries the moment the vault opens.
    setTimeout(() => runRetentionSweep(true), 800);
    return { ok: true, state };
  });

  ipcMain.handle('vault:lock', () => {
    lockVault(false);
    return stateSnapshot();
  });

  ipcMain.handle('vault:list', () => (vault.locked ? [] : vault.list()));

  ipcMain.handle('vault:restore', (_e, id) => restoreToClipboard(id));

  /** Remember the current history so the next destructive action can be undone. */
function stageUndo(label) {
  const snapshot = vault.snapshot();
  undoState = snapshot ? { label, snapshot, at: Date.now() } : null;
}

ipcMain.handle('vault:remove', (_e, id) => {
    stageUndo('Deleted 1 item');
    const ok = vault.remove(String(id));
    pushState();
    refreshTrayMenu();
    return { ok, undo: Boolean(undoState) };
  });

  ipcMain.handle('vault:pin', (_e, id) => {
    const pinned = vault.togglePin(String(id));
    pushState();
    return pinned;
  });

  ipcMain.handle('vault:clear', () => {
    stageUndo('History cleared');
    const removed = vault.entries.length;
    vault.clearAll();
    pushState();
    refreshTrayMenu();
    return { removed, undo: Boolean(undoState) };
  });

  ipcMain.handle('vault:undo', () => {
    if (!undoState) return { ok: false };
    const count = vault.restoreSnapshot(undoState.snapshot);
    const label = undoState.label;
    undoState = null;
    pushState();
    refreshTrayMenu();
    return { ok: true, count, label };
  });

  ipcMain.handle('vault:changePassphrase', (_e, current, next) => {
    try {
      if (!vault.locked) vault.unlock(String(current));
      vault.changePassphrase(String(next));
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code || 'unknown', message: err.message };
    }
  });

  ipcMain.handle('vault:setPaused', (_e, value) => {
    setPaused(Boolean(value));
    return paused;
  });

  ipcMain.handle('vault:activity', () => {
    lastActivity = Date.now();
    return true;
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const wasHotkey = settings.hotkey;
    const wasAutoStart = settings.autoStart;
    settings = { ...settings, ...(patch || {}) };
    saveSettings();
    if (settings.hotkey !== wasHotkey) registerHotkey();
    if (settings.autoStart !== wasAutoStart) applyAutoStart();
    pushState();
    return settings;
  });

  ipcMain.handle('window:hide', () => {
    hidePanel();
    return true;
  });

  ipcMain.handle('window:close', () => {
    hidePanel();
    return true;
  });

  ipcMain.handle('window:quit', () => {
    app.isQuitting = true;
    app.quit();
    return true;
  });

  /* ------------------------------------------------------- screenshots */

  ipcMain.handle('screenshot:start', () => {
    takeScreenshot();
    return true;
  });

  ipcMain.handle('capture:snapshot', (event) => {
    const id = windowIdFromEvent(event);
    const entry = captureWindows.get(id);
    if (!entry) return null;
    return { dataUrl: entry.dataUrl, cssWidth: entry.cssWidth, cssHeight: entry.cssHeight };
  });

  ipcMain.handle('capture:submit', async (event, dataUrl) => {
    const id = windowIdFromEvent(event);
    if (!captureWindows.has(id)) return { ok: false, error: 'capture expired' };
    return finishCapture(String(dataUrl || ''));
  });

  ipcMain.handle('capture:cancel', () => {
    closeCaptureWindows();
    return true;
  });

  /* ------------------------------------------------- save an image entry */

  ipcMain.handle('vault:saveImage', async (_e, id) => {
    const payload = vault.payload(String(id));
    if (!payload || payload.type !== 'image') return { ok: false, error: 'Not an image entry' };
    const buffer = Buffer.from(payload.dataUrl.split(',')[1], 'base64');

    const result = await dialog.showSaveDialog(win, {
      title: 'Save image',
      defaultPath: path.join(app.getPath('pictures'), timestampedName('png')),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, buffer);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openScreenshotDir', () => {
    const dir = screenshotDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('shell:openVaultFile', () => {
    const file = userDataFile('vault.json');
    shell.showItemInFolder(file);
    return file;
  });
}

/* ------------------------------------------------------------------ boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());

  // Windows uses this id for taskbar grouping and notifications, and it keeps
  // the login-item entry stable across launches.
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.clipvault.panel'); } catch { /* best effort */ }
  }

  app.whenReady().then(() => {
    installCrashHandlers();
    loadSettings();
    vault = new Vault(userDataFile('vault.json'));
    registerIpc();
    createWindow();
    createTray();
    registerHotkey();
    applyAutoStart();
    monitor = new Monitor({
      clipboard,
      vault,
      getSettings: () => settings,
      isPaused: () => paused,
    });

    pollTimer = setInterval(() => {
      tick();
      checkAutoLock();
    }, POLL_MS);

    // Retention sweep: once shortly after unlock, then hourly.
    pruneTimer = setInterval(() => runRetentionSweep(false), 60 * 60_000);

    app.on('activate', () => showPanel());
  });

  app.on('window-all-closed', (event) => {
    event?.preventDefault?.();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (vault && !vault.locked) vault.flush();
    clearInterval(pollTimer);
    clearInterval(pruneTimer);
    closeCaptureWindows();
    globalShortcut.unregisterAll();
  });
}