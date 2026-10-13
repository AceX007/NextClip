'use strict';

/**
 * Standalone checks for the vault engine. Run with:  node test/vault.test.js
 * Uses only Node built-ins so it works without Electron installed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, VaultError } = require('../src/crypto-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-test-'));
const file = path.join(tmp, 'vault.json');
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('clipvault vault engine');

// --- creation & unlock ---------------------------------------------------
const v = new Vault(file);
test('reports no vault before creation', () => {
  assert.strictEqual(v.hasVault(), false);
});

test('rejects a too-short passphrase', () => {
  assert.throws(() => v.create('abc'), (e) => e instanceof VaultError && e.code === 'weak');
});

test('creates the vault and reports it present', () => {
  v.create('correct horse battery');
  assert.strictEqual(v.hasVault(), true);
  assert.strictEqual(v.locked, false);
});

// --- storage -------------------------------------------------------------
test('stores text and returns it back', () => {
  v.addText('hello clipboard');
  assert.strictEqual(v.list()[0].text, 'hello clipboard');
  assert.strictEqual(v.list()[0].type, 'text');
});

test('deduplicates identical text and bumps it to the top', () => {
  const before = v.entries.length;
  v.addText('something else');               // +1 distinct entry
  const afterDistinct = v.entries.length;
  v.addText('hello clipboard');               // already known -> no new entry
  assert.strictEqual(v.entries.length, afterDistinct, 'duplicate should not create a new entry');
  assert.strictEqual(afterDistinct, before + 1);
  assert.strictEqual(v.list()[0].text, 'hello clipboard');
});

test('normalizes CRLF so Windows and Unix copies compare equal', () => {
  v.addText('line one\r\nline two');
  assert.ok(v.list().some((e) => e.text === 'line one\nline two'));
});

test('ignores empty text', () => {
  assert.strictEqual(v.addText(''), null);
});

test('stores images with a thumbnail and reports dimensions', () => {
  const full = Buffer.alloc(2048, 7);
  const thumb = Buffer.alloc(256, 9);
  const id = v.addImage({ full, thumb, width: 1024, height: 768 });
  assert.ok(id);
  const row = v.list().find((r) => r.id === id);
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(row.width, 1024);
  assert.ok(row.thumb.startsWith('data:image/png;base64,'));
  const back = v.payload(id);
  assert.ok(back.dataUrl.startsWith('data:image/png;base64,'));
  assert.strictEqual(Buffer.from(back.dataUrl.split(',')[1], 'base64').length, full.length);
});

test('rejects duplicate images', () => {
  const full = Buffer.alloc(64, 3);
  assert.ok(v.addImage({ full, thumb: Buffer.alloc(16), width: 8, height: 8 }));
  assert.strictEqual(v.addImage({ full, thumb: Buffer.alloc(16), width: 8, height: 8 }), null);
});

test('pins and unpins', () => {
  const id = v.list().find((r) => r.type === 'text').id;
  assert.strictEqual(v.togglePin(id), true);
  assert.strictEqual(v.list()[0].id, id, 'pinned entries sort first');
  assert.strictEqual(v.togglePin(id), false);
});

test('pinned entries survive automatic trimming', () => {
  const pinned = v.list()[0].id;
  for (let i = 0; i < 60; i += 1) v.addText(`filler ${i} ${'x'.repeat(i)}`);
  v.togglePin(pinned);
  v.trim(30);
  assert.ok(v.entries.length <= 60);
  assert.ok(v.entries.some((e) => e.id === pinned), 'pinned entry must not be evicted');
});

// --- encryption guarantees ---------------------------------------------
test('plaintext never appears in the file on disk', () => {
  v.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('hello clipboard'), 'text leaked to disk');
  assert.ok(!raw.includes('filler 3'), 'text leaked to disk');
  assert.ok(!/"type"\s*:\s*"text"/.test(raw), 'entry types should be sealed, not plaintext');
});

test('prunes unpinned entries older than the retention window', () => {
  const w = new Vault(path.join(tmp, 'prune.json'));
  w.create('passphrase-123');
  const now = Date.now();
  const HOUR = 3_600_000;

  w.addText('fresh entry');
  w.addText('ancient entry');
  w.addText('boundary-ish entry');
  w.flush();

  // Look entries up by content: addText() sorts by timestamp, so positional
  // indexing depends on whether two calls land in the same millisecond.
  const byText = (text) => w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === text);
  byText('ancient entry').ts = now - 100 * HOUR;
  byText('boundary-ish entry').ts = now - 71 * HOUR;
  w._touch();
  w.flush();

  const pinned = w.list().find((r) => r.text === 'fresh entry').id;
  w.togglePin(pinned);
  w.addText('old but pinned');
  w.flush();
  const oldPinned = w.list().find((r) => r.text === 'old but pinned').id;
  w.togglePin(oldPinned);
  byText('old but pinned').ts = now - 200 * HOUR;
  w.flush();

  const removed = w.pruneOlderThan(72, now);
  assert.strictEqual(removed, 1, 'only the 100h unpinned entry is outside the window');

  const texts = w.list().map((r) => r.text);
  assert.ok(texts.includes('fresh entry'), 'pinned fresh entry must survive');
  assert.ok(texts.includes('old but pinned'), 'pinned old entry must survive');
  assert.ok(texts.includes('boundary-ish entry'), '71h old entry is inside the window');
  assert.ok(!texts.includes('ancient entry'), '100h old unpinned entry must be gone');
});

test('prune respects a disabled window and a locked vault', () => {
  const w = new Vault(path.join(tmp, 'prune2.json'));
  w.create('passphrase-123');
  w.addText('stays put');
  w.entries[0].ts = Date.now() - 999 * 3_600_000;

  assert.strictEqual(w.pruneOlderThan(0), 0, '0 hours disables pruning');
  assert.strictEqual(w.pruneOlderThan(-5), 0, 'negative hours disables pruning');
  assert.strictEqual(w.entries.length, 1);

  w.flush();
  w.lock();
  assert.strictEqual(w.pruneOlderThan(72), 0, 'locked vault must not prune');
  assert.strictEqual(w.entries.length, 1);
});

test('snapshot and restoreSnapshot round-trip a destructive action', () => {
  const w = new Vault(path.join(tmp, 'undo.json'));
  w.create('passphrase-123');
  w.addText('keep me');
  w.addText('delete me');
  const before = w.snapshot();
  assert.strictEqual(before.length, 2);

  w.remove(w.list().find((r) => r.text === 'delete me').id);
  assert.strictEqual(w.entries.length, 1);
  assert.strictEqual(w.list()[0].text, 'keep me');

  w.restoreSnapshot(before);
  const texts = w.list().map((r) => r.text).sort();
  assert.deepStrictEqual(texts, ['delete me', 'keep me']);

  // Restored entries must still be dedupable, i.e. the fingerprint index was rebuilt.
  assert.strictEqual(w.addText('keep me'), w.list().find((r) => r.text === 'keep me').id);
});

test('restoreSnapshot on a locked vault does nothing', () => {
  const w = new Vault(path.join(tmp, 'undo2.json'));
  w.create('passphrase-123');
  w.addText('entry');
  const snap = w.snapshot();
  w.lock();
  assert.strictEqual(w.restoreSnapshot(snap), 0);
  assert.strictEqual(w.snapshot(), null, 'snapshot must refuse while locked');
});

test('removing and clearing work', () => {
  const id = v.list()[0].id;
  assert.strictEqual(v.remove(id), true);
  assert.strictEqual(v.list().some((r) => r.id === id), false);
  assert.strictEqual(v.remove('nope'), false);
  v.clearAll();
  assert.strictEqual(v.entries.length, 0);
});

// --- persistence & lock --------------------------------------------------
let seeded;
test('data survives a lock/unlock cycle', () => {
  v.addText('persisted secret');
  v.flush();
  seeded = v.list()[0].text;

  v.lock();
  assert.strictEqual(v.locked, true);
  assert.strictEqual(v.list().length, 0, 'locked vault must expose no entries');
  assert.strictEqual(v.payload(seeded.id ?? 'x'), null, 'locked vault must expose no payloads');

  v.unlock('correct horse battery');
  assert.strictEqual(v.locked, false);
  assert.strictEqual(v.list()[0].text, seeded);
});

test('wrong passphrase is rejected without corrupting state', () => {
  assert.throws(() => v.unlock('wrong passphrase'), (e) => e.code === 'badpass');
  assert.strictEqual(v.locked, false, 'a failed attempt must not lock the open vault');
  assert.strictEqual(v.list()[0].text, seeded, 'entries must survive a failed attempt');
});

test('right passphrase still works after a failed attempt', () => {
  v.lock();
  v.unlock('correct horse battery');
  assert.strictEqual(v.list()[0].text, seeded);
});

test('a second vault instance can read the same file', () => {
  const other = new Vault(file);
  other.unlock('correct horse battery');
  assert.strictEqual(other.list()[0].text, seeded);
});

test('corrupt files are reported, not thrown raw', () => {
  const badFile = path.join(tmp, 'bad.json');
  fs.writeFileSync(badFile, '{not json');
  assert.throws(() => new Vault(badFile).unlock('x'), (e) => e.code === 'corrupt');

  const wrongVersion = path.join(tmp, 'v9.json');
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 99, kdf: { salt: 'AA==' }, check: {} }));
  assert.throws(() => new Vault(wrongVersion).unlock('x'), (e) => e.code === 'corrupt');

  const missing = new Vault(path.join(tmp, 'nope.json'));
  assert.throws(() => missing.unlock('x'), (e) => e.code === 'missing');
});

test('ciphertexts differ for identical plaintext (random IVs)', () => {
  const w = new Vault(path.join(tmp, 'iv.json'));
  w.create('passphrase-123');
  w.addText('identical');
  const a = w.entries[0].blobs.content.ct;
  w.clearAll();
  w.addText('identical');
  const b = w.entries[0].blobs.content.ct;
  assert.notStrictEqual(a, b);
});

test('changePassphrase re-keys the vault and keeps data intact', () => {
  v.addText('carry me across the rekey');
  v.flush();
  assert.strictEqual(v.changePassphrase('a brand new passphrase'), true);
  v.flush();

  v.lock();
  assert.throws(() => v.unlock('correct horse battery'), (e) => e.code === 'badpass');
  v.unlock('a brand new passphrase');
  assert.ok(v.list().some((r) => r.text === 'carry me across the rekey'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passing, ${process.exitCode ? 'FAILURES ABOVE' : 'all green'}`);