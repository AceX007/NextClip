'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const listeners = new Map();
const buttonListeners = new Map();
const calls = [];
const button = {
  matches() { return false; },
  addEventListener(type, listener) { buttonListeners.set(type, listener); },
};
const fakeWindow = {
  bubble: {
    toggle() { calls.push('toggle'); return Promise.resolve(); },
    unpin() { calls.push('unpin'); return Promise.resolve(); },
  },
  addEventListener(type, listener) { listeners.set(type, listener); },
  devicePixelRatio: 1,
};
const context = {
  document: {
    getElementById(id) { return id === 'open' ? button : null; },
  },
  window: fakeWindow,
  requestAnimationFrame() {},
  Promise,
};
const file = path.join(__dirname, '..', 'src', 'bubble', 'bubble.js');
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

async function main() {
  buttonListeners.get('click')();
  await Promise.resolve();
  assert.deepStrictEqual(calls, ['toggle']);

  let prevented = false;
  let stopped = false;
  listeners.get('contextmenu')({
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  await Promise.resolve();
  assert.deepStrictEqual(calls, ['toggle', 'unpin']);
  assert.strictEqual(prevented, true);
  assert.strictEqual(stopped, true);
  console.log('bubble direct input\n  ok   left-click opens and right-click hides the bubble');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
