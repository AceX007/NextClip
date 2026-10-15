'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const USER_DATA = path.join('C:\\nextclip-test-only', 'appData', 'clipvault');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');
const MAIN_FILE = path.join(__dirname, '..', 'src', 'main.js');
const MAIN_SOURCE = fs.readFileSync(MAIN_FILE, 'utf8');

// Execute the complete main process with an in-memory filesystem and a denied
// single-instance lock. No Electron app, real files, clipboard, or timers run.
function fixture({ saved, files = new Map() } = {}) {
  if (saved !== undefined) files.set(SETTINGS_FILE, JSON.stringify(saved));
  const events = [];
  const requestedModules = [];
  const handlers = new Map();
  const appPaths = { appData: path.join('C:\\nextclip-test-only', 'appData') };
  let failAt = null;
  let currentMenu = null;

  const fakeFs = {
    mkdirSync() {},
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing test file'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync(file, content) {
      if (failAt === 'write') throw new Error('test write failure');
      files.set(file, String(content));
    },
    renameSync(from, to) {
      if (failAt === 'rename') throw new Error('test rename failure');
      assert.ok(files.has(from), 'the replacement file exists before committing');
      files.set(to, files.get(from));
      files.delete(from);
      events.push({ type: 'persist', settings: JSON.parse(files.get(to)) });
    },
    rmSync(file) { files.delete(file); },
    statSync() { return { size: 0 }; },
    appendFileSync() {},
  };
  const app = {
    isPackaged: false,
    getPath(name) {
      if (!appPaths[name]) throw new Error(`Unexpected app path: ${name}`);
      return appPaths[name];
    },
    setPath(name, value) { appPaths[name] = value; },
    setName() {},
    getAppPath() { return path.dirname(MAIN_FILE); },
    getLoginItemSettings() { return { openAtLogin: true }; },
    requestSingleInstanceLock() { return false; },
    quit() {},
  };
  const never = () => { throw new Error('Unexpected desktop or boot operation in settings test'); };
  const electron = {
    app,
    nativeTheme: {},
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    BrowserWindow: never,
    clipboard: new Proxy({}, { get: () => never }),
    globalShortcut: { isRegistered() { return false; } },
    screen: {},
    Tray: never,
    Menu: { buildFromTemplate(template) { return { template }; } },
    nativeImage: { createFromBuffer() { return {}; } },
    shell: {},
    desktopCapturer: {},
    dialog: {},
    safeStorage: {},
  };
  const bubbleModule = {
    createBubbleWindow: never,
    setBubbleSuppressed: never,
    setBubblePinned(value) {
      events.push({ type: 'apply', pinned: value, savedPinned: JSON.parse(files.get(SETTINGS_FILE)).bubblePinned });
    },
    destroyBubble: never,
    bubbleSnapshot: never,
  };
  const dependencies = {
    path,
    fs: fakeFs,
    child_process: { spawn: never },
    electron,
    './crypto-store': { Vault: never },
    './monitor': { Monitor: never },
    './icon': { drawPadlock() { return Buffer.alloc(0); } },
    './login-store': { LoginStore: never },
    './boot-id': { queryWindowsBootId: never },
    './remember-login': { decideStartup: never },
    './win-chord': { registerWinChord: never, unregisterWinChord: never },
    './bubble-window': bubbleModule,
  };
  const fakeProcess = {
    env: {},
    pid: 12345,
    platform: 'win32',
    execPath: path.join('C:\\nextclip-test-only', 'electron.exe'),
    stderr: { write() {} },
  };
  const testExports = `
    module.exports = {
      sanitizeSettings, loadSettings, updateBubblePin, registerIpc,
      getSettings: () => settings,
      installTestState(next) { win = next.win; tray = next.tray; vault = next.vault; },
    };
  `;
  const wrapper = vm.runInNewContext(
    `(function(require, module, exports, __dirname, __filename, process, Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate) {
      ${MAIN_SOURCE}\n${testExports}\n})`,
    {},
    { filename: MAIN_FILE },
  );
  const module = { exports: {} };
  wrapper((name) => {
    requestedModules.push(name);
    assert.ok(Object.hasOwn(dependencies, name), `mock required dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, path.dirname(MAIN_FILE), MAIN_FILE, fakeProcess,
  Buffer, never, never, never, never, never);
  const api = module.exports;
  api.installTestState({
    win: {
      isDestroyed() { return false; },
      webContents: {
        send(channel, payload) {
          events.push({ type: 'push', channel, payload: JSON.parse(JSON.stringify(payload)) });
        },
      },
    },
    tray: {
      setImage() {},
      setContextMenu(menu) { currentMenu = menu; events.push({ type: 'tray' }); },
    },
    vault: { locked: true, hasVault() { return true; } },
  });
  api.loadSettings();
  api.registerIpc();
  return {
    api, files, events, requestedModules,
    readSaved() { return JSON.parse(files.get(SETTINGS_FILE)); },
    failNextSaveAt(stage) { failAt = stage; },
    pinMenuItem() { return currentMenu.template.find((item) => item.label === 'Pin bubble on screen'); },
    async save(patch) { return handlers.get('settings:save')({}, patch); },
    async unpin() { return handlers.get('bubble:unpin')(); },
    status() { return handlers.get('vault:status')(); },
  };
}

function assertAppliedAfterSave(run, pinned) {
  const commit = run.events.findIndex((event) => event.type === 'persist');
  const apply = run.events.findIndex((event) => event.type === 'apply');
  const tray = run.events.findIndex((event) => event.type === 'tray');
  const push = run.events.findIndex((event) => event.channel === 'vault:state');
  assert.ok(commit >= 0 && apply > commit, 'the preference is committed before window visibility changes');
  assert.ok(tray > commit, 'the tray reflects the committed preference');
  assert.ok(push > commit, 'the renderer receives the committed preference');
  assert.strictEqual(run.events[apply].pinned, pinned);
  assert.strictEqual(run.events[apply].savedPinned, pinned);
  assert.strictEqual(run.events[push].payload.settings.bubblePinned, pinned);
  assert.strictEqual(run.pinMenuItem().checked, pinned);
  assert.strictEqual(run.readSaved().bubblePinned, pinned);
  assert.strictEqual(run.status().settings.bubblePinned, pinned);
}

test('existing settings without a bubble preference keep the bubble pinned', () => {
  const run = fixture({ saved: { density: 'compact', maxEntries: 200 } });
  assert.strictEqual(run.api.getSettings().bubblePinned, true);
  assert.strictEqual(run.api.getSettings().density, 'compact');
  assert.strictEqual(run.api.getSettings().maxEntries, 200);
  assert.strictEqual(fixture().api.getSettings().bubblePinned, true);
});

test('the main process never imports the low-level Windows-key hook', () => {
  const run = fixture();
  assert.ok(!run.requestedModules.includes('./win-chord'));
});

test('only boolean pin preferences are accepted from stored settings', () => {
  const { api } = fixture();
  assert.strictEqual(api.sanitizeSettings({ bubblePinned: false }).bubblePinned, false);
  assert.strictEqual(api.sanitizeSettings({ bubblePinned: true }).bubblePinned, true);
  for (const value of [undefined, null, 0, 1, '', 'false', 'true', [], {}]) {
    assert.strictEqual(api.sanitizeSettings({ bubblePinned: value }).bubblePinned, true,
      `invalid preference ${JSON.stringify(value)} uses the safe existing-user default`);
  }
});

test('unpinning saves before changing the bubble, tray, and renderer state', () => {
  const run = fixture({ saved: { bubblePinned: true, density: 'compact' } });
  run.api.updateBubblePin(false);
  assertAppliedAfterSave(run, false);
  assert.strictEqual(run.readSaved().density, 'compact');
});

test('the bubble IPC hides and persists the bubble without a native context menu', async () => {
  const run = fixture({ saved: { bubblePinned: true } });
  const result = await run.unpin();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pinned, false);
  assertAppliedAfterSave(run, false);
});

test('the saved unpinned state survives restart and the tray restores it persistently', () => {
  const first = fixture();
  first.api.updateBubblePin(false);
  const restarted = fixture({ files: first.files });
  assert.strictEqual(restarted.api.getSettings().bubblePinned, false);
  // Applying the same value also builds the real native tray menu.
  restarted.api.updateBubblePin(false);
  restarted.events.length = 0;
  restarted.pinMenuItem().click({ checked: true });
  assertAppliedAfterSave(restarted, true);
  assert.strictEqual(fixture({ files: restarted.files }).api.getSettings().bubblePinned, true);
});

for (const stage of ['write', 'rename']) {
  test(`a failed ${stage} while unpinning retains the saved preference and window state`, () => {
    const run = fixture({ saved: { bubblePinned: true } });
    run.failNextSaveAt(stage);
    run.api.updateBubblePin(false);
    assert.strictEqual(run.api.getSettings().bubblePinned, true);
    assert.strictEqual(run.readSaved().bubblePinned, true);
    assert.strictEqual(run.pinMenuItem().checked, true, 'a clicked tray checkbox is reset after the failure');
    assert.ok(!run.events.some((event) => event.type === 'apply'), 'the bubble is never hidden on a failed save');
    assert.ok(!run.events.some((event) => event.channel === 'vault:state'), 'no unsaved state is broadcast');
    assert.ok(run.events.some((event) => event.channel === 'toast'), 'the user is told that the save failed');
    assert.ok(![...run.files.keys()].some((file) => file.endsWith('.tmp')), 'failed saves clean up the temporary file');
  });
}

test('Settings can unpin and repin, with each choice surviving a fresh process', async () => {
  const first = fixture();
  const offResult = await first.save({ bubblePinned: false });
  assert.strictEqual(offResult.bubblePinned, false);
  assertAppliedAfterSave(first, false);
  const restarted = fixture({ files: first.files });
  assert.strictEqual(restarted.api.getSettings().bubblePinned, false);
  const onResult = await restarted.save({ bubblePinned: true });
  assert.strictEqual(onResult.bubblePinned, true);
  assertAppliedAfterSave(restarted, true);
  assert.strictEqual(fixture({ files: restarted.files }).api.getSettings().bubblePinned, true);
});

test('saving another setting preserves an unpinned bubble across restart', async () => {
  const run = fixture({ saved: { bubblePinned: false, density: 'comfortable' } });
  const result = await run.save({ density: 'compact' });
  assert.strictEqual(result.bubblePinned, false);
  assertAppliedAfterSave(run, false);
  const restarted = fixture({ files: run.files });
  assert.strictEqual(restarted.api.getSettings().bubblePinned, false);
  assert.strictEqual(restarted.api.getSettings().density, 'compact');
});

for (const stage of ['write', 'rename']) {
  test(`Settings rejects a failed ${stage} without applying or publishing the patch`, async () => {
    const run = fixture({ saved: { bubblePinned: false, density: 'comfortable' } });
    run.failNextSaveAt(stage);
    await assert.rejects(run.save({ bubblePinned: true, density: 'compact' }), /test (write|rename) failure/);
    assert.strictEqual(run.api.getSettings().bubblePinned, false);
    assert.strictEqual(run.api.getSettings().density, 'comfortable');
    assert.strictEqual(run.readSaved().bubblePinned, false);
    assert.strictEqual(run.readSaved().density, 'comfortable');
    assert.ok(!run.events.some((event) => ['apply', 'tray'].includes(event.type)), 'failed Settings save does not change live controls');
    assert.ok(!run.events.some((event) => event.channel === 'vault:state'));
    assert.strictEqual(fixture({ files: run.files }).api.getSettings().bubblePinned, false);
  });
}

(async () => {
  let passed = 0;
  console.log('clipvault bubble settings integration');
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 5).join('\n       ')}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) console.error(`\n${passed} passed, failures above`);
  else console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
