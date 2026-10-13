'use strict';

/**
 * Autostart integration check. Runs under Electron because it talks to the
 * real login-item API, and always restores the previous state on the way out.
 *
 *   npm run test:autostart
 */

const path = require('path');
const { app } = require('electron');

// Mirrors src/main.js exactly; if these two drift the test is worthless.
function loginItemOptions() {
  return app.isPackaged
    ? { path: process.execPath }
    : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

app.whenReady().then(() => {
  const opts = loginItemOptions();
  let original = null;
  try {
    original = app.getLoginItemSettings(opts).openAtLogin;
  } catch {
    original = false;
  }

  console.log('clipvault autostart check\n');
  console.log(`packaged=${app.isPackaged} executable=${process.execPath}`);

  const finish = (code) => {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(original), ...opts });
      console.log(`restored previous autostart state (${original ? 'on' : 'off'})`);
    } catch (err) {
      console.error('could not restore previous state:', err.message);
    }
    app.exit(code);
  };

  check('login item options include a path', () => {
    if (!opts.path) throw new Error('no path in login item options');
  });

  check('registering on, then reading back, reports on', () => {
    app.setLoginItemSettings({ openAtLogin: true, ...opts });
    const back = app.getLoginItemSettings(opts);
    if (!back.openAtLogin) {
      throw new Error('set true but getLoginItemSettings reported false');
    }
    if (back.openAsHidden) throw new Error('should not open as hidden');
  });

  check('registering off, then reading back, reports off', () => {
    app.setLoginItemSettings({ openAtLogin: false, ...opts });
    const back = app.getLoginItemSettings(opts);
    if (back.openAtLogin) throw new Error('cleared but still reported as on');
  });

  check('registering on again sticks', () => {
    app.setLoginItemSettings({ openAtLogin: true, ...opts });
    if (!app.getLoginItemSettings(opts).openAtLogin) throw new Error('did not persist');
  });

  console.log(`\n${passed} passing, ${process.exitCode ? 'FAILURES ABOVE' : 'all green'}`);
  finish(process.exitCode ? 1 : 0);
});