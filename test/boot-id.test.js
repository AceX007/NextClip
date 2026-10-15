'use strict';

const assert = require('assert');
const { parseBootIdOutput } = require('../src/boot-id');

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

const REG = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters',
  '    BootId    REG_DWORD    0x29',
  '',
].join('\r\n');

console.log('clipvault boot id');

test('combines the Windows boot id and the logon session', () => {
  const parsed = parseBootIdOutput(REG, 'S-1-5-5-0-854563\r\n');
  assert.strictEqual(parsed.id, '41|S-1-5-5-0-854563');
  assert.strictEqual(parsed.source, 'boot+logon');
});

test('pads in the registry dword do not change the id', () => {
  const wide = REG.replace('0x29', '0x00000029');
  assert.strictEqual(parseBootIdOutput(wide, 'S-1-5-5-0-1').id, parseBootIdOutput(REG, 'S-1-5-5-0-1').id);
});

test('falls back to the boot id when the logon id is missing', () => {
  const parsed = parseBootIdOutput(REG, '');
  assert.strictEqual(parsed.id, '41');
  assert.strictEqual(parsed.source, 'boot');
});

test('reports unavailable when the boot id is missing', () => {
  const parsed = parseBootIdOutput('not a registry dump', 'S-1-5-5-0-1');
  assert.strictEqual(parsed.id, null);
  assert.strictEqual(parsed.source, 'unavailable');
});

if (process.exitCode) console.error(`\n${passed} passed, failures above`);
else console.log(`\n${passed} passed`);
