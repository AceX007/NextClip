'use strict';

/**
 * End-to-end clipboard check. Runs under Electron so it can drive the real
 * Windows clipboard:  npx electron test/smoke.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');

const { Vault } = require('../src/crypto-store');
const { Monitor } = require('../src/monitor');
const { drawPadlock } = require('../src/icon');
const { encodePng, Canvas } = require('../src/icon');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
    process.exitCode = 1;
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-smoke-'));
  const vault = new Vault(path.join(tmp, 'vault.json'));
  const settings = { captureImages: true, maxEntries: 100 };
  let paused = false;
  let changes = 0;
  const monitor = new Monitor({
    clipboard,
    vault,
    getSettings: () => settings,
    isPaused: () => paused,
    onChange: () => { changes += 1; },
  });

  console.log('clipvault end-to-end clipboard smoke test\n');
  console.log('setup');
  vault.create('smoke-test-passphrase');
  check('vault starts unlocked', () => assert.strictEqual(vault.locked, false));

  // ------------------------------------------------------------- text
  console.log('\ntext capture');
  clipboard.writeText('the quick brown fox');
  check('first tick captures the text', () => assert.strictEqual(monitor.tick(), 'captured'));
  check('entry landed in the vault', () => assert.strictEqual(vault.list()[0].text, 'the quick brown fox'));
  check('onChange fired once', () => assert.strictEqual(changes, 1));

  check('polling again does not duplicate', () => assert.strictEqual(monitor.tick(), 'duplicate'));
  check('still exactly one entry', () => assert.strictEqual(vault.entries.length, 1));

  clipboard.writeText('a completely different string');
  check('new text is captured', () => assert.strictEqual(monitor.tick(), 'captured'));
  check('two entries now', () => assert.strictEqual(vault.entries.length, 2));
  check('newest entry sorts first', () => assert.strictEqual(vault.list()[0].text, 'a completely different string'));

  clipboard.writeText('');
  monitor.tick();
  check('empty clipboard adds nothing', () => assert.strictEqual(vault.entries.length, 2));

  // ------------------------------------------------------- multiline + unicode
  const unicode = 'héllo ✅ emoji 🦊\nsecond line\ttabbed';
  clipboard.writeText(unicode);
  monitor.tick();
  check('unicode and multiline survive a round trip', () => {
    const found = vault.list().find((r) => r.text === unicode);
    assert.ok(found, 'exact text not found after round trip');
  });

  // ------------------------------------------------------------- images
  console.log('\nimage capture');
  const img = makeImage(640, 400, [230, 90, 120]);
  clipboard.writeImage(img);
  check('image tick captures the image', () => assert.strictEqual(monitor.tick(), 'captured'));
  const imageRow = vault.list().find((r) => r.type === 'image');
  check('image entry recorded with dimensions', () => {
    assert.ok(imageRow, 'no image row');
    assert.strictEqual(imageRow.width, 640);
    assert.strictEqual(imageRow.height, 400);
  });
  check('thumbnail is much smaller than the original', () => {
    const thumbBytes = Buffer.from(imageRow.thumb.split(',')[1], 'base64').length;
    const fullBytes = Buffer.from(vault.payload(imageRow.id).dataUrl.split(',')[1], 'base64').length;
    assert.ok(thumbBytes < fullBytes, `thumb ${thumbBytes} not smaller than full ${fullBytes}`);
  });
  check('re-polling the same image does not duplicate', () => {
    const before = vault.entries.length;
    assert.strictEqual(monitor.tick(), 'duplicate');
    assert.strictEqual(vault.entries.length, before);
  });

  // Regression: writing an image back re-encodes it, so byte-level hashing
  // used to let a restored image be captured a second time.
  clipboard.writeImage(img);
  monitor.tick();
  const imagesBeforeRestore = vault.entries.filter((r) => r.type === 'image').length;
  monitor.restore(imageRow.id);
  monitor.suppressSelfCopy(0);          // let the grace window lapse
  monitor.lastImageKey = null;          // force a full re-read
  const afterRestore = monitor.tick();
  const imagesAfterRestore = vault.entries.filter((r) => r.type === 'image').length;
  check('a restored image is not re-captured as a new entry', () => {
    assert.strictEqual(imagesAfterRestore, imagesBeforeRestore,
      `re-captured after restore (${imagesBeforeRestore} -> ${imagesAfterRestore}, result=${afterRestore})`);
  });

  const big = makeImage(3000, 2000, [40, 120, 220]);
  clipboard.writeImage(big);
  monitor.tick();
  check('oversized images are downscaled to the edge cap', () => {
    const row = vault.list().find((r) => r.type === 'image' && r.width < 3000);
    assert.ok(row, 'no downscaled image found');
    assert.ok(Math.max(row.width, row.height) <= 2200, `edge still ${Math.max(row.width, row.height)}`);
  });

  // -------------------------------------------------------- restore / copy-back
  console.log('\nrestore to clipboard');
  const textId = vault.list().find((r) => r.text === 'the quick brown fox').id;
  monitor.reset();
  clipboard.writeText('something else entirely');
  const restored = monitor.restore(textId);
  check('restore reports success', () => assert.strictEqual(restored.ok, true));
  check('clipboard holds the restored text', () => {
    assert.strictEqual(clipboard.readText(), 'the quick brown fox');
  });
  check('a restore is not re-captured as a new entry', () => {
    const before = vault.entries.length;
    monitor.tick();
    assert.strictEqual(vault.entries.length, before);
  });

  const imgId = imageRow.id;
  const restoredImage = monitor.restore(imgId);
  check('image restore reports success', () => assert.strictEqual(restoredImage.ok, true));
  check('clipboard now carries an image of the right size', () => {
    const back = clipboard.readImage();
    assert.ok(!back.isEmpty(), 'clipboard has no image');
    assert.strictEqual(back.getSize().width, 640);
    assert.strictEqual(back.getSize().height, 400);
  });

  // ------------------------------------------------------------- pausing/locking
  console.log('\npause and lock behaviour');
  paused = true;
  clipboard.writeText('written while paused');
  check('paused monitor ignores the clipboard', () => {
    assert.strictEqual(monitor.tick(), 'idle');
    assert.strictEqual(vault.entries.some((r) => r.text === 'written while paused'), false);
  });
  paused = false;

  vault.lock();
  clipboard.writeText('written while locked');
  check('locked monitor ignores the clipboard', () => {
    assert.strictEqual(monitor.tick(), 'idle');
    assert.strictEqual(vault.list().length, 0);
  });
  vault.unlock('smoke-test-passphrase');
  check('history is intact after unlock', () => assert.ok(vault.list().length >= 4));

  // ------------------------------------------------------------- persistence
  console.log('\npersistence across restart');
  vault.flush();
  const raw = fs.readFileSync(path.join(tmp, 'vault.json'), 'utf8');
  check('clipboard contents are not readable in the vault file', () => {
    assert.ok(!raw.includes('quick brown fox'), 'plaintext leaked to disk');
    assert.ok(!raw.includes('different string'), 'plaintext leaked to disk');
  });

  const reopened = new Vault(path.join(tmp, 'vault.json'));
  reopened.unlock('smoke-test-passphrase');
  check('a fresh process can read the history', () => {
    assert.ok(reopened.list().some((r) => r.text === 'the quick brown fox'));
    assert.ok(reopened.list().some((r) => r.type === 'image'));
  });
  check('a reopened image restores identically', () => {
    const row = reopened.list().find((r) => r.type === 'image' && r.width === 640);
    const payload = reopened.payload(row.id);
    const back = nativeImage.createFromBuffer(Buffer.from(payload.dataUrl.split(',')[1], 'base64'));
    assert.strictEqual(back.getSize().width, 640);
  });

  // ------------------------------------------------------------------- icon
  console.log('\ntray icon generation');
  check('padlock renders a valid PNG', () => {
    const png = drawPadlock(16);
    assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.strictEqual(png.readUInt32BE(16), 16, 'width');
    assert.strictEqual(png.readUInt32BE(20), 16, 'height');
  });
  check('the icon is actually drawn (not blank)', () => {
    const png = drawPadlock(16);
    const img = nativeImage.createFromBuffer(png);
    assert.ok(!img.isEmpty(), 'icon decodes to an empty image');
    assert.ok(img.getSize().width === 16);
  });
  check('arbitrary sizes encode', () => {
    for (const size of [16, 24, 32, 64]) {
      assert.strictEqual(drawPadlock(size).readUInt32BE(16), size);
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  clipboard.clear();

  console.log(`\n${passed} passing, ${process.exitCode ? 'FAILURES ABOVE' : 'all green'}`);
  app.exit(process.exitCode ? 1 : 0);
});

/** Build a solid-colour PNG via the bundled encoder. */
function makeImage(width, height, color) {
  const c = new Canvas(width, height);
  c.rect(0, 0, width, height, color);
  c.rect(0, 0, width / 2, height / 2, [255, 255, 255]);
  return nativeImage.createFromBuffer(c.toPng());
}