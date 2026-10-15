'use strict';

// Keep GUI Electron detached from terminal pipes. Only this Node launcher
// reports results; the hidden test window writes its own durable report.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nextclip-ui-'));
const env = { ...process.env, CLIPVAULT_UI_ARTIFACTS: artifacts };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'ui-regression.js')], {
  env, windowsHide: true, stdio: 'ignore',
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 90000);

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`Could not start UI tests: ${error.message}`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  clearTimeout(timeout);
  const reportFile = path.join(artifacts, 'ui-regression-report.json');
  if (fs.existsSync(reportFile)) {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    console.log(`${report.passed} UI checks passed, ${report.failed} failed.`);
    for (const failure of report.failures) console.error(`${failure.name}\n${failure.error}`);
    process.exitCode = code === 0 && report.failed === 0 ? 0 : 1;
  } else {
    console.error(timedOut ? 'UI tests timed out.' : `UI tests stopped with exit code ${code}.`);
    const logFile = path.join(artifacts, 'ui-test.log');
    if (fs.existsSync(logFile)) console.error(fs.readFileSync(logFile, 'utf8'));
    process.exitCode = 1;
  }
  console.log(`UI report and screenshots: ${artifacts}`);
});
