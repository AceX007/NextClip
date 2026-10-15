'use strict';

/**
 * Identifies the current Windows boot and interactive logon.
 * An app restart keeps both; a reboot or a new sign-in changes the id.
 */

const { execFile } = require('child_process');

function parseBootIdOutput(regText, whoamiText) {
  const match = String(regText || '').match(/BootId\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
  if (!match) return { id: null, source: 'unavailable' };
  const boot = String(parseInt(match[1], 16));
  if (!boot || boot === 'NaN') return { id: null, source: 'unavailable' };
  const logon = String(whoamiText || '').split(/\r?\n/).map((line) => line.trim()).find((line) => /^S-1-5-5-/.test(line));
  if (!logon) return { id: boot, source: 'boot' };
  return { id: `${boot}|${logon}`, source: 'boot+logon' };
}

function execText(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 4000, encoding: 'utf8' }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout || ''));
    });
  });
}

async function queryWindowsBootId() {
  if (process.platform !== 'win32') return { id: null, source: 'unavailable' };
  const [regText, whoamiText] = await Promise.all([
    execText('reg.exe', [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters',
      '/v',
      'BootId',
    ]),
    execText('whoami.exe', ['/logonid']),
  ]);
  return parseBootIdOutput(regText, whoamiText);
}

module.exports = { parseBootIdOutput, queryWindowsBootId };
