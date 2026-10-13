'use strict';

/**
 * Inspects the vault the running app produced, using the same passphrase.
 *   node test/inspect-live.js <passphrase>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../src/crypto-store');

const passphrase = process.argv[2] || 'clipvault123';
const file = path.join(os.homedir(), 'AppData', 'Roaming', 'clipvault', 'vault.json');

if (!fs.existsSync(file)) {
  console.log('no live vault at', file);
  process.exit(1);
}

const vault = new Vault(file);
try {
  vault.unlock(passphrase);
} catch (err) {
  console.log('unlock failed:', err.code, err.message);
  process.exit(1);
}

const rows = vault.list();
console.log('live vault entries:', rows.length);
for (const row of rows) {
  const preview = row.type === 'image'
    ? `[image ${row.width}x${row.height}, thumb ${Math.round(row.thumb.length / 1024)}KB b64]`
    : JSON.stringify(row.text.slice(0, 64));
  console.log(' -', row.type.padEnd(5), new Date(row.ts).toLocaleTimeString(), preview);
}
console.log('stats:', JSON.stringify(vault.stats()));

const raw = fs.readFileSync(file, 'utf8');
// Needles must be long and contain bytes that base64 cannot produce, otherwise
// they collide with ciphertext by chance (a 3-char trigram appears ~once per
// 260KB of base64).
const needles = [
  'quick brown fox',
  'scryptSync',
  'github.com/example',
  'Meeting notes',
  'résumé',            // multi-byte: impossible in base64
  '✅',           // non-latin: impossible in base64
  '🦊',           // astral: impossible in base64
];
const leaks = needles.filter((n) => raw.includes(n));
console.log('file size:', raw.length, 'bytes');
console.log('plaintext leak check:', leaks.length ? `LEAK: ${leaks.join(', ')}` : 'no plaintext found in file');