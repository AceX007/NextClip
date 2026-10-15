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

test('deduplicates an image and bumps it to the top', () => {
  const full = Buffer.alloc(64, 3);
  const before = v.entries.length;
  const id = v.addImage({ full, thumb: Buffer.alloc(16), width: 8, height: 8 });
  assert.ok(id);
  assert.strictEqual(v.entries.length, before + 1);
  assert.strictEqual(v.addImage({ full, thumb: Buffer.alloc(16), width: 8, height: 8 }), id);
  assert.strictEqual(v.entries.length, before + 1);
  assert.strictEqual(v.list()[0].id, id);
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

test('trim evicts the oldest unpinned entry, not the one just copied', () => {
  const w = new Vault(path.join(tmp, 'trim-order.json'));
  w.create('passphrase-123');
  w.addText('oldest');
  w.addText('pinned-middle');
  w.addText('newest');
  const byText = (text) => w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === text);
  byText('oldest').ts = 1;
  byText('pinned-middle').ts = 2;
  byText('newest').ts = 50_000;
  for (let i = 0; i < 20; i += 1) w.addText(`pad ${i}`);
  for (const entry of w.entries) {
    const text = w._open(entry.blobs.content).toString('utf8');
    if (text.startsWith('pad ')) entry.ts = 100 + Number(text.slice(4));
  }
  w.togglePin(byText('pinned-middle').id);
  w._touch();
  w.trim(20);
  const texts = w.list().map((r) => r.text);
  assert.ok(!texts.includes('oldest'), 'oldest unpinned entry must be evicted');
  assert.ok(texts.includes('newest'), 'newest entry must be kept');
  assert.ok(texts.includes('pinned-middle'), 'pinned entry must be kept');
  assert.ok(w.entries.length <= 20);
});

test('a new entry stays ahead of one stamped later than Date.now()', () => {
  const w = new Vault(path.join(tmp, 'ts-order.json'));
  w.create('passphrase-123');
  w.addText('first');
  w.entries[0].ts = Date.now() + 10_000;
  w.addText('second');
  assert.strictEqual(w.list()[0].text, 'second');
  const second = w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === 'second');
  const first = w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === 'first');
  assert.ok(second.ts > first.ts);
});

test('re-unlock keeps entries that have not been flushed yet', () => {
  const w = new Vault(path.join(tmp, 'reunlock.json'));
  w.create('passphrase-123');
  w.addText('already safe');
  w.flush();
  w.addText('still pending');
  w.unlock('passphrase-123');
  const texts = w.list().map((r) => r.text);
  assert.ok(texts.includes('still pending'), 'debounced entry must survive a passphrase re-check');
  assert.ok(texts.includes('already safe'));
});

test('a damaged metadata row is not wiped and does not brick the vault', () => {
  const file = path.join(tmp, 'corrupt-entry.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.entries[0].blobs.meta.ct = Buffer.from('not-ciphertext').toString('base64');
  fs.writeFileSync(file, JSON.stringify(raw));
  w.unlock('passphrase-123');
  assert.strictEqual(w.locked, false);
  assert.strictEqual(w.list()[0].text, 'keep me');
  w.addText('sibling');
  w.flush();
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(again.entries.length, 2, 'saving after unlock must not drop the damaged row');
  w.lock();
  w.unlock('passphrase-123');
  assert.deepStrictEqual(w.list().map((r) => r.text).sort(), ['keep me', 'sibling']);
});

test('undo puts a deleted entry back without dropping a later clip', () => {
  const w = new Vault(path.join(tmp, 'undo-merge.json'));
  w.create('passphrase-123');
  w.addText('keep me');
  w.addText('delete me');
  const before = w.snapshot();
  w.remove(w.list().find((r) => r.text === 'delete me').id);
  w.addText('copied after');
  const restored = w.restoreSnapshot(before);
  assert.strictEqual(restored, 1);
  const texts = w.list().map((r) => r.text).sort();
  assert.deepStrictEqual(texts, ['copied after', 'delete me', 'keep me']);
});

test('changePassphrase restores memory when the write fails', () => {
  const file = path.join(tmp, 'rekey.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('carry me');
  w.flush();
  const goodKeyCheck = w.checkEnvelope;
  w.file = path.join(tmp, 'rekey.json', 'not-a-file');
  assert.throws(() => w.changePassphrase('a different passphrase'));
  assert.strictEqual(w.locked, false);
  w.file = file;
  assert.strictEqual(w.list()[0].text, 'carry me');
  assert.strictEqual(w.checkEnvelope, goodKeyCheck);
  w.lock();
  w.unlock('passphrase-123');
  assert.strictEqual(w.list()[0].text, 'carry me');
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

test('re-copying an image refreshes its age so retention keeps it', () => {
  const w = new Vault(path.join(tmp, 'image-age.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(32, 4);
  const thumb = Buffer.alloc(8, 5);
  const id = w.addImage({ full, thumb, width: 4, height: 4 });
  w.entries[0].ts = Date.now() - 100 * 3_600_000;
  const again = w.addImage({ full, thumb, width: 4, height: 4 });
  assert.strictEqual(again, id);
  assert.strictEqual(w.entries.length, 1);
  assert.strictEqual(w.pruneOlderThan(72), 0);
  assert.strictEqual(w.list()[0].id, id);
});

test('adds while locked do nothing', () => {
  const w = new Vault(path.join(tmp, 'locked-add.json'));
  w.create('passphrase-123');
  w.addText('safe');
  w.lock();
  assert.strictEqual(w.addText('nope'), null);
  assert.strictEqual(w.addImage({
    full: Buffer.from([1, 2, 3, 4]),
    thumb: Buffer.from([5]),
    width: 1,
    height: 1,
  }), null);
  assert.strictEqual(w.entries.length, 1);
  w.unlock('passphrase-123');
  assert.strictEqual(w.list().some((r) => r.text === 'nope'), false);
  assert.strictEqual(w.list().some((r) => r.text === 'safe'), true);
});

test('changePassphrase keeps dedupe for text and byte-hashed images', () => {
  const w = new Vault(path.join(tmp, 'rekey-dedupe.json'));
  w.create('passphrase-123');
  w.addText('same text');
  const full = Buffer.alloc(24, 9);
  w.addImage({ full, thumb: Buffer.alloc(4, 1), width: 2, height: 2 });
  assert.strictEqual(w.changePassphrase('a different passphrase'), true);
  w.addText('same text');
  w.addImage({ full, thumb: Buffer.alloc(4, 1), width: 2, height: 2 });
  assert.strictEqual(w.entries.length, 2);
  w.lock();
  w.unlock('a different passphrase');
  w.addText('same text');
  assert.strictEqual(w.entries.length, 2);
});

test('a failed create does not wipe the open vault', () => {
  const file = path.join(tmp, 'create-rollback.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  const id = w.addText('do not lose me');
  w.flush();
  w.file = path.join(file, 'blocked');
  assert.throws(() => w.create('brand-new-passphrase-xx'));
  w.file = file;
  assert.strictEqual(w.locked, false);
  assert.strictEqual(w.list()[0].text, 'do not lose me');
  assert.strictEqual(w.addText('do not lose me'), id);
  w.flush();
  w.lock();
  w.unlock('passphrase-123');
  assert.strictEqual(w.list()[0].text, 'do not lose me');
  assert.throws(() => w.unlock('brand-new-passphrase-xx'), (e) => e.code === 'badpass');
});

test('lock keeps the vault open when the save fails', () => {
  const file = path.join(tmp, 'lock-flush.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('on disk');
  w.flush();
  w.addText('only memory');
  w.file = path.join(file, 'blocked');
  assert.throws(() => w.lock(), (e) => e instanceof VaultError && e.code === 'io');
  assert.strictEqual(w.locked, false);
  w.file = file;
  const memory = w.list().map((r) => r.text);
  assert.ok(memory.includes('only memory'));
  assert.ok(memory.includes('on disk'));
  w.flush();
  w.lock();
  w.unlock('passphrase-123');
  const disk = w.list().map((r) => r.text);
  assert.ok(disk.includes('only memory'));
  assert.ok(disk.includes('on disk'));
});

test('undo after a passphrase change does not restore unreadable rows', () => {
  const w = new Vault(path.join(tmp, 'undo-rekey.json'));
  w.create('passphrase-123');
  w.addText('keep');
  w.addText('gone');
  const snap = w.snapshot();
  w.remove(w.list().find((r) => r.text === 'gone').id);
  w.changePassphrase('a different passphrase');
  assert.strictEqual(w.restoreSnapshot(snap), 0);
  w.flush();
  w.lock();
  w.unlock('a different passphrase');
  assert.deepStrictEqual(w.list().map((r) => r.text), ['keep']);
});

test('recopying text replaces a row whose ciphertext will not open', () => {
  const w = new Vault(path.join(tmp, 'ghost.json'));
  w.create('passphrase-123');
  w.addText('ghost');
  w.addText('sibling');
  const ghost = w.entries.find((e) => {
    try { return w._open(e.blobs.content).toString('utf8') === 'ghost'; }
    catch { return false; }
  });
  ghost.blobs.content.ct = Buffer.from('nope').toString('base64');
  w._previews.clear();
  const before = w.list().map((r) => r.text);
  assert.deepStrictEqual(before, ['sibling']);
  w.addText('ghost');
  const after = w.list().map((r) => r.text).sort();
  assert.deepStrictEqual(after, ['ghost', 'sibling']);
  assert.strictEqual(w.entries.length, 2);
});

test('a broken thumbnail still lists the image', () => {
  const w = new Vault(path.join(tmp, 'thumb.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(20, 6);
  const id = w.addImage({ full, thumb: Buffer.alloc(4, 7), width: 3, height: 3 });
  w.entries[0].blobs.thumb.ct = Buffer.from('nope').toString('base64');
  w._previews.clear();
  const row = w.list().find((r) => r.id === id);
  assert.ok(row, 'restorable image must stay in the list');
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(w.payload(id).type, 'image');
  assert.strictEqual(w.list().length, 1);
});

test('one corrupt metadata row does not block the rest of the vault', () => {
  const file = path.join(tmp, 'mixed-meta.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('good');
  w.addText('ancient');
  w.addText('damaged');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.entries[0].blobs.meta.ct = Buffer.from('not-ciphertext').toString('base64');
  fs.writeFileSync(file, JSON.stringify(raw));
  w.unlock('passphrase-123');
  const texts = w.list().map((r) => r.text).sort();
  assert.deepStrictEqual(texts, ['ancient', 'damaged', 'good']);
  const damaged = w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === 'damaged');
  const ancient = w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === 'ancient');
  ancient.ts = Date.now() - 100 * 3_600_000;
  assert.strictEqual(w.pruneOlderThan(72), 1);
  assert.ok(w.entries.some((e) => e.id === damaged.id), 'unclassified ciphertext must not be pruned');
  assert.ok(!w.entries.some((e) => e.id === ancient.id));
  w.flush();
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(again.entries.some((e) => e.id === damaged.id));
});

test('changePassphrase rebuilds a row whose metadata will not open', () => {
  const w = new Vault(path.join(tmp, 'rekey-meta.json'));
  w.create('passphrase-123');
  w.addText('readable');
  w.entries[0].blobs.meta.ct = Buffer.from('nope').toString('base64');
  assert.strictEqual(w.changePassphrase('a different passphrase'), true);
  assert.strictEqual(w.list()[0].text, 'readable');
  w.lock();
  w.unlock('a different passphrase');
  assert.strictEqual(w.list()[0].text, 'readable');
});

test('changePassphrase drops a row that cannot be read and keeps the rest', () => {
  const w = new Vault(path.join(tmp, 'rekey-partial.json'));
  w.create('passphrase-123');
  w.addText('carry');
  w.addText('broken');
  const broken = w.entries.find((e) => w._open(e.blobs.content).toString('utf8') === 'broken');
  broken.blobs.content.ct = Buffer.from('nope').toString('base64');
  assert.strictEqual(w.changePassphrase('a different passphrase'), true);
  assert.deepStrictEqual(w.list().map((r) => r.text), ['carry']);
  assert.strictEqual(w.entries.length, 1);
  w.lock();
  w.unlock('a different passphrase');
  assert.strictEqual(w.list()[0].text, 'carry');
});

test('changePassphrase refuses when every row is unreadable', () => {
  const w = new Vault(path.join(tmp, 'rekey-none.json'));
  w.create('passphrase-123');
  w.addText('only');
  w.flush();
  const check = w.checkEnvelope;
  w.entries[0].blobs.content.ct = Buffer.from('nope').toString('base64');
  assert.throws(() => w.changePassphrase('a different passphrase'), (e) => e.code === 'corrupt');
  assert.strictEqual(w.locked, false);
  assert.strictEqual(w.checkEnvelope, check);
  w.entries[0].blobs.content = w._seal(Buffer.from('only', 'utf8'));
  w.lock();
  assert.throws(() => w.unlock('a different passphrase'), (e) => e.code === 'badpass');
  w.unlock('passphrase-123');
  assert.strictEqual(w.list()[0].text, 'only');
});

test('damaged key metadata is reported as corrupt', () => {
  const saltFile = path.join(tmp, 'bad-salt.json');
  const saltVault = new Vault(saltFile);
  saltVault.create('passphrase-123');
  saltVault.flush();
  const raw = JSON.parse(fs.readFileSync(saltFile, 'utf8'));
  raw.kdf.salt = 12;
  fs.writeFileSync(saltFile, JSON.stringify(raw));
  assert.throws(
    () => new Vault(saltFile).unlock('passphrase-123'),
    (e) => e instanceof VaultError && e.code === 'corrupt',
  );

  const checkFile = path.join(tmp, 'missing-check.json');
  const checkVault = new Vault(checkFile);
  checkVault.create('passphrase-123');
  checkVault.addText('still here');
  checkVault.flush();
  const doc = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
  delete doc.check;
  fs.writeFileSync(checkFile, JSON.stringify(doc));
  assert.throws(
    () => new Vault(checkFile).unlock('passphrase-123'),
    (e) => e instanceof VaultError && e.code === 'corrupt',
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(checkFile, 'utf8')).entries.length, 1);
});

test('a vault whose rows cannot be read is not opened over the file', () => {
  const file = path.join(tmp, 'unreadable.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.entries[0].blobs.meta.ct = Buffer.from('not-ciphertext').toString('base64');
  raw.entries[0].blobs.content.ct = Buffer.from('also-not').toString('base64');
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => w.unlock('passphrase-123'), (e) => e.code === 'corrupt');
  assert.strictEqual(w.locked, true, 'failed unlock must not leave the key installed');
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(again.entries.length, 1, 'failed unlock must not rewrite the vault');
  assert.strictEqual(again.entries[0].blobs.content.ct, raw.entries[0].blobs.content.ct);
});

test('a non-array entries field is not opened as an empty vault', () => {
  const file = path.join(tmp, 'entries-shape.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.entries = { kept: true };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => w.unlock('passphrase-123'), (e) => e.code === 'corrupt');
  assert.strictEqual(w.locked, true);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(again.entries.kept, true);
});

test('a row with missing metadata is kept and still shown', () => {
  const file = path.join(tmp, 'missing-meta.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  w.addText('sibling');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.entries[0].blobs.meta;
  fs.writeFileSync(file, JSON.stringify(raw));
  w.unlock('passphrase-123');
  assert.deepStrictEqual(w.list().map((r) => r.text).sort(), ['keep me', 'sibling']);
  w.addText('third');
  w.flush();
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(again.entries.length, 3);
  w.lock();
  w.unlock('passphrase-123');
  assert.deepStrictEqual(w.list().map((r) => r.text).sort(), ['keep me', 'sibling', 'third']);
});

test('a key check that opens but is not the sentinel is corrupt', () => {
  const file = path.join(tmp, 'sentinel.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  const check = w._seal('not-the-sentinel');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.check = check;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => w.unlock('passphrase-123'), (e) => e.code === 'corrupt');
  assert.strictEqual(w.locked, true);
  assert.throws(() => w.unlock('wrong-passphrase'), (e) => e.code === 'badpass');
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(again.entries.length, 1);
});

test('undo restores a row whose metadata will not open when the clip still does', () => {
  const w = new Vault(path.join(tmp, 'undo-opaque.json'));
  w.create('passphrase-123');
  const id = w.addText('back');
  w.entries[0].blobs.meta.ct = Buffer.from('nope').toString('base64');
  w.entries[0]._opaque = true;
  const snap = w.snapshot();
  assert.strictEqual(w.remove(id), true);
  assert.strictEqual(w.restoreSnapshot(snap), 1);
  assert.strictEqual(w.list()[0].text, 'back');
  w.flush();
  w.lock();
  w.unlock('passphrase-123');
  assert.strictEqual(w.list()[0].text, 'back');
});

test('undo does not report success when the save fails', () => {
  const file = path.join(tmp, 'undo-io.json');
  const w = new Vault(file);
  w.create('passphrase-123');
  w.addText('keep me');
  w.addText('delete me');
  const before = w.snapshot();
  const gone = w.list().find((r) => r.text === 'delete me').id;
  w.remove(gone);
  w.flush();
  w.file = path.join(file, 'blocked');
  assert.throws(() => w.restoreSnapshot(before), (e) => e instanceof VaultError && e.code === 'io');
  w.file = file;
  assert.strictEqual(w.list().some((r) => r.text === 'delete me'), false);
  assert.strictEqual(w.restoreSnapshot(before), 1);
  w.lock();
  w.unlock('passphrase-123');
  const texts = w.list().map((r) => r.text).sort();
  assert.deepStrictEqual(texts, ['delete me', 'keep me']);
});

test('recopying a pinned row keeps its id and pin when ciphertext will not open', () => {
  const w = new Vault(path.join(tmp, 'pin-ghost.json'));
  w.create('passphrase-123');
  const id = w.addText('ghost');
  assert.strictEqual(w.togglePin(id), true);
  const ghost = w.entries.find((e) => e.id === id);
  ghost.blobs.content.ct = Buffer.from('nope').toString('base64');
  w._previews.clear();
  assert.strictEqual(w.addText('ghost'), id);
  assert.strictEqual(w.entries.length, 1);
  assert.strictEqual(w.entries[0].pinned, true);
  assert.strictEqual(w.addText('ghost'), id);
  assert.strictEqual(w.entries.length, 1);
  assert.strictEqual(w.list()[0].text, 'ghost');
  assert.strictEqual(w.list()[0].pinned, true);
});

test('recopying an image replaces a thumbnail that will not open', () => {
  const w = new Vault(path.join(tmp, 'thumb-heal.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(20, 6);
  const thumb = Buffer.alloc(8, 7);
  const id = w.addImage({ full, thumb, width: 3, height: 3 });
  w.entries[0].blobs.thumb.ct = Buffer.from('nope').toString('base64');
  w._previews.clear();
  assert.strictEqual(w.list()[0].thumb, null);
  assert.strictEqual(w.addImage({ full, thumb, width: 3, height: 3 }), id);
  const row = w.list().find((r) => r.id === id);
  assert.ok(row.thumb && row.thumb.startsWith('data:image/png;base64,'));
  assert.strictEqual(row.width, 3);
  assert.strictEqual(row.type, 'image');
});

test('damaged image metadata does not relabel the row as text', () => {
  const w = new Vault(path.join(tmp, 'image-relabel.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(20, 7);
  const id = w.addImage({ full, thumb: Buffer.alloc(4, 1), width: 5, height: 4 });
  w.entries[0].blobs.meta.ct = Buffer.from('nope').toString('base64');
  w.entries[0]._opaque = true;
  w._previews.clear();
  const row = w.list().find((r) => r.id === id);
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(row.width, 5);
  assert.strictEqual(w.payload(id).type, 'image');
});

test('pinning a damaged image does not seal it as text', () => {
  const w = new Vault(path.join(tmp, 'image-pin.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(24, 4);
  full[0] = 0x89;
  full[1] = 0x50;
  full[2] = 0x4e;
  full[3] = 0x47;
  const id = w.addImage({ full, thumb: Buffer.alloc(4, 1), width: 4, height: 2 });
  const entry = w.entries[0];
  entry.blobs.meta.ct = Buffer.from('nope').toString('base64');
  entry._opaque = true;
  entry.type = undefined;
  entry.meta = undefined;
  assert.strictEqual(w.payload(id).type, 'image');
  entry.type = undefined;
  assert.strictEqual(w.togglePin(id), true);
  w.flush();
  w.lock();
  w.unlock('passphrase-123');
  const row = w.list().find((r) => r.id === id);
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(row.pinned, true);
  assert.strictEqual(w.payload(id).type, 'image');
});

test('an image can be stored when no thumbnail was captured', () => {
  const w = new Vault(path.join(tmp, 'no-thumb.json'));
  w.create('passphrase-123');
  const full = Buffer.alloc(12, 3);
  const id = w.addImage({ full, width: 2, height: 2 });
  assert.ok(id);
  const row = w.list().find((r) => r.id === id);
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(row.thumb, null);
  assert.strictEqual(w.payload(id).type, 'image');
});

test('create refuses to replace an existing vault', () => {
  const target = path.join(tmp, 'create-existing.json');
  const w = new Vault(target);
  w.create('passphrase-123');
  const id = w.addText('keep the original vault');
  w.flush();
  assert.throws(
    () => w.create('a-different-passphrase'),
    (e) => e instanceof VaultError && e.code === 'exists',
  );
  assert.strictEqual(w.payload(id).text, 'keep the original vault');
  w.lock();
  w.unlock('passphrase-123');
  assert.strictEqual(w.payload(id).text, 'keep the original vault');
});

test('open-vault verification uses the live header when the file is replaced', () => {
  const target = path.join(tmp, 'live-header.json');
  const replacement = path.join(tmp, 'replacement-header.json');
  const w = new Vault(target);
  w.create('same-passphrase');
  const id = w.addText('live memory');
  w.flush();
  const other = new Vault(replacement);
  other.create('same-passphrase');
  other.addText('replacement disk');
  other.flush();
  fs.copyFileSync(replacement, target);
  assert.strictEqual(w.unlock('same-passphrase'), true);
  assert.strictEqual(w.payload(id).text, 'live memory');
});

test('a malformed sibling row does not get deleted by a later save', () => {
  const target = path.join(tmp, 'malformed-row.json');
  const w = new Vault(target);
  w.create('passphrase-123');
  w.addText('valid row');
  w.flush();
  w.lock();
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  raw.entries.push({ id: 'damaged-row', ts: Date.now(), blobs: {} });
  fs.writeFileSync(target, JSON.stringify(raw));
  assert.throws(
    () => w.unlock('passphrase-123'),
    (e) => e instanceof VaultError && e.code === 'corrupt',
  );
  assert.strictEqual(w.locked, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).entries.length, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passing, ${process.exitCode ? 'FAILURES ABOVE' : 'all green'}`);
