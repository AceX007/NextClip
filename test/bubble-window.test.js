'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 5).join('\n       ')}`);
    process.exitCode = 1;
  }
}

// Load a fresh module for each test, without launching Electron or touching
// the user's clipboard, settings, or desktop windows.
function fixture() {
  const windows = [];
  const screen = new EventEmitter();
  screen.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  screen.getPrimaryDisplay = () => ({ workArea: screen.workArea });

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.showCalls = 0;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; this.showCalls += 1; }
    showInactive() { this.visible = true; this.showCalls += 1; }
    hide() { this.visible = false; }
    blur() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    setBackgroundColor() {}
    setBackgroundMaterial() {}
    setVisibleOnAllWorkspaces() {}
    setMenu() {}
    loadFile() { return Promise.resolve(); }
  }

  const filename = path.join(__dirname, '..', 'src', 'bubble-window.js');
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(filename),
    require(name) {
      if (name === 'electron') return { BrowserWindow, screen };
      if (name === 'path') return path;
      throw new Error(`Unexpected bubble-window dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { api: context.module.exports, windows, screen };
}

function ready(window) {
  window.emit('ready-to-show');
  window.webContents.emit('did-finish-load');
}

function assertState(api, { pinned, visible }) {
  const state = api.bubbleSnapshot();
  assert.ok(state, 'a live bubble has a snapshot');
  assert.strictEqual(state.pinned, pinned, 'snapshot reports the pin preference');
  assert.strictEqual(state.visible, visible, 'window visibility matches the pin and panel state');
}

function reapplyEvents(window, screen) {
  window.emit('ready-to-show');
  window.webContents.emit('did-finish-load');
  window.webContents.emit('did-fail-load');
  screen.emit('display-metrics-changed');
  screen.emit('display-added');
  screen.emit('display-removed');
}

console.log('clipvault bubble visibility');

test('starts pinned and visible after the window is ready', () => {
  const { api } = fixture();
  const window = api.createBubbleWindow();
  ready(window);
  assertState(api, { pinned: true, visible: true });
});

test('unpin hides immediately and closing the panel cannot restore it', () => {
  const { api } = fixture();
  ready(api.createBubbleWindow());
  api.setBubblePinned(false);
  assertState(api, { pinned: false, visible: false });
  api.setBubbleSuppressed(true);
  api.setBubbleSuppressed(false);
  assertState(api, { pinned: false, visible: false });
  api.setBubblePinned(true);
  assertState(api, { pinned: true, visible: true });
});

test('repinning while the panel is open waits until the panel closes', () => {
  const { api } = fixture();
  ready(api.createBubbleWindow());
  api.setBubbleSuppressed(true);
  assertState(api, { pinned: true, visible: false });
  api.setBubblePinned(false);
  api.setBubblePinned(true);
  assertState(api, { pinned: true, visible: false });
  api.setBubbleSuppressed(false);
  assertState(api, { pinned: true, visible: true });
});

test('an unpinned startup never flashes the bubble during load or display events', () => {
  const { api, screen } = fixture();
  api.setBubblePinned(false);
  const window = api.createBubbleWindow();
  reapplyEvents(window, screen);
  assertState(api, { pinned: false, visible: false });
  assert.strictEqual(window.showCalls, 0, 'loading must not briefly show an unpinned bubble');
});

test('load and display changes do not reveal a bubble suppressed by the panel', () => {
  const { api, screen } = fixture();
  api.setBubbleSuppressed(true);
  const window = api.createBubbleWindow();
  reapplyEvents(window, screen);
  assertState(api, { pinned: true, visible: false });
  assert.strictEqual(window.showCalls, 0, 'loading must not show the bubble over the panel');
  api.setBubbleSuppressed(false);
  assertState(api, { pinned: true, visible: true });
});

test('repinning uses the latest display position after a hidden display change', () => {
  const { api, screen } = fixture();
  const window = api.createBubbleWindow();
  ready(window);
  const before = api.bubbleSnapshot();
  api.setBubblePinned(false);
  screen.workArea = { ...screen.workArea, x: 400, y: 100 };
  screen.emit('display-metrics-changed');
  assertState(api, { pinned: false, visible: false });
  api.setBubblePinned(true);
  const after = api.bubbleSnapshot();
  assertState(api, { pinned: true, visible: true });
  assert.strictEqual(after.x, before.x + 400);
  assert.strictEqual(after.y, before.y + 100);
});

test('the window has no native context-menu dependency', () => {
  const { api } = fixture();
  const window = api.createBubbleWindow();
  ready(window);
  assert.strictEqual(window.webContents.listenerCount('context-menu'), 0,
    'the renderer handles a bubble right-click through explicit IPC');
  assertState(api, { pinned: true, visible: true });
});

test('destroy clears the snapshot and a recreated bubble retains its pin preference', () => {
  const { api, windows, screen } = fixture();
  const first = api.createBubbleWindow();
  ready(first);
  api.setBubblePinned(false);
  api.destroyBubble();
  assert.strictEqual(first.isDestroyed(), true);
  assert.strictEqual(api.bubbleSnapshot(), null);
  const second = api.createBubbleWindow();
  assert.notStrictEqual(first, second);
  reapplyEvents(second, screen);
  assertState(api, { pinned: false, visible: false });
  api.setBubbleSuppressed(false);
  api.setBubblePinned(true);
  assertState(api, { pinned: true, visible: true });
  assert.strictEqual(windows.length, 2);
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    assert.strictEqual(screen.listenerCount(event), 1, 'recreation does not duplicate display listeners');
  }
});

test('destroy suppresses a pinned replacement until the owner allows it to show', () => {
  const { api, screen } = fixture();
  ready(api.createBubbleWindow());
  api.destroyBubble();
  assert.doesNotThrow(() => screen.emit('display-metrics-changed'));
  const replacement = api.createBubbleWindow();
  reapplyEvents(replacement, screen);
  assertState(api, { pinned: true, visible: false });
  api.setBubbleSuppressed(false);
  assertState(api, { pinned: true, visible: true });
});

if (process.exitCode) console.error(`\n${passed} passed, failures above`);
else console.log(`\n${passed} passed`);
