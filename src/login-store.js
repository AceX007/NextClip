'use strict';

/**
 * On-disk half of the boot prompt. The passphrase is sealed by the injected
 * codec (DPAPI via safeStorage in the app) and is never written as text.
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_DAYS,
  clampRememberDays,
  encodeRemember,
  decodeRemember,
  encodeSession,
  decodeSession,
} = require('./remember-login');

class LoginStore {
  constructor(dir, codec) {
    this.dir = dir;
    this.codec = codec;
    this.rememberFile = path.join(dir, 'remember-login.json');
    this.sessionFile = path.join(dir, 'boot-session.json');
    this.bootFile = path.join(dir, 'boot-id.txt');
    this.view = { active: false, days: DEFAULT_DAYS, expiresAt: null };
  }

  status(now = Date.now()) {
    const active = Boolean(this.view.active && Number(this.view.expiresAt) > now);
    return {
      active,
      days: active ? clampRememberDays(this.view.days) : DEFAULT_DAYS,
    };
  }

  expiryAt() {
    return Number.isFinite(this.view.expiresAt) ? this.view.expiresAt : null;
  }

  readBootMarker() {
    try {
      const text = fs.readFileSync(this.bootFile, 'utf8').trim();
      if (!text || text.length > 300 || /[\r\n]/.test(text)) return null;
      return text;
    } catch {
      return null;
    }
  }

  writeBootMarker(id) {
    if (!id) return;
    this._writeText(this.bootFile, String(id));
  }

  loadRemember(now) {
    const record = this._readJson(this.rememberFile);
    if (!record) {
      this.view = { active: false, days: DEFAULT_DAYS, expiresAt: null };
      return null;
    }
    if (!this._available()) {
      this.view = { active: false, days: DEFAULT_DAYS, expiresAt: null };
      return { ok: false, reason: 'unavailable' };
    }
    const decoded = decodeRemember(record, (buf) => this.codec.decrypt(buf));
    const valid = Boolean(decoded.ok && decoded.expiresAt > now);
    this.view = {
      active: valid,
      days: valid ? decoded.days : DEFAULT_DAYS,
      expiresAt: valid ? decoded.expiresAt : null,
    };
    return decoded;
  }

  loadSession() {
    const record = this._readJson(this.sessionFile);
    if (!record) return null;
    if (!this._available()) return null;
    return decodeSession(record, (buf) => this.codec.decrypt(buf));
  }

  /**
   * Persist the checkbox choice after a successful create or unlock.
   * Unchecked deletes any remembered login. The same-boot session is updated
   * either way so an app restart does not look like a new login.
   */
  applyUnlock({ enabled, days, passphrase, bootId, now }) {
    if (!passphrase) return { saved: false };
    if (!enabled) {
      // Removing a remembered secret does not require safeStorage. Returning
      // early when DPAPI was unavailable left an old token active even though
      // the user had explicitly unchecked Remember me.
      this.clearRemember();
      if (bootId && this._available()) {
        this._writeJson(this.sessionFile, encodeSession({
          bootId,
          locked: false,
          passphrase,
          encrypt: (plain) => this.codec.encrypt(plain),
        }));
      } else {
        this.clearSession();
      }
      return { saved: true };
    }
    if (!this._available()) {
      this.view = { active: false, days: DEFAULT_DAYS, expiresAt: null };
      return { saved: false, unavailable: true };
    }
    const record = encodeRemember(passphrase, days, now, (plain) => this.codec.encrypt(plain));
    this._writeJson(this.rememberFile, record);
    this.view = { active: true, days: record.days, expiresAt: record.expiresAt };
    if (bootId) this._writeJson(this.sessionFile, { v: 1, bootId: String(bootId), locked: false });
    else this.clearSession();
    return { saved: true };
  }

  /** Remember-me unlocked us, or a same-boot restart did. Refresh the session flag. */
  noteRunningUnlocked({ bootId, passphrase, viaRemember }) {
    if (!bootId || !this._available()) return;
    if (viaRemember) {
      this._writeJson(this.sessionFile, { v: 1, bootId: String(bootId), locked: false });
      return;
    }
    if (!passphrase) return;
    this._writeJson(this.sessionFile, encodeSession({
      bootId,
      locked: false,
      passphrase,
      encrypt: (plain) => this.codec.encrypt(plain),
    }));
  }

  noteLocked(bootId) {
    if (!bootId) {
      // Without a boot identity there is no safe way to scope the manual
      // lock to this boot. Remove both unlock paths so a restart still asks.
      this.forgetAll();
      return;
    }
    // Drop the session secret. Remember-me stays for a later boot, but this
    // boot must ask again if the process restarts after a lock. This record
    // is not encrypted, so safeStorage availability must not gate the write.
    this._writeJson(this.sessionFile, { v: 1, bootId: String(bootId), locked: true });
  }

  /** Passphrase change and vault destruction both forget the remembered login. */
  invalidatePassphrase(passphrase, bootId) {
    this.clearRemember();
    if (bootId && passphrase && this._available()) {
      this._writeJson(this.sessionFile, encodeSession({
        bootId,
        locked: false,
        passphrase,
        encrypt: (plain) => this.codec.encrypt(plain),
      }));
      return;
    }
    this.clearSession();
  }

  forgetAll() {
    let firstError = null;
    try { this.clearRemember(); }
    catch (err) { firstError = err; }
    try { this.clearSession(); }
    catch (err) { if (!firstError) firstError = err; }
    if (firstError) throw firstError;
  }

  clearRemember() {
    this._remove(this.rememberFile);
    this.view = { active: false, days: DEFAULT_DAYS, expiresAt: null };
  }

  clearSession() {
    this._remove(this.sessionFile);
  }

  _available() {
    try { return Boolean(this.codec && this.codec.available()); }
    catch { return false; }
  }

  _readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeJson(file, value) {
    this._writeText(file, JSON.stringify(value));
  }

  _writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const backup = `${file}.${process.pid}.bak`;
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (firstError) {
      let movedOld = false;
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(backup, { force: true });
          fs.renameSync(file, backup);
          movedOld = true;
        }
        fs.renameSync(tmp, file);
      } catch (err) {
        if (movedOld && !fs.existsSync(file)) {
          try { fs.renameSync(backup, file); }
          catch { /* preserve the backup for manual recovery */ }
        }
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err || firstError;
      }
      if (movedOld) {
        try { fs.rmSync(backup, { force: true }); } catch { /* stale backup is harmless */ }
      }
    }
  }

  _remove(file) {
    try { fs.rmSync(file, { force: true }); }
    catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = { LoginStore };
