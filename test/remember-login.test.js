'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DAY_MS,
  clampRememberDays,
  rememberExpiry,
  encodeRemember,
  decodeRemember,
  decideStartup,
} = require('../src/remember-login');
const { LoginStore } = require('../src/login-store');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
    process.exitCode = 1;
  }
}

function xor(buffer) {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) out[i] = buffer[i] ^ 0xa5;
  return out;
}

function codec() {
  return {
    available: () => true,
    encrypt: (plain) => xor(Buffer.from(String(plain), 'utf8')),
    decrypt: (buffer) => xor(Buffer.from(buffer)).toString('utf8'),
  };
}

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const BOOT_A = '41|S-1-5-5-0-100';
const BOOT_B = '42|S-1-5-5-0-200';
const SECRET = 'correct horse battery staple';

function remembered(days, now = NOW) {
  const record = encodeRemember(SECRET, days, now, (plain) => xor(Buffer.from(plain, 'utf8')));
  return decodeRemember(record, (buf) => xor(buf).toString('utf8'));
}

console.log('clipvault remember-me');

test('clamps the day count', () => {
  assert.strictEqual(clampRememberDays(undefined), 1);
  assert.strictEqual(clampRememberDays(0), 1);
  assert.strictEqual(clampRememberDays(-4), 1);
  assert.strictEqual(clampRememberDays(1.9), 1);
  assert.strictEqual(clampRememberDays('14'), 14);
  assert.strictEqual(clampRememberDays(90), 90);
  assert.strictEqual(clampRememberDays(91), 90);
  assert.strictEqual(clampRememberDays('nope'), 1);
});

test('expiry is an exact number of days', () => {
  assert.strictEqual(rememberExpiry(NOW, 1), NOW + DAY_MS);
  assert.strictEqual(rememberExpiry(NOW, 7), NOW + 7 * DAY_MS);
});

test('sealed record does not contain the passphrase', () => {
  const record = encodeRemember(SECRET, 3, NOW, (plain) => xor(Buffer.from(plain, 'utf8')));
  const dumped = JSON.stringify(record);
  assert.strictEqual(dumped.includes(SECRET), false);
  assert.strictEqual(dumped.includes('passphrase'), false);
  const decoded = decodeRemember(record, (buf) => xor(buf).toString('utf8'));
  assert.strictEqual(decoded.ok, true);
  assert.strictEqual(decoded.passphrase, SECRET);
  assert.strictEqual(decoded.days, 3);
  assert.strictEqual(decoded.expiresAt, NOW + 3 * DAY_MS);
});

test('a new boot with no opt-in shows the prompt', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW,
    remember: null,
    session: { bootId: BOOT_A, locked: false, passphrase: SECRET },
  });
  assert.strictEqual(decision.action, 'prompt');
  assert.strictEqual(decision.showPanel, true);
  assert.strictEqual(decision.passphrase, null);
  assert.strictEqual(decision.clearSession, true);
  assert.strictEqual(decision.reason, 'new-boot');
});

test('remember-me unlocks a new boot before expiry', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW + 2 * DAY_MS,
    remember: remembered(7),
    session: null,
  });
  assert.strictEqual(decision.action, 'unlock');
  assert.strictEqual(decision.showPanel, false);
  assert.strictEqual(decision.passphrase, SECRET);
  assert.strictEqual(decision.reason, 'remember-me');
  assert.strictEqual(decision.clearRemember, false);
});

test('an expired remember-me is cleared and prompts', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW + DAY_MS,
    remember: remembered(1),
    session: null,
  });
  assert.strictEqual(decision.action, 'prompt');
  assert.strictEqual(decision.showPanel, true);
  assert.strictEqual(decision.passphrase, null);
  assert.strictEqual(decision.clearRemember, true);
  assert.strictEqual(decision.reason, 'new-boot');
});

test('expiry is exclusive at the exact timestamp', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW + DAY_MS,
    remember: remembered(1),
    session: null,
  });
  assert.strictEqual(decision.clearRemember, true);
  const still = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW + DAY_MS - 1,
    remember: remembered(1),
    session: null,
  });
  assert.strictEqual(still.action, 'unlock');
});

test('same-boot restart stays unlocked without remember-me', () => {
  const decision = decideStartup({
    bootId: BOOT_A,
    previousBootId: BOOT_A,
    now: NOW,
    remember: null,
    session: { bootId: BOOT_A, locked: false, passphrase: SECRET },
  });
  assert.strictEqual(decision.action, 'unlock');
  assert.strictEqual(decision.showPanel, false);
  assert.strictEqual(decision.reason, 'same-boot');
  assert.strictEqual(decision.passphrase, SECRET);
});

test('a lock on this boot still prompts, and does not pop the panel', () => {
  const decision = decideStartup({
    bootId: BOOT_A,
    previousBootId: BOOT_A,
    now: NOW,
    remember: remembered(7),
    session: { bootId: BOOT_A, locked: true, passphrase: null },
  });
  assert.strictEqual(decision.action, 'prompt');
  assert.strictEqual(decision.showPanel, false);
  assert.strictEqual(decision.passphrase, null);
  assert.strictEqual(decision.reason, 'locked-this-boot');
  assert.strictEqual(decision.clearRemember, false);
});

test('a broken secret is cleared and does not unlock', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW,
    remember: { ok: false, reason: 'broken' },
    session: null,
  });
  assert.strictEqual(decision.action, 'prompt');
  assert.strictEqual(decision.clearRemember, true);
  assert.strictEqual(decision.passphrase, null);
});

test('unavailable encryption is left on disk and still prompts', () => {
  const decision = decideStartup({
    bootId: BOOT_B,
    previousBootId: BOOT_A,
    now: NOW,
    remember: { ok: false, reason: 'unavailable' },
    session: null,
  });
  assert.strictEqual(decision.clearRemember, false);
  assert.strictEqual(decision.action, 'prompt');
  assert.strictEqual(decision.showPanel, true);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-remember-'));
const store = new LoginStore(dir, codec());

test('store writes a sealed remember-me and a lock flag', () => {
  const saved = store.applyUnlock({
    enabled: true,
    days: 5,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  assert.strictEqual(saved.saved, true);
  const raw = fs.readFileSync(store.rememberFile, 'utf8');
  assert.strictEqual(raw.includes(SECRET), false);
  const session = fs.readFileSync(store.sessionFile, 'utf8');
  assert.strictEqual(session.includes(SECRET), false);
  assert.strictEqual(store.status().active, true);
  assert.strictEqual(store.status().days, 5);
  assert.strictEqual(store.status(NOW + 5 * DAY_MS - 1).active, true);
  assert.deepStrictEqual(store.status(NOW + 5 * DAY_MS), { active: false, days: 1 });
  const loaded = store.loadRemember(NOW);
  assert.strictEqual(loaded.passphrase, SECRET);
});

test('unchecking forgets the remembered login and keeps a sealed session', () => {
  store.applyUnlock({
    enabled: false,
    days: 5,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  assert.strictEqual(fs.existsSync(store.rememberFile), false);
  assert.strictEqual(store.status().active, false);
  const raw = fs.readFileSync(store.sessionFile, 'utf8');
  assert.strictEqual(raw.includes(SECRET), false);
  const session = store.loadSession();
  assert.strictEqual(session.passphrase, SECRET);
  assert.strictEqual(session.locked, false);
});

test('locking drops the session secret and keeps the boot marked locked', () => {
  store.noteLocked(BOOT_A);
  const session = store.loadSession();
  assert.strictEqual(session.locked, true);
  assert.strictEqual(session.passphrase, null);
  assert.strictEqual(fs.readFileSync(store.sessionFile, 'utf8').includes(SECRET), false);
});

test('changing the passphrase deletes remember-me', () => {
  store.applyUnlock({
    enabled: true,
    days: 2,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  store.invalidatePassphrase('a-new-passphrase-value', BOOT_A);
  assert.strictEqual(fs.existsSync(store.rememberFile), false);
  assert.strictEqual(store.status().active, false);
  const raw = fs.readFileSync(store.sessionFile, 'utf8');
  assert.strictEqual(raw.includes('a-new-passphrase-value'), false);
  assert.strictEqual(raw.includes(SECRET), false);
  assert.strictEqual(store.loadSession().passphrase, 'a-new-passphrase-value');
});

test('forgetting the vault removes both secrets', () => {
  store.applyUnlock({
    enabled: true,
    days: 2,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  store.forgetAll();
  assert.strictEqual(fs.existsSync(store.rememberFile), false);
  assert.strictEqual(fs.existsSync(store.sessionFile), false);
  assert.deepStrictEqual(store.status(), { active: false, days: 1 });
});

test('unchecking remember-me removes the old token when encryption is unavailable', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-remember-unavailable-'));
  let available = true;
  const base = codec();
  const local = new LoginStore(isolated, {
    available: () => available,
    encrypt: base.encrypt,
    decrypt: base.decrypt,
  });
  local.applyUnlock({
    enabled: true,
    days: 3,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  assert.strictEqual(fs.existsSync(local.rememberFile), true);
  available = false;
  const result = local.applyUnlock({
    enabled: false,
    days: 3,
    passphrase: SECRET,
    bootId: BOOT_A,
    now: NOW,
  });
  assert.strictEqual(result.saved, true);
  assert.strictEqual(fs.existsSync(local.rememberFile), false);
  assert.strictEqual(fs.existsSync(local.sessionFile), false);
  fs.rmSync(isolated, { recursive: true, force: true });
});

if (process.exitCode) {
  console.error(`\n${passed} passed, failures above`);
} else {
  console.log(`\n${passed} passed`);
}
