'use strict';

/**
 * NextClip - encrypted clipboard history.
 *
 * The window is a small always-on-top panel. The main process owns everything
 * sensitive: the vault key never leaves this process, and the renderer only ever
 * receives already-decrypted rows over a narrow contextBridge surface.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, screen, Tray, Menu, nativeImage, shell, desktopCapturer, dialog, safeStorage, nativeTheme } = require('electron');

nativeTheme.themeSource = 'dark';

// clipboard.writeImage blocks this process while another app holds the
// clipboard, which keeps Escape from reaching capture:cancel. Screenshots
// hand the same PNG to this short-lived process and let it exit. It must
// not start a second NextClip (no single-instance lock, its own userData).
if (process.env.NEXTCLIP_CLIPBOARD_HELPER === '1') {
  try {
    const helperData = path.join(app.getPath('temp'), 'nextclip-clipboard-helper');
    fs.mkdirSync(helperData, { recursive: true });
    app.setPath('userData', helperData);
    app.setPath('sessionData', helperData);
    app.disableHardwareAcceleration();
  } catch {
    /* still attempt the write once the app is ready */
  }
  const failTimer = setTimeout(() => {
    try { app.exit(1); } catch { process.exit(1); }
  }, 20000);
  // No windows are opened. Don't let the default quit path exit 0 before
  // writeImage runs — the parent treats 0 as "the image is on the clipboard".
  app.on('window-all-closed', (event) => { event.preventDefault(); });
  app.whenReady().then(async () => {
    let code = 1;
    try {
      // Receive the PNG over the helper's pipe so screenshots never land as
      // plaintext files in the OS temp directory, even briefly.
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const image = nativeImage.createFromBuffer(Buffer.concat(chunks));
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        code = 0;
      }
    } catch {
      code = 1;
    }
    clearTimeout(failTimer);
    app.exit(code);
  }).catch(() => {
    clearTimeout(failTimer);
    try { app.exit(1); } catch { process.exit(1); }
  });
  return;
}

const { Vault } = require('./crypto-store');
const { Monitor } = require('./monitor');
const { drawPadlock } = require('./icon');
const { LoginStore } = require('./login-store');
const { queryWindowsBootId } = require('./boot-id');
const { decideStartup } = require('./remember-login');
const { createBubbleWindow, setBubbleSuppressed, setBubblePinned, destroyBubble, bubbleSnapshot } = require('./bubble-window');

// productName is NextClip. Electron would otherwise open a new userData
// folder under that name and miss the existing encrypted history.
const legacyUserData = path.join(app.getPath('appData'), 'clipvault');
fs.mkdirSync(legacyUserData, { recursive: true });
app.setPath('userData', legacyUserData);
app.setPath('sessionData', legacyUserData);
app.setName('NextClip');

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
  hideOnRestore: false,      // a copy leaves the panel open unless the user opts in
  bubblePinned: true,        // keep the launcher bubble on screen between uses
};

let win = null;
let tray = null;
let vault = null;
let loginStore = null;
let sessionBootId = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = null;

// clipboard monitor state
let monitor = null;
let pollTimer = null;
let pruneTimer = null;
let rememberExpiryTimer = null;
let lastActivity = Date.now();
let paused = false; // true when locked: capture stops entirely
// Accelerators this process actually bound. isRegistered() is true for a
// collision too: the panel handler owns the shortcut, but the screenshot
// setting can be the same string and would otherwise look healthy.
let boundPanelHotkey = null;
let boundShotHotkey = null;

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
      return;
    }
    if (!isCaptureWebContents(contents)) return;
    log('WARN', 'capture renderer gone - releasing lock');
    closeCaptureWindows();
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
let captureSubmitted = false;
let captureSessionId = 0;
// Last overlay we focused. A sibling blur-cancel must not look "focused"
// just because isFocused() has not caught up yet.
let focusedCaptureId = null;

/* ------------------------------------------------------------------ setup */

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function boundedSetting(value, min, max, fallback) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function shortcutSetting(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, '');
  return cleaned && cleaned.length <= 100 ? cleaned : fallback;
}

function booleanSetting(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    hotkey: shortcutSetting(source.hotkey, DEFAULT_SETTINGS.hotkey),
    screenshotHotkey: shortcutSetting(source.screenshotHotkey, DEFAULT_SETTINGS.screenshotHotkey),
    maxEntries: boundedSetting(source.maxEntries, 20, 2000, DEFAULT_SETTINGS.maxEntries),
    autoLockMinutes: boundedSetting(source.autoLockMinutes, 0, 240, DEFAULT_SETTINGS.autoLockMinutes),
    hideOnBlur: booleanSetting(source.hideOnBlur, DEFAULT_SETTINGS.hideOnBlur),
    captureImages: booleanSetting(source.captureImages, DEFAULT_SETTINGS.captureImages),
    retentionHours: boundedSetting(source.retentionHours, 0, 8760, DEFAULT_SETTINGS.retentionHours),
    autoSaveScreenshots: booleanSetting(source.autoSaveScreenshots, DEFAULT_SETTINGS.autoSaveScreenshots),
    screenshotDir: typeof source.screenshotDir === 'string' ? source.screenshotDir : DEFAULT_SETTINGS.screenshotDir,
    autoStart: booleanSetting(source.autoStart, DEFAULT_SETTINGS.autoStart),
    density: source.density === 'compact' ? 'compact' : 'comfortable',
    hideOnRestore: booleanSetting(source.hideOnRestore, DEFAULT_SETTINGS.hideOnRestore),
    bubblePinned: booleanSetting(source.bubblePinned, DEFAULT_SETTINGS.bubblePinned),
  };
}

function loadSettings() {
  settingsFile = userDataFile('settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  const tmp = `${settingsFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** True when the pointer is over the panel. Screen DIP coordinates, same space as getBounds. */
function pointerInsidePanel() {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  return cursor.x >= bounds.x
    && cursor.y >= bounds.y
    && cursor.x < bounds.x + bounds.width
    && cursor.y < bounds.y + bounds.height;
}

// Intentional hide (hotkey, Hide-after-copy, tray). The blur hide() itself
// emits must not be treated as a click in another app, and must not focus
// the window back into view.
let panelHideDepth = 0;
let lastFocusReclaim = 0;
// Armed from the window's own mouse-down, which can land in the same turn as
// the frameless blur. That click is still inside the panel.
let pointerDownUntil = 0;

function notePointerDown() {
  // Same click as the frameless blur, not the next one. A long window swallows
  // an outside click and win.focus() pulls the panel back up.
  pointerDownUntil = Date.now() + 120;
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
    frame: false,
    roundedCorners: true,
    title: 'NextClip',
    // Opaque, with no frameless drop shadow. On Windows, transparent pixels
    // and that shadow both composite as a square black fringe around the panel.
    transparent: false,
    hasShadow: false,
    backgroundColor: '#070707',
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

  try {
    win.hookWindowMessage(0x0201, notePointerDown); // WM_LBUTTONDOWN
    win.hookWindowMessage(0x0204, notePointerDown); // WM_RBUTTONDOWN
  } catch { /* best effort */ }

  win.on('blur', () => {
    if (!win || win.isDestroyed() || win.webContents.isDevToolsOpened()) return;
    if (panelHideDepth > 0) return;
    // A frameless window emits blur on the same mousedown that hits a row,
    // while the pointer is still inside. That is not a click in another app,
    // even when a sibling always-on-top window steals focus on that click.
    // Hiding here runs before click, so the row never copies back.
    const pointerInside = !capturing && pointerInsidePanel();
    if (pointerInside || Date.now() < pointerDownUntil) {
      const now = Date.now();
      // Refocus only while the pointer is still over the panel. An outside
      // click during the same-click grace must not yank focus back.
      if (pointerInside && !win.isFocused() && now - lastFocusReclaim > 250) {
        lastFocusReclaim = now;
        try { win.focus(); } catch { /* window is closing */ }
      }
      return;
    }
    // The capture overlay takes focus so Escape is delivered. That blur is
    // not the user leaving; capture already hid the panel on its own.
    if (settings.hideOnBlur && !capturing) hidePanel();
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
    if (token !== fadeToken || !win || win.isDestroyed()) return false;
    try {
      win.setOpacity(from + (to - from) * (i / steps));
    } catch {
      return false;
    }
    await sleep(dt);
  }
  return token === fadeToken && Boolean(win) && !win.isDestroyed();
}

async function showPanel() {
  if (!win || win.isDestroyed()) return;
  try {
    setBubbleSuppressed(true);
    // Opening the panel is activity. Otherwise a hotkey press after the idle
    // window has already elapsed locks the vault on the next poll, and the
    // user sees the lock screen instead of the history they just asked for.
    lastActivity = Date.now();
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
      try {
        if (win && !win.isDestroyed() && win.isVisible()) {
          win.focus();
          win.webContents.focus();
        }
      } catch {
        /* window went away during the focus retry */
      }
    }, 60);
    if (wasHidden) {
      const finished = await fadeWindow(win, 0, 1, 130);
      // A hide that started during the fade owns the window now.
      if (!finished || !win || win.isDestroyed() || !win.isVisible()) return;
    }
    if (!win.isDestroyed()) win.webContents.send('panel:shown');
  } catch (err) {
    log('ERROR', 'could not show panel', err && err.message);
    try {
      if (!win || win.isDestroyed() || !win.isVisible()) setBubbleSuppressed(false);
    } catch {
      /* bubble already gone */
    }
  }
}

async function hidePanel() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  panelHideDepth += 1;
  try {
    const finished = await fadeWindow(win, win.getOpacity() || 1, 0, 90);
    // showPanel supersedes this fade by bumping the token. Hiding anyway
    // closes the panel the hotkey just opened.
    if (!finished) return;
    if (!win.isDestroyed() && win.isVisible()) win.hide();
    if (!win.isDestroyed()) win.setOpacity(1);
  } catch (err) {
    log('ERROR', 'could not hide panel', err && err.message);
  } finally {
    panelHideDepth = Math.max(0, panelHideDepth - 1);
    if (!capturing && captureWindows.size === 0 && (!win || win.isDestroyed() || !win.isVisible())) {
      setBubbleSuppressed(false);
    }
  }
}

function togglePanel() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) hidePanel();
  else showPanel();
}

async function showSettingsPanel() {
  await showPanel();
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('panel:open-settings'); }
  catch { /* panel closed while opening */ }
}

function createTray() {
  const icon = nativeImage.createFromBuffer(drawPadlock(16, !vault.locked));
  tray = new Tray(icon);
  tray.setToolTip('NextClip - encrypted clipboard history');
  tray.on('click', togglePanel);
  refreshTrayMenu();
}

/** Save before applying so a failed write never disagrees with the controls. */
function updateBubblePin(value) {
  const previous = settings;
  settings = { ...settings, bubblePinned: Boolean(value) };
  try {
    saveSettings();
  } catch (err) {
    settings = previous;
    log('ERROR', 'could not save bubble preference', err && err.message);
    refreshTrayMenu();
    if (win && !win.isDestroyed()) win.webContents.send('toast', 'Could not save bubble preference');
    return false;
  }
  setBubblePinned(settings.bubblePinned);
  refreshTrayMenu();
  pushState();
  return true;
}

function refreshTrayMenu() {
  if (!tray) return;
  // drawPadlock's second argument means an open shackle. Keep the icon in
  // sync whenever the vault changes state; the startup image otherwise stays
  // frozen for the lifetime of the tray.
  tray.setImage(nativeImage.createFromBuffer(drawPadlock(16, !vault.locked)));
  const count = vault.locked ? null : vault.stats().entries;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: vault.locked ? 'Unlock…' : `History (${count} items)`, click: showPanel },
    { label: `Take a screenshot (${settings.screenshotHotkey})`, click: () => {
      Promise.resolve(takeScreenshot()).catch((err) => {
        log('ERROR', 'screenshot failed', err && err.message);
        try { closeCaptureWindows(); } catch { /* already closed */ }
      });
    } },
    { type: 'separator' },
    { label: 'Lock now', click: () => lockVault(true) },
    { label: paused ? 'Resume capture' : 'Pause capture', click: () => setPaused(!paused) },
    { type: 'separator' },
    { label: 'Pin bubble on screen', type: 'checkbox', checked: settings.bubblePinned,
      click: (item) => updateBubblePin(item.checked) },
    { label: 'Settings', click: () => {
      Promise.resolve(showSettingsPanel()).catch((err) => log('ERROR', 'could not open settings', err));
    } },
    { label: 'Quit NextClip', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

/* ----------------------------------------------------------- vault state */

function setPaused(next) {
  paused = next;
  pushState();
  refreshTrayMenu();
}

function lockVault(announce) {
  if (!vault || vault.locked) return false;
  try {
    vault.lock();
  } catch (err) {
    log('ERROR', 'could not lock', err && err.message);
    // Avoid retrying on every clipboard poll when an auto-lock save fails.
    // The live key intentionally remains installed so unsaved clips are not
    // discarded, and the user must be told that the vault is still open.
    lastActivity = Date.now();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('toast', 'Could not lock because the vault could not be saved.'); }
      catch { /* panel closed while reporting */ }
    }
    return false;
  }
  try { if (loginStore) loginStore.noteLocked(sessionBootId); }
  catch (err) {
    log('ERROR', 'could not record lock', err.message);
    // Without the locked marker, an old same-boot session or remember token
    // could reopen the vault on restart. Forget both rather than weaken Lock.
    try { loginStore.forgetAll(); }
    catch (forgetErr) { log('ERROR', 'could not clear remembered login after lock failure', forgetErr.message); }
    scheduleRememberExpiry();
  }
  monitor?.reset();
  refreshTrayMenu();
  pushState();
  if (announce && win && !win.isDestroyed()) win.webContents.send('toast', 'Vault locked');
  return true;
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('vault:state', stateSnapshot());
  } catch (err) {
    log('ERROR', 'could not push state', err && err.message);
  }
}

function stateSnapshot() {
  return {
    hasVault: vault.hasVault(),
    locked: vault.locked,
    paused,
    stats: vault.locked ? { entries: 0, text: 0, images: 0, pinned: 0 } : vault.stats(),
    settings,
    hotkeyBound: Boolean(boundPanelHotkey) && boundPanelHotkey === settings.hotkey && globalShortcut.isRegistered(boundPanelHotkey),
    screenshotHotkeyBound: Boolean(boundShotHotkey) && boundShotHotkey === settings.screenshotHotkey && globalShortcut.isRegistered(boundShotHotkey),
    autoStartActive: autoStartActive(),
    packaged: app.isPackaged,
    undoAvailable: Boolean(undoState),
    rememberLogin: loginStore ? loginStore.status() : { active: false, days: 1 },
  };
}

/**
 * Register a shortcut, falling back through alternatives if it is already taken.
 * `avoid` holds accelerators this process just bound to something else.
 * Unregistering those (the old code did, whenever the two hotkeys matched)
 * silently steals the panel shortcut and leaves it doing screenshots.
 */
function registerWithFallback(primary, fallbacks, handler, avoid) {
  const seen = new Set();
  for (const candidate of [primary, ...fallbacks]) {
    if (!candidate || seen.has(candidate) || (avoid && avoid.has(candidate))) continue;
    seen.add(candidate);
    try {
      if (globalShortcut.register(candidate, handler)) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

let hotkeyQueue = Promise.resolve();

function registerHotkey() {
  const run = hotkeyQueue.then(() => registerHotkeyNow());
  hotkeyQueue = run.then(() => {}, () => {});
  return run;
}

async function registerHotkeyNow() {
  try {
  await bindHotkeys();
  } catch (err) {
    log('ERROR', 'hotkey registration failed', err && err.message);
  }
}

async function bindHotkeys() {
  globalShortcut.unregisterAll();
  const used = new Set();

  const bound = registerWithFallback(
    settings.hotkey,
    ['Control+Alt+V', 'Control+Shift+Space', 'CommandOrControl+Shift+V'],
    togglePanel,
    used,
  );
  if (bound) {
    used.add(bound);
    if (bound !== settings.hotkey) {
      settings.hotkey = bound;
      try { saveSettings(); }
      catch (err) {
        log('ERROR', 'could not save panel hotkey fallback', err && err.message);
        if (win && !win.isDestroyed()) win.webContents.send('toast', 'Could not save the fallback panel shortcut.');
      }
      if (win && !win.isDestroyed()) win.webContents.send('toast', `Panel hotkey was busy - using ${bound}`);
    }
  }

  const shotBound = registerWithFallback(
    settings.screenshotHotkey,
    ['Control+Alt+S', 'Control+Shift+P', 'CommandOrControl+Shift+S'],
    () => {
      Promise.resolve(takeScreenshot()).catch((err) => {
        log('ERROR', 'screenshot failed', err && err.message);
        try { closeCaptureWindows(); } catch { /* already closed */ }
      });
    },
    used,
  );
  if (shotBound) {
    used.add(shotBound);
    if (shotBound !== settings.screenshotHotkey) {
      settings.screenshotHotkey = shotBound;
      try { saveSettings(); }
      catch (err) {
        log('ERROR', 'could not save screenshot hotkey fallback', err && err.message);
        if (win && !win.isDestroyed()) win.webContents.send('toast', 'Could not save the fallback screenshot shortcut.');
      }
      if (win && !win.isDestroyed()) win.webContents.send('toast', `Screenshot hotkey was busy - using ${shotBound}`);
    }
  }

  boundPanelHotkey = bound || null;
  boundShotHotkey = shotBound || null;
  refreshTrayMenu();
  pushState();
}

/* --------------------------------------------------------- screenshots */

function screenshotDir() {
  if (settings.screenshotDir) return settings.screenshotDir;
  return path.join(app.getPath('pictures'), 'NextClip');
}

function timestampedName(extension) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `nextclip-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`;
}

function saveScreenshotUnique(dir, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const base = timestampedName('png');
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const name = suffix === 0 ? `${stem}${ext}` : `${stem}-${suffix}${ext}`;
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, buffer, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('could not find an unused screenshot filename');
}

function isCaptureWebContents(contents) {
  if (!contents) return false;
  let contentsId = null;
  try { contentsId = contents.id; } catch { return false; }
  for (const entry of captureWindows.values()) {
    const overlay = entry && entry.win;
    if (!overlay) continue;
    try {
      if (overlay.isDestroyed()) continue;
      const wc = overlay.webContents;
      if (wc === contents || wc.id === contentsId) return true;
    } catch {
      /* overlay is already going away */
    }
  }
  return false;
}

function focusCaptureOverlay(id, overlay) {
  if (!overlay || overlay.isDestroyed()) return;
  // Record the target before focus() returns. A sibling overlay blurs in
  // the same turn and its cancel must see this window as the focused one.
  focusedCaptureId = id;
  try { overlay.moveTop(); } catch { /* closing */ }
  try { overlay.focus(); } catch { /* closing */ }
  try {
    if (!overlay.isDestroyed()) overlay.webContents.focus();
  } catch { /* closing */ }
}

function overlayHasFocus(overlay) {
  if (!overlay || overlay.isDestroyed()) return false;
  try {
    return Boolean(overlay.isFocused() || overlay.webContents.isFocused());
  } catch {
    return false;
  }
}

// Ignore a blur-cancel from an overlay the user is not on, when another
// capture window is focused. Escape and a failed crop come from the focused
// window (or from the only window left) and must still release the lock.
function ignoreUnfocusedCaptureCancel(event) {
  const id = windowIdFromEvent(event);
  if (id == null || !captureWindows.has(id)) return false;
  const sender = captureWindows.get(id);
  const senderFocused = overlayHasFocus(sender.win);
  let otherFocused = false;
  for (const [otherId, other] of captureWindows) {
    if (otherId !== id && overlayHasFocus(other.win)) {
      otherFocused = true;
      break;
    }
  }
  if (focusedCaptureId != null && captureWindows.has(focusedCaptureId) && focusedCaptureId !== id) {
    if (senderFocused && !otherFocused) return false;
    return true;
  }
  if (senderFocused) return false;
  return otherFocused;
}

function noteExternalScreenshot() {
  try {
    if (monitor) monitor.noticeExternalClipboard();
  } catch (err) {
    log('ERROR', 'could not note screenshot clipboard', err);
  }
}

function toastCopiedScreenshot(size, savedTo) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('toast', savedTo
      ? `Captured ${size.width}×${size.height} — copied and saved`
      : `Captured ${size.width}×${size.height} — copied to clipboard`);
  } catch {
    /* panel gone */
  }
}

function toastCopyFailed() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('toast', 'Could not copy the screenshot'); }
  catch { /* panel gone */ }
}

// Stream the PNG to a helper process that calls clipboard.writeImage. The
// submit handler must not wait on that call: while another app holds the
// clipboard it blocks the main thread, and Escape cannot run.
function copyCaptureImage(buffer, onCopied) {
  setImmediate(() => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) {
        noteExternalScreenshot();
        if (onCopied) onCopied();
        return;
      }
      // Retrying on the main process recreates the freeze this helper exists
      // to avoid, especially when its failure was clipboard lock contention.
      toastCopyFailed();
    };

    let child;
    try {
      const args = app.isPackaged ? [] : [app.getAppPath()];
      child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          NEXTCLIP_CLIPBOARD_HELPER: '1',
        },
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch (err) {
      log('ERROR', 'could not start clipboard helper', err);
      finish(false);
      return;
    }
    child.once('error', (err) => {
      log('ERROR', 'clipboard helper failed', err);
      finish(false);
    });
    if (!child.stdin) {
      finish(false);
      return;
    }
    child.stdin.once('error', (err) => {
      log('ERROR', 'could not send screenshot to clipboard helper', err);
      finish(false);
    });
    child.stdin.end(buffer);
    child.once('exit', (code) => {
      if (code !== 0) log('ERROR', 'clipboard helper exited', String(code));
      finish(code === 0);
    });
  });
}

function closeCaptureWindows() {
  // Invalidate any delayed cleanup callback from this capture before a new
  // session can start.
  captureSessionId += 1;
  const entries = [...captureWindows.values()];
  captureWindows.clear();
  capturing = false;
  captureSubmitted = false;
  focusedCaptureId = null;
  for (const entry of entries) {
    try {
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
    } catch {
      /* already gone */
    }
  }
  try {
    if (!win || win.isDestroyed() || !win.isVisible()) setBubbleSuppressed(false);
  } catch {
    /* bubble already gone */
  }
}

/**
 * Freeze every display, then drop one selection overlay per display on top.
 * The screens are captured *before* the overlays exist, so they never show up
 * in the result.
 */
async function takeScreenshot() {
  if (capturing) return;
  capturing = true;
  captureSessionId += 1;
  const sessionId = captureSessionId;
  captureSubmitted = false;
  const shots = [];

  try {
  setBubbleSuppressed(true);
  // The global hotkey can be pressed while the panel is open. Hide it before
  // freezing displays so it cannot appear in the captured image.
  if (win && !win.isDestroyed() && win.isVisible()) {
    await hidePanel();
    if (win && !win.isDestroyed() && win.isVisible()) {
      fadeToken += 1;
      win.hide();
      win.setOpacity(1);
    }
  }
  const displays = screen.getAllDisplays();
  for (let displayIndex = 0; displayIndex < displays.length; displayIndex += 1) {
    const display = displays[displayIndex];
    if (captureSessionId !== sessionId || !capturing) return;
    const { width, height } = display.bounds;
    const scale = display.scaleFactor || 1;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      });
      if (captureSessionId !== sessionId || !capturing) return;
      const source = sources.find((s) => String(s.display_id) === String(display.id))
        || (displays.length === 1 ? sources[0] : sources[displayIndex]);
      if (source && !source.thumbnail.isEmpty()) {
        shots.push({ display, dataUrl: source.thumbnail.toDataURL() });
      }
    } catch (err) {
      if (captureSessionId !== sessionId || !capturing) return;
      console.error('[clipvault] screen capture failed:', err.message);
    }
  }

  if (captureSessionId !== sessionId || !capturing) return;
  if (!shots.length) {
    capturing = false;
    if (win && !win.isDestroyed()) win.webContents.send('toast', 'Could not capture the screen');
    if (!win || win.isDestroyed() || !win.isVisible()) setBubbleSuppressed(false);
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
      sessionId,
      display: shot.display,
      dataUrl: shot.dataUrl,
      cssWidth: shot.display.bounds.width,
      cssHeight: shot.display.bounds.height,
    });

    overlay.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      // Destroying the window aborts an in-flight load. That is not a failed page.
      if (errorCode === -3) return;
      const entry = captureWindows.get(id);
      if (!entry || entry.sessionId !== captureSessionId) return;
      log('ERROR', 'capture overlay failed to load', `${errorCode} ${errorDescription || ''}`.trim());
      closeCaptureWindows();
    });
    overlay.loadFile(path.join(__dirname, 'capture', 'index.html'));
    overlay.once('ready-to-show', () => {
      if (overlay.isDestroyed()) return;
      overlay.show();
      focusCaptureOverlay(id, overlay);
    });
    overlay.on('focus', () => { focusedCaptureId = id; });
    // If the last overlay goes away for any reason, release the capture lock
    // so the hotkey keeps working instead of silently doing nothing.
    overlay.on('closed', () => {
      if (focusedCaptureId === id) focusedCaptureId = null;
      captureWindows.delete(id);
      if (captureWindows.size === 0 && captureSessionId === sessionId) {
        capturing = false;
        captureSubmitted = false;
        captureSessionId += 1;
        try {
          if (!win || win.isDestroyed() || !win.isVisible()) setBubbleSuppressed(false);
        } catch {
          /* bubble already gone */
        }
      }
    });
  }
  } catch (err) {
    if (captureSessionId !== sessionId) return;
    log('ERROR', 'screenshot failed', err);
    closeCaptureWindows();
    if (win && !win.isDestroyed()) win.webContents.send('toast', 'Could not capture the screen');
  }
}

async function finishCapture(dataUrl, sessionId) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) return { ok: false, error: 'Could not read the captured region' };
  let buffer;
  try {
    buffer = Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
  } catch {
    return { ok: false, error: 'Could not read the captured region' };
  }
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return { ok: false, error: 'Could not read the captured region' };

  const size = image.getSize();
  let savedTo = null;

  if (settings.autoSaveScreenshots) {
    try {
      const dir = screenshotDir();
      savedTo = saveScreenshotUnique(dir, buffer);
    } catch (err) {
      console.error('[clipvault] could not save screenshot:', err.message);
    }
  }

  // Do not close the overlay here: the page still has to play its confirm
  // flash, and it closes itself (the timeout below is the backup). Schedule
  // that before the clipboard work so a throw cannot leave the lock stuck.
  setTimeout(() => {
    if (captureSessionId === sessionId) closeCaptureWindows();
  }, 320);

  // Same PNG as the file we just saved. writeImage runs in a helper so this
  // handler can return and capture:cancel is not stuck behind the clipboard.
  // Deliberately not suppressed as a self-copy; after the helper writes, we
  // notice the image so the monitor files it.
  copyCaptureImage(buffer, () => toastCopiedScreenshot(size, savedTo));
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
  ipcMain.handle('vault:create', (_e, passphrase, opts) => {
    const phrase = String(passphrase || '');
    try {
      vault.create(phrase);
    } catch (err) {
      return { ok: false, code: err.code || 'unknown', message: err.message };
    }
    acceptRemember(phrase, opts);
    lastActivity = Date.now();
    refreshTrayMenu();
    return { ok: true, state: stateSnapshot() };
  });

  ipcMain.handle('vault:unlock', (_e, passphrase, opts) => {
    const phrase = String(passphrase || '');
    try {
      vault.unlock(phrase);
    } catch (err) {
      return { ok: false, code: err.code || 'unknown', message: err.message };
    }
    acceptRemember(phrase, opts);
    lastActivity = Date.now();
    refreshTrayMenu();
    // Age out stale entries the moment the vault opens.
    setTimeout(() => runRetentionSweep(true), 800);
    return { ok: true, state: stateSnapshot() };
  });

  ipcMain.handle('vault:lock', () => {
    lockVault(false);
    return stateSnapshot();
  });

  ipcMain.handle('vault:list', () => {
    try {
      return vault.locked ? [] : vault.list();
    } catch (err) {
      log('ERROR', 'could not list history', err && err.message);
      return [];
    }
  });

  ipcMain.handle('vault:restore', (_e, id) => {
    try {
      return restoreToClipboard(id);
    } catch (err) {
      log('ERROR', 'restore failed', err && err.message);
      return { ok: false, error: 'Could not restore that item.' };
    }
  });

  /** Remember the current history so the next destructive action can be undone. */
function stageUndo(label, ids = null) {
  if (!vault || vault.locked) return false;
  let snapshot = vault.snapshot();
  if (!snapshot) return false;
  if (ids) {
    const wanted = new Set(ids.map((id) => String(id)));
    snapshot = snapshot.filter((entry) => wanted.has(entry.id));
  }
  if (!snapshot.length) return false;
  undoState = { label, snapshot, at: Date.now() };
  return true;
}

ipcMain.handle('vault:remove', (_e, id) => {
    try {
      if (vault.locked) return { ok: false, error: 'Vault is locked.' };
      const key = String(id);
      if (!vault.entries.some((entry) => entry.id === key)) return { ok: false };
      stageUndo('Deleted 1 item', [key]);
      const ok = vault.remove(key);
      pushState();
      refreshTrayMenu();
      return { ok, undo: Boolean(undoState) };
    } catch (err) {
      log('ERROR', 'could not remove item', err && err.message);
      return { ok: false, error: 'Could not remove that item.' };
    }
  });

  ipcMain.handle('vault:pin', (_e, id) => {
    try {
      const pinned = vault.togglePin(String(id));
      pushState();
      return pinned;
    } catch (err) {
      log('ERROR', 'could not pin item', err && err.message);
      return false;
    }
  });

  ipcMain.handle('vault:clear', () => {
    try {
      if (vault.locked) return { ok: false, removed: 0, error: 'Vault is locked.' };
      const removed = vault.entries.length;
      if (!removed) return { ok: true, removed: 0, undo: false };
      stageUndo('History cleared');
      vault.clearAll();
      pushState();
      refreshTrayMenu();
      return { ok: true, removed, undo: Boolean(undoState) };
    } catch (err) {
      log('ERROR', 'could not clear history', err && err.message);
      return { ok: false, removed: 0, error: 'Could not clear history.' };
    }
  });

  ipcMain.handle('vault:undo', () => {
    try {
      if (!undoState) return { ok: false };
      // Locking flushes the deletion. Consuming the snapshot while locked
      // drops the only copy of the deleted rows without writing them back.
      if (vault.locked) return { ok: false, error: 'Unlock the vault to undo.' };
      const count = vault.restoreSnapshot(undoState.snapshot);
      const label = undoState.label;
      undoState = null;
      pushState();
      refreshTrayMenu();
      if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('vault:changed');
      return { ok: count > 0, count, label };
    } catch (err) {
      log('ERROR', 'could not undo', err && err.message);
      return { ok: false, error: 'Could not undo that change.' };
    }
  });

  ipcMain.handle('vault:changePassphrase', (_e, current, next) => {
    try {
      // unlock() verifies the sentinel without reloading entries when already
      // open, so require the current phrase in both locked and unlocked states.
      vault.unlock(String(current));
      const nextPhrase = String(next);
      vault.changePassphrase(nextPhrase, {
        fingerprintImage(png) {
          const image = nativeImage.createFromBuffer(png);
          return image.isEmpty() ? null : image.toBitmap();
        },
      });
      // Undo snapshots are sealed with the previous key. Putting them back
      // after a rekey stores blobs the new key cannot open.
      undoState = null;
      try { if (loginStore) loginStore.invalidatePassphrase(nextPhrase, sessionBootId); }
      catch (err) { log('ERROR', 'could not invalidate remembered login', err.message); }
      scheduleRememberExpiry();
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

  ipcMain.handle('settings:save', async (_e, patch) => {
    const previousSettings = settings;
    const wasHotkey = settings.hotkey;
    const wasShot = settings.screenshotHotkey;
    const wasAutoStart = settings.autoStart;
    const wasMax = Number(settings.maxEntries);
    const wasRetention = Number(settings.retentionHours);
    settings = sanitizeSettings({ ...settings, ...(patch || {}) });
    try {
      saveSettings();
    } catch (err) {
      settings = previousSettings;
      log('ERROR', 'could not save settings', err && err.message);
      throw err;
    }
    if (settings.hotkey !== wasHotkey || settings.screenshotHotkey !== wasShot) {
      try { await registerHotkey(); }
      catch (err) { log('ERROR', 'hotkey registration failed', err && err.message); }
    }
    if (Boolean(settings.autoStart) !== Boolean(wasAutoStart)) {
      try { applyAutoStart(); }
      catch (err) { log('ERROR', 'could not update auto-start', err && err.message); }
    }
    if (vault && !vault.locked) {
      try {
        if (Number(settings.maxEntries) !== wasMax) vault.trim(settings.maxEntries);
        if (Number(settings.retentionHours) !== wasRetention) runRetentionSweep(false);
      } catch (err) {
        log('ERROR', 'could not apply history settings', err && err.message);
      }
    }
    setBubblePinned(settings.bubblePinned);
    refreshTrayMenu();
    pushState();
    return settings;
  });

  ipcMain.handle('bubble:toggle', () => {
    togglePanel();
    return true;
  });

  ipcMain.handle('bubble:unpin', () => ({
    ok: updateBubblePin(false),
    pinned: settings.bubblePinned,
  }));

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
    Promise.resolve(takeScreenshot()).catch((err) => {
      log('ERROR', 'screenshot failed', err && err.message);
      try { closeCaptureWindows(); } catch { /* already closed */ }
    });
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
    const entry = captureWindows.get(id);
    if (!entry || entry.sessionId !== captureSessionId) return { ok: false, error: 'capture expired' };
    // Every display has an overlay, but the session represents one region
    // capture. Claim it synchronously so two overlays cannot both save/copy
    // before the close timer tears the other windows down.
    if (captureSubmitted) return { ok: false, error: 'capture already submitted' };
    captureSubmitted = true;
    return finishCapture(String(dataUrl || ''), entry.sessionId);
  });

  ipcMain.handle('capture:cancel', (event) => {
    const id = windowIdFromEvent(event);
    const entry = captureWindows.get(id);
    if (!entry || entry.sessionId !== captureSessionId) return false;
    if (ignoreUnfocusedCaptureCancel(event)) {
      // Reject so the overlay stays able to cancel for real. Resolving would
      // mark that page closed while its window is still up.
      return Promise.reject(new Error('capture-cancel-ignored'));
    }
    closeCaptureWindows();
    return true;
  });

  /* ------------------------------------------------- save an image entry */

  ipcMain.handle('vault:saveImage', async (_e, id) => {
    try {
      const payload = vault.payload(String(id));
      if (!payload || payload.type !== 'image') return { ok: false, error: 'Not an image entry' };
      const encoded = String(payload.dataUrl || '').split(',')[1];
      if (!encoded) return { ok: false, error: 'Not an image entry' };
      const buffer = Buffer.from(encoded, 'base64');

      const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
        title: 'Save image',
        defaultPath: path.join(app.getPath('pictures'), timestampedName('png')),
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };

      fs.writeFileSync(result.filePath, buffer);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openScreenshotDir', async () => {
    try {
      const dir = screenshotDir();
      fs.mkdirSync(dir, { recursive: true });
      const error = await shell.openPath(dir);
      if (error) throw new Error(error);
      return dir;
    } catch (err) {
      log('ERROR', 'could not open screenshot folder', err && err.message);
      return null;
    }
  });

  ipcMain.handle('shell:openVaultFile', () => {
    try {
      const file = userDataFile('vault.json');
      shell.showItemInFolder(file);
      return file;
    } catch (err) {
      log('ERROR', 'could not show vault file', err && err.message);
      return null;
    }
  });
}

/* ----------------------------------------------------------- boot prompt */

function openLoginStore() {
  return new LoginStore(app.getPath('userData'), {
    available() {
      try { return safeStorage.isEncryptionAvailable(); }
      catch { return false; }
    },
    encrypt(plain) {
      return safeStorage.encryptString(String(plain));
    },
    decrypt(buffer) {
      return safeStorage.decryptString(buffer);
    },
  });
}

function acceptRemember(passphrase, opts) {
  if (!loginStore || !passphrase) return;
  try {
    const result = loginStore.applyUnlock({
      enabled: Boolean(opts && opts.enabled),
      days: opts && opts.days,
      passphrase,
      bootId: sessionBootId,
      now: Date.now(),
    });
    scheduleRememberExpiry();
    if (opts && opts.enabled && result && result.unavailable && win && !win.isDestroyed()) {
      win.webContents.send('toast', 'Could not store the remembered login on this device.');
    }
  } catch (err) {
    log('ERROR', 'could not update remembered login', err.message);
    if (win && !win.isDestroyed()) {
      win.webContents.send('toast', 'Could not update the remembered login on this device.');
    }
  }
}

function scheduleRememberExpiry() {
  if (rememberExpiryTimer) clearTimeout(rememberExpiryTimer);
  rememberExpiryTimer = null;
  if (!loginStore) return;
  const expiresAt = loginStore.expiryAt();
  if (expiresAt === null) return;

  rememberExpiryTimer = setTimeout(() => {
    rememberExpiryTimer = null;
    if (loginStore.status().active) {
      // The clock moved back or the timer fired slightly early; recompute from
      // the same stored deadline instead of expiring the login prematurely.
      scheduleRememberExpiry();
      return;
    }
    try {
      loginStore.clearRemember();
      pushState();
      log('INFO', 'remembered login expired');
    } catch (err) {
      log('ERROR', 'could not clear expired remembered login', err.message);
    }
  }, Math.max(0, expiresAt - Date.now()));
}

function showBootPanel() {
  if (!win || win.isDestroyed()) return;
  let opened = false;
  const open = () => {
    if (opened || !win || win.isDestroyed()) return;
    opened = true;
    showPanel();
  };
  if (!win.webContents.isLoading()) {
    open();
    return;
  }
  win.webContents.once('did-finish-load', open);
  if (!win.webContents.isLoading()) {
    win.webContents.removeListener('did-finish-load', open);
    open();
  }
}

async function applyBootUnlock() {
  const boot = await queryWindowsBootId();
  const previous = loginStore.readBootMarker();
  sessionBootId = boot.id || null;
  if (!sessionBootId) {
    log('WARN', 'could not read the Windows boot id; a restart will ask for the passphrase unless remember-me is still valid');
  } else {
    log('INFO', `boot id source=${boot.source}`);
  }

  if (!vault.hasVault()) {
    try { loginStore.forgetAll(); }
    catch (err) { log('ERROR', 'could not clear remembered login', err.message); }
    scheduleRememberExpiry();
    if (!sessionBootId || previous !== sessionBootId) showBootPanel();
    else setBubbleSuppressed(false);
    try { if (sessionBootId) loginStore.writeBootMarker(sessionBootId); }
    catch (err) { log('ERROR', 'could not store boot id', err.message); }
    return;
  }

  const now = Date.now();
  let remember = null;
  let session = null;
  try {
    remember = loginStore.loadRemember(now);
    session = loginStore.loadSession();
  } catch (err) {
    log('ERROR', 'could not read remembered login', err.message);
  }

  const decision = decideStartup({
    bootId: sessionBootId,
    previousBootId: previous,
    now,
    remember,
    session,
  });
  log('INFO', `boot policy ${decision.reason}`);

  try {
    if (decision.clearRemember) loginStore.clearRemember();
    if (decision.clearSession) loginStore.clearSession();
  } catch (err) {
    log('ERROR', 'could not clear remembered login', err.message);
  }
  scheduleRememberExpiry();
  pushState();

  if (decision.action === 'unlock' && decision.passphrase) {
    try {
      vault.unlock(decision.passphrase);
    } catch (err) {
      log('WARN', 'startup unlock failed', err && err.code ? err.code : 'error');
      try { loginStore.forgetAll(); } catch { /* still show the prompt */ }
      scheduleRememberExpiry();
      pushState();
      showBootPanel();
      if (sessionBootId) loginStore.writeBootMarker(sessionBootId);
      return;
    }
    lastActivity = Date.now();
    try {
      loginStore.noteRunningUnlocked({
        bootId: sessionBootId,
        passphrase: decision.passphrase,
        viaRemember: decision.reason === 'remember-me',
      });
    } catch (err) {
      log('ERROR', 'could not refresh the boot session', err.message);
    }
    refreshTrayMenu();
    pushState();
    setTimeout(() => runRetentionSweep(true), 800);
    setBubbleSuppressed(false);
    log('INFO', `unlocked on startup (${decision.reason})`);
  } else if (decision.showPanel) {
    showBootPanel();
  } else {
    setBubbleSuppressed(false);
  }

  if (sessionBootId) {
    try { loginStore.writeBootMarker(sessionBootId); }
    catch (err) { log('ERROR', 'could not store boot id', err.message); }
  }
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

  app.whenReady().then(async () => {
    installCrashHandlers();
    loadSettings();
    vault = new Vault(userDataFile('vault.json'));
    loginStore = openLoginStore();
    registerIpc();
    createWindow();
    try {
      setBubblePinned(settings.bubblePinned);
      const bubble = createBubbleWindow();
      // The panel is still hidden here. Show the bubble now; showPanel hides
      // it only while the panel is actually on screen.
      setBubbleSuppressed(false);
      const reportBubble = () => {
        if (!bubble || bubble.isDestroyed()) return;
        try {
          const bounds = bubble.getBounds();
          log('INFO', `bubble visible=${bubble.isVisible()} bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
        } catch (err) {
          log('ERROR', 'bubble status failed', err.message);
        }
      };
      if (bubble.webContents.isLoading()) bubble.once('ready-to-show', reportBubble);
      else reportBubble();
      log('INFO', 'bubble window created');
    } catch (err) {
      log('ERROR', 'bubble window failed', err.message);
    }
    createTray();
    applyAutoStart();
    monitor = new Monitor({
      clipboard,
      vault,
      getSettings: () => settings,
      isPaused: () => paused,
    });

    pollTimer = setInterval(() => {
      try {
        tick();
        checkAutoLock();
      } catch (err) {
        log('ERROR', 'clipboard poll failed', err && err.message);
      }
    }, POLL_MS);

    // Retention sweep: once shortly after unlock, then hourly.
    pruneTimer = setInterval(() => {
      try { runRetentionSweep(false); }
      catch (err) { log('ERROR', 'retention sweep failed', err && err.message); }
    }, 60 * 60_000);

    app.on('activate', () => showPanel());
    try { await registerHotkey(); }
    catch (err) { log('ERROR', 'hotkey registration failed', err.message); }
    try { await applyBootUnlock(); }
    catch (err) { log('ERROR', 'boot unlock failed', err.message); }
    if (!win || win.isDestroyed() || !win.isVisible()) setBubbleSuppressed(false);
    const snap = bubbleSnapshot();
    if (snap) {
      log('INFO', `bubble settled visible=${snap.visible} bounds=${snap.x},${snap.y} ${snap.width}x${snap.height} panelVisible=${Boolean(win && !win.isDestroyed() && win.isVisible())}`);
    }
  });

  app.on('window-all-closed', (event) => {
    event?.preventDefault?.();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    try {
      if (vault && !vault.locked) vault.flush();
    } catch (err) {
      log('ERROR', 'could not flush vault', err && err.message);
    }
    clearInterval(pollTimer);
    clearInterval(pruneTimer);
    if (rememberExpiryTimer) clearTimeout(rememberExpiryTimer);
    try { destroyBubble(); } catch { /* already gone */ }
    try { closeCaptureWindows(); } catch { /* already gone */ }
    try { globalShortcut.unregisterAll(); } catch { /* already clear */ }
  });
}
