'use strict';

/**
 * Small always-on-top bubble at the bottom-right of the work area.
 * The window is a few pixels larger than the disc so the anti-aliased rim
 * is not clipped by the window edge. The panel stays a separate window.
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const DISC = 40;
const PAD = 6;
const SIZE = DISC + PAD * 2;
const MARGIN = 12;

let bubble = null;
let pinned = true;
let suppressed = false;
let allowClose = false;
let screenWatching = false;

function positionBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  // Place the visible disc MARGIN from the work area. The extra PAD is
  // transparent room for the anti-aliased edge.
  const x = Math.round(area.x + area.width - MARGIN - DISC - PAD);
  const y = Math.round(area.y + area.height - MARGIN - DISC - PAD);
  bubble.setBounds({ x, y, width: SIZE, height: SIZE }, false);
}

function applyBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  if (!pinned || suppressed) {
    if (bubble.isVisible()) bubble.hide();
    return;
  }
  positionBubble();
  bubble.setAlwaysOnTop(true, 'floating');
  // showInactive leaves a transparent window hidden on Windows. show() maps
  // it; blur so the bubble does not take the keyboard from the user's app.
  if (!bubble.isVisible()) {
    try { bubble.show(); } catch { /* already closing */ }
    try { bubble.blur(); } catch { /* already closing */ }
    if (!bubble.isVisible()) {
      try { bubble.showInactive(); } catch { /* already closing */ }
    }
  }
  positionBubble();
}

function createBubbleWindow() {
  if (bubble && !bubble.isDestroyed()) return bubble;
  allowClose = false;
  bubble = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    frame: false,
    // Per-pixel alpha. A binary setShape region stair-steps the rim, and an
    // opaque window leaves black corners outside the circle.
    transparent: true,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    backgroundMaterial: 'none',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: 'NextClip',
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  bubble.setSkipTaskbar(true);
  bubble.setAlwaysOnTop(true, 'floating');
  try { bubble.setBackgroundColor('#00000000'); } catch { /* already transparent */ }
  try { bubble.setBackgroundMaterial('none'); } catch { /* best effort */ }
  try { bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }); } catch { /* best effort */ }
  bubble.setMenu(null);
  bubble.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bubble.webContents.on('will-navigate', (event) => event.preventDefault());
  bubble.once('ready-to-show', () => applyBubble());
  bubble.webContents.on('did-finish-load', () => applyBubble());
  bubble.webContents.on('did-fail-load', () => applyBubble());
  bubble.loadFile(path.join(__dirname, 'bubble', 'index.html'));
  bubble.on('close', (event) => {
    if (allowClose || !bubble || bubble.isDestroyed()) return;
    event.preventDefault();
    try { bubble.hide(); } catch { /* already closing */ }
  });

  positionBubble();
  if (!screenWatching) {
    screenWatching = true;
    const move = () => {
      try {
        positionBubble();
        applyBubble();
      } catch {
        /* a display change can arrive while the window is going away */
      }
    };
    screen.on('display-metrics-changed', move);
    screen.on('display-added', move);
    screen.on('display-removed', move);
  }
  return bubble;
}

/** Hide while the panel is open; show again when it is not. */
function setBubbleSuppressed(panelOpen) {
  suppressed = Boolean(panelOpen);
  applyBubble();
}

/** User preference, independent of the panel/capture's temporary suppression. */
function setBubblePinned(value) {
  pinned = Boolean(value);
  applyBubble();
}

function bubbleSnapshot() {
  if (!bubble || bubble.isDestroyed()) return null;
  const bounds = bubble.getBounds();
  return {
    visible: bubble.isVisible(),
    pinned,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function destroyBubble() {
  allowClose = true;
  suppressed = true;
  if (bubble && !bubble.isDestroyed()) bubble.destroy();
  bubble = null;
}

module.exports = {
  createBubbleWindow,
  setBubbleSuppressed,
  setBubblePinned,
  destroyBubble,
  positionBubble,
  bubbleSnapshot,
};
