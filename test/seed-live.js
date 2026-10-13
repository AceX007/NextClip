'use strict';

/**
 * Seeds the app's real vault with a realistic mixed history so the panel can be
 * exercised (and screenshotted) without depending on OS clipboard timing.
 *   node test/seed-live.js [passphrase]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../src/crypto-store');
const { Canvas } = require('../src/icon');

const passphrase = process.argv[2] || 'clipvault123';
const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'clipvault');
const file = path.join(dir, 'vault.json');

fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file)) fs.rmSync(file);

const vault = new Vault(file);
vault.create(passphrase);

const samples = [
  'npm install --save-dev electron',
  'https://github.com/example/encrypted-clipboard.git',
  'Meeting notes:\n- ship the panel on Friday\n- ask about the encryption design\n- budget: 1200 EUR',
  'café ☕ résumé — ünïcödé tëst ✅ 🦊',
  'const key = crypto.scryptSync(pass, salt, 32, { N: 1 << 14, r: 8, p: 1 });',
  'ERROR: connection to /api/v2/users timed out after 30000ms',
  // Deliberately NOT credential-shaped: GitHub push protection blocks any
  // push containing a string that looks like a real API secret, fake or not.
  '{"token": "example-placeholder-not-a-real-secret-0000"}',
];

for (const text of samples) {
  vault.addText(text);
}

// A few colourful "screenshots" so the thumbnail path is visible.
const swatches = [
  [880, 560, [64, 132, 245], [140, 200, 255], 'gradient'],
  [640, 640, [232, 90, 110], [255, 200, 90], 'gradient'],
  [1200, 420, [40, 180, 140], [200, 240, 120], 'blocks'],
];

for (const [w, h, a, b, style] of swatches) {
  const full = paint(w, h, a, b, style);
  // The real monitor stores a downscaled thumbnail alongside the full image.
  const tw = 320;
  const th = Math.max(1, Math.round((h / w) * tw));
  vault.addImage({ full, thumb: paint(tw, th, a, b, style), width: w, height: h });
}

// Pin one text entry so the pin badge is visible in the screenshot.
const list = vault.list();
const toPin = list.find((r) => r.text && r.text.includes('scryptSync'));
if (toPin) vault.togglePin(toPin.id);

vault.flush();

const raw = fs.readFileSync(file, 'utf8');
console.log(`seeded ${vault.stats().entries} entries -> ${file}`);
console.log(`file size: ${raw.length} bytes`);
console.log('contains plaintext sample:', raw.includes('scryptSync') ? 'LEAK' : 'no');
console.log('passphrase:', passphrase);

/** Paint a simple gradient or blocky image as PNG bytes. */
function paint(w, h, a, b, style) {
  const canvas = new Canvas(w, h);
  canvas.rect(0, 0, w, h, a);
  if (style === 'gradient') {
    for (let y = 0; y < h; y += 1) {
      const t = y / h;
      canvas.rect(0, y, w, y + 1, [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
      ]);
    }
  } else {
    for (let i = 0; i < 6; i += 1) {
      canvas.rect(w * 0.08 * i, h * 0.18 * i, w * 0.08 * i + w * 0.32, h * 0.18 * i + h * 0.42, b);
    }
  }
  return canvas.toPng();
}