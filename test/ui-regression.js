'use strict';

/**
 * Isolated renderer regression harness. Run with the project's Electron binary.
 * Only the production HTML/CSS/renderer JS are loaded. All bridge calls operate
 * on fixtures below, and runtime files go to a separate temporary profile.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

const artifacts = process.env.CLIPVAULT_UI_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nextclip-ui-'));
const renderer = process.env.CLIPVAULT_RENDERER || path.join(__dirname, '..', 'src', 'renderer', 'index.html');
fs.mkdirSync(artifacts, { recursive: true });
const logFile = path.join(artifacts, 'ui-test.log');
fs.writeFileSync(logFile, 'Isolated renderer harness started\n');
const log = (message) => fs.appendFileSync(logFile, `${message}\n`);
// GUI Electron can outlive the shell pipe. Never let a closed stdout produce an
// OS error dialog, and do not depend on a terminal for durable test results.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (error) => { log(error.stack || String(error)); app.exit(1); });
process.on('unhandledRejection', (error) => { log(error.stack || String(error)); app.exit(1); });
app.setPath('userData', path.join(artifacts, 'isolated-electron-profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const clone = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
let mock;
let passed = 0;
const failures = [];
const rendererErrors = [];
let fixtureThumb;

function defaultSettings() {
  return {
    hotkey: 'Control+Shift+V', screenshotHotkey: 'Control+Shift+S',
    maxEntries: 300, autoLockMinutes: 15, retentionHours: 72,
    density: 'comfortable', hideOnBlur: false, hideOnRestore: false,
    bubblePinned: true, autoStart: false, captureImages: true, autoSaveScreenshots: false,
  };
}

function fixtures() {
  const now = Date.now();
  return [
    { id: 'release', type: 'text', text: 'Release notes\nPolish the panel and ship the black theme.', ts: now - 35_000, pinned: false },
    { id: 'image', type: 'image', width: 1920, height: 1080, thumb: fixtureThumb, ts: now - 230_000, pinned: true },
    { id: 'link', type: 'text', text: 'https://example.com/design-system/clipboard', ts: now - 1_800_000, pinned: false },
    { id: 'snippet', type: 'text', text: 'const theme = "black";\nconst safe = a < b && b > c;', ts: now - 4_200_000, pinned: true },
    { id: 'unicode', type: 'text', text: 'Meeting notes — Добрий вечір 👋\nReview spacing, keyboard focus, and empty states.', ts: now - 12_000_000, pinned: false },
    { id: 'long', type: 'text', text: 'A_long_unbroken_fixture_value_'.repeat(12), ts: now - 28_000_000, pinned: false },
  ];
}

function snapshot() {
  const rows = mock.locked ? [] : mock.rows;
  return {
    hasVault: mock.hasVault, locked: mock.locked, paused: mock.paused,
    settings: clone(mock.settings),
    stats: { entries: rows.length, images: rows.filter((r) => r.type === 'image').length, pinned: rows.filter((r) => r.pinned).length },
    autoStartActive: false, packaged: true, hotkeyBound: true, screenshotHotkeyBound: true,
    rememberLogin: { active: false, days: 1 },
  };
}

function reset({ locked = false, fresh = false, empty = false, density = 'comfortable' } = {}) {
  mock = {
    hasVault: !fresh, locked: locked || fresh, paused: false,
    rows: empty ? [] : fixtures(), settings: { ...defaultSettings(), density },
    undo: null, calls: [],
  };
}

ipcMain.handle('ui-test:call', async (_event, method, args) => {
  mock.calls.push({ method, args: clone(args) });
  switch (method) {
    case 'status': return snapshot();
    case 'list': return clone(mock.locked ? [] : mock.rows);
    case 'create':
    case 'unlock': {
      if (String(args[0]).length < 6) return { ok: false, code: 'weak' };
      if (method === 'unlock' && args[0] !== 'fixture-pass') return { ok: false, code: 'badpass' };
      mock.hasVault = true;
      mock.locked = false;
      return { ok: true, state: snapshot() };
    }
    case 'lock': mock.locked = true; return { ok: true };
    case 'restore': return { ok: !mock.locked && mock.rows.some((r) => r.id === args[0]) };
    case 'remove': {
      const target = mock.rows.find((r) => r.id === args[0]);
      if (!target || mock.locked) return { ok: false };
      mock.undo = clone(mock.rows);
      mock.rows = mock.rows.filter((r) => r.id !== args[0]);
      return { ok: true, undo: true };
    }
    case 'pin': {
      const target = mock.rows.find((r) => r.id === args[0]);
      if (!target || mock.locked) return false;
      target.pinned = !target.pinned;
      return target.pinned;
    }
    case 'clear': {
      mock.undo = clone(mock.rows);
      const removed = mock.rows.length;
      mock.rows = [];
      return { ok: true, removed, undo: true };
    }
    case 'undo': {
      if (!mock.undo) return { ok: false };
      const count = mock.undo.length - mock.rows.length;
      mock.rows = mock.undo;
      mock.undo = null;
      return { ok: true, count };
    }
    case 'setPaused': mock.paused = Boolean(args[0]); return snapshot();
    case 'saveSettings': Object.assign(mock.settings, args[0]); return clone(mock.settings);
    case 'changePassphrase': return { ok: !mock.locked, code: mock.locked ? 'locked' : undefined };
    case 'saveImage': return { canceled: true };
    case 'openScreenshotDir': return 'C:\\fixture-only\\screenshots';
    case 'activity':
    case 'hide':
    case 'quit':
    case 'screenshot':
    case 'revealVaultFile': return { ok: true };
    default: throw new Error(`Unhandled mock bridge method: ${method}`);
  }
});

const evaluate = (source) => win.webContents.executeJavaScript(source, true);
const countCalls = (method) => mock.calls.filter((call) => call.method === method).length;
async function until(source, label, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(source)) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function settle() { await delay(85); }

async function scene(options = {}, width = 440, height = 640) {
  reset(options);
  win.setContentSize(width, height);
  await win.loadFile(renderer);
  await until(`!document.getElementById('${mock.locked ? 'lockScreen' : 'historyScreen'}').classList.contains('hidden')`, 'scene ready');
  if (!mock.locked) await until(`document.querySelectorAll('#list .row').length === ${mock.rows.length}`, 'history rendered');
  await delay(320);
}

async function fill(selector, value) {
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
}

async function hit(selector, button = 'left') {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
  await settle();
  // Move to the row first so hover-only action hit targets become interactive.
  const rect = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), width:r.width, height:r.height}; })()`);
  assert.ok(rect.width > 0 && rect.height > 0, `${selector} has a visible hit target`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  await delay(170);
  const top = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}), hit=document.elementFromPoint(${rect.x},${rect.y}); return !!hit && (hit===e || e.contains(hit)); })()`);
  assert.ok(top, `${selector} is the element at its click center`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button, clickCount: 1 });
  await settle();
}

async function key(keyCode) {
  // DevTools input dispatch works in an offscreen window and retains Chromium's
  // real default button activation. DOM KeyboardEvent has no default action.
  const virtual = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[keyCode];
  const event = { key: keyCode, code: keyCode, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual };
  if (keyCode === 'Enter') Object.assign(event, { text: '\r', unmodifiedText: '\r' });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: '', unmodifiedText: '' });
  await settle();
}

async function screenshot(name) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
  await delay(260);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(artifacts, `${name}.png`), image.toPNG());
}

async function check(name, run) {
  try {
    await run();
    passed++;
    log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: error.stack });
    log(`FAIL ${name}\n${error.stack}`);
    await screenshot(`failure-${failures.length}`).catch(() => {});
  }
}

async function noOverflow(label) {
  const result = await evaluate(`(() => {
    const selectors = ['html', 'body', '#historyScreen', '#list', '#settingsScreen', '.settings-scroll', '#lockScreen'];
    return selectors.map(s => { const e=document.querySelector(s); if(!e || !e.getClientRects().length) return null; return {selector:s, client:e.clientWidth, scroll:e.scrollWidth}; }).filter(Boolean);
  })()`);
  for (const item of result) assert.ok(item.scroll <= item.client + 1, `${label}: ${item.selector} horizontal overflow ${item.scroll}/${item.client}`);
}

async function darkSurfaces() {
  const result = await evaluate(`(() => {
    const selectors = ['body', '.card', '#search', '#passInput', '#setDensity', '#rowMenu', '#toast'];
    return { scheme:getComputedStyle(document.documentElement).colorScheme, colors:selectors.map(s => { const e=document.querySelector(s); return {selector:s, color:getComputedStyle(e).backgroundColor}; }) };
  })()`);
  assert.ok(result.scheme.includes('dark'), `native controls use dark color-scheme (${result.scheme})`);
  for (const item of result.colors) {
    const channels = item.color.match(/[\d.]+/g).map(Number);
    if (channels.length === 4 && channels[3] === 0) continue;
    assert.ok(Math.max(...channels.slice(0, 3)) <= 32, `${item.selector} has black/neutral-dark surface: ${item.color}`);
    assert.ok(Math.max(...channels.slice(0, 3)) - Math.min(...channels.slice(0, 3)) <= 2, `${item.selector} uses neutral black: ${item.color}`);
  }
}

app.whenReady().then(async () => {
  // A small landscape fixture, generated in memory with Electron only.
  const pixels = Buffer.alloc(96 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
    const i = (y * 96 + x) * 4;
    const sky = y < 34 - Math.sin(x / 13) * 10;
    pixels[i] = sky ? 172 + y : 92 + x;
    pixels[i + 1] = sky ? 112 + y : 60 + y;
    pixels[i + 2] = sky ? 52 + x : 31 + y;
    pixels[i + 3] = 255;
  }
  fixtureThumb = nativeImage.createFromBitmap(pixels, { width: 96, height: 64 }).toDataURL();
  win = new BrowserWindow({
    width: 440, height: 640, useContentSize: true, frame: false, show: false,
    backgroundColor: '#070707', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ui-mock-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.debugger.attach('1.3');
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) rendererErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer gone: ${details.reason}`));

  await check('history fixtures, black surfaces, and 440×640 layout', async () => {
    await scene();
    assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), 6);
    assert.equal(await evaluate("document.querySelector('.chip[data-filter=all]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await evaluate("document.querySelector('.row-thumb').naturalWidth"), 96);
    await darkSurfaces();
    await noOverflow('history 440×640');
    await screenshot('history');
    await screenshot('history-clean');
  });

  await check('search, image dimensions, filter state, and clear-search click', async () => {
    await scene();
    await fill('#search', 'release');
    assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), 1);
    assert.equal(await evaluate("document.querySelector('#list .row').dataset.id"), 'release');
    assert.equal(await evaluate("document.querySelector('#list mark').textContent"), 'Release');
    await hit('#searchClear');
    assert.equal(await evaluate("document.querySelector('#search').value"), '');
    assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), 6);
    for (const [filter, count] of [['text', 5], ['image', 1], ['pinned', 2], ['all', 6]]) {
      await hit(`.chip[data-filter="${filter}"]`);
      assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), count);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.chip')].filter(e=>e.getAttribute('aria-pressed')==='true').map(e=>e.dataset.filter)"), [filter]);
    }
    await fill('#search', '1920 × 1080');
    assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), 1);
    assert.equal(await evaluate("document.querySelector('#list .row').dataset.id"), 'image');
    await fill('#search', 'not-a-match');
    assert.equal(await evaluate("document.querySelector('#empty').classList.contains('hidden')"), false);
    assert.equal(await evaluate("document.querySelectorAll('#list .row').length"), 0);
  });

  await check('pin, delete, Undo, clear all, and Undo use real click hit targets', async () => {
    await scene();
    await hit('#row-release .pin-btn');
    assert.equal(mock.rows.find((r) => r.id === 'release').pinned, true);
    assert.equal(countCalls('restore'), 0, 'pin must not copy row');
    await hit('#row-release button[aria-label="Delete entry"]');
    assert.equal(mock.rows.length, 5);
    assert.equal(countCalls('restore'), 0, 'delete must not copy row');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#toastAction')).pointerEvents"), 'auto');
    await hit('#toastAction');
    assert.equal(mock.rows.length, 6);
    await hit('#btnClear');
    assert.equal(mock.rows.length, 0);
    assert.equal(await evaluate("document.querySelector('#empty').classList.contains('hidden')"), false);
    await hit('#toastAction');
    assert.equal(mock.rows.length, 6);
  });

  await check('Enter activates focused button while list Enter copies exactly once', async () => {
    await scene();
    await evaluate("document.querySelector('.chip[data-filter=image]').focus()");
    await key('Enter');
    assert.equal(await evaluate("document.querySelector('.chip.active').dataset.filter"), 'image');
    assert.equal(countCalls('restore'), 0);
    await evaluate("document.querySelector('#list').focus()");
    await key('Enter');
    assert.equal(countCalls('restore'), 1);
    assert.equal(mock.calls.find((call) => call.method === 'restore').args[0], 'image');
  });

  await check('context-menu arrows and Enter activate item, Escape closes menu only', async () => {
    await scene();
    await hit('#row-release .row-text', 'right');
    assert.equal(await evaluate("document.querySelector('#rowMenu').classList.contains('hidden')"), false);
    await key('ArrowDown');
    assert.match(await evaluate('document.activeElement.textContent'), /Pin/);
    await key('Enter');
    assert.equal(countCalls('pin'), 1);
    assert.equal(countCalls('restore'), 0);
    await hit('#row-release .row-text', 'right');
    const hides = countCalls('hide');
    await key('Escape');
    assert.equal(await evaluate("document.querySelector('#rowMenu').classList.contains('hidden')"), true);
    assert.equal(countCalls('hide'), hides);
    assert.equal(await evaluate('document.activeElement.id'), 'list');
  });

  await check('settings bubble switch persists false and true; dark settings layout', async () => {
    await scene();
    await hit('#btnSettings');
    assert.equal(await evaluate("document.querySelector('#setBubblePinned').checked"), true);
    await darkSurfaces();
    await noOverflow('settings 440×640');
    await screenshot('settings');
    await hit('#setBubblePinned');
    await hit('#btnDone');
    assert.equal(mock.settings.bubblePinned, false);
    assert.equal(mock.calls.filter((call) => call.method === 'saveSettings').at(-1).args[0].bubblePinned, false);
    await hit('#btnSettings');
    assert.equal(await evaluate("document.querySelector('#setBubblePinned').checked"), false);
    await hit('#setBubblePinned');
    await hit('#btnDone');
    assert.equal(mock.settings.bubblePinned, true);
    assert.equal(mock.calls.filter((call) => call.method === 'saveSettings').at(-1).args[0].bubblePinned, true);
    assert.equal(await evaluate("document.querySelector('#historyScreen').classList.contains('hidden')"), false);
  });

  await check('locked settings Done, Escape, and settings toggle return to lock', async () => {
    await scene({ locked: true });
    assert.match(await evaluate("document.querySelector('#lockTitle').textContent"), /Unlock/);
    assert.equal(await evaluate("document.querySelector('#passConfirm').classList.contains('hidden')"), true);
    await noOverflow('lock 440×640');
    await screenshot('lock');
    await hit('#btnSettings');
    await hit('#btnDone');
    assert.equal(await evaluate("document.querySelector('#lockScreen').classList.contains('hidden')"), false);
    await hit('#btnSettings');
    const hides = countCalls('hide');
    await key('Escape');
    assert.equal(await evaluate("document.querySelector('#lockScreen').classList.contains('hidden')"), false);
    assert.equal(countCalls('hide'), hides);
    await hit('#btnSettings');
    await hit('#btnSettings');
    assert.equal(await evaluate("document.querySelector('#lockScreen').classList.contains('hidden')"), false);
    await fill('#passInput', 'wrong-pass');
    await hit('#passSubmit');
    assert.match(await evaluate("document.querySelector('#lockError').textContent"), /Incorrect/);
    await fill('#passInput', 'fixture-pass');
    await hit('#passSubmit');
    assert.equal(mock.locked, false);
    assert.equal(await evaluate("document.querySelector('#historyScreen').classList.contains('hidden')"), false);
  });

  await check('fresh vault setup validates matching passphrases without side effects', async () => {
    await scene({ fresh: true, empty: true });
    assert.match(await evaluate("document.querySelector('#lockTitle').textContent"), /Create/);
    assert.equal(await evaluate("document.querySelector('#passConfirm').classList.contains('hidden')"), false);
    await fill('#passInput', 'fixture-pass');
    await fill('#passConfirm', 'different');
    await hit('#passSubmit');
    assert.equal(countCalls('create'), 0);
    assert.match(await evaluate("document.querySelector('#lockError').textContent"), /do not match/);
    await fill('#passConfirm', 'fixture-pass');
    await hit('#passSubmit');
    assert.equal(countCalls('create'), 1);
    assert.equal(mock.locked, false);
    assert.equal(await evaluate("document.querySelector('#empty').classList.contains('hidden')"), false);
  });

  await check('empty history uses full area and black surfaces', async () => {
    await scene({ empty: true });
    assert.equal(await evaluate("document.querySelector('#list').getBoundingClientRect().height"), 0);
    assert.ok(await evaluate("document.querySelector('#empty').getBoundingClientRect().height > 250"));
    await noOverflow('empty 440×640');
    await screenshot('empty');
  });

  await check('360×420 comfortable and compact layouts keep all surfaces in bounds', async () => {
    for (const density of ['comfortable', 'compact']) {
      await scene({ density }, 360, 420);
      assert.equal(await evaluate("document.body.classList.contains('density-compact')"), density === 'compact');
      await noOverflow(`${density} history 360×420`);
      await screenshot(`history-small-${density}`);
      await hit('#btnSettings');
      await noOverflow(`${density} settings 360×420`);
      await screenshot(`settings-small-${density}`);
      await hit('#btnDone');
    }
    await scene({ locked: true }, 360, 420);
    await noOverflow('lock 360×420');
    await screenshot('lock-small');
    await scene({ fresh: true }, 360, 420);
    await noOverflow('setup 360×420');
    await screenshot('setup-small');
    await scene({ empty: true }, 360, 420);
    await noOverflow('empty 360×420');
    await screenshot('empty-small');
  });

  await check('renderer emitted no uncaught errors', async () => {
    assert.deepEqual(rendererErrors, []);
  });
  const report = { renderer, passed, failed: failures.length, failures, rendererErrors, artifacts, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(artifacts, 'ui-regression-report.json'), JSON.stringify(report, null, 2));
  log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${artifacts}`);
  app.exit(failures.length ? 1 : 0);
}).catch((error) => {
  log(error.stack);
  app.exit(1);
});
