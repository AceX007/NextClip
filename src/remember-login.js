'use strict';

/**
 * Boot-prompt and "remember me" policy.
 *
 * This module never touches the disk and never calls Electron. The passphrase
 * only appears as a function argument; callers seal it before writing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 1;

function clampRememberDays(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

function rememberExpiry(now, days) {
  return Number(now) + clampRememberDays(days) * DAY_MS;
}

function encodeRemember(passphrase, days, now, encrypt) {
  if (!passphrase) throw new Error('missing passphrase');
  const clamped = clampRememberDays(days);
  const secret = Buffer.from(encrypt(passphrase)).toString('base64');
  if (!secret) throw new Error('empty sealed secret');
  return {
    v: 1,
    expiresAt: rememberExpiry(now, clamped),
    days: clamped,
    secret,
  };
}

function decodeRemember(record, decrypt) {
  if (!record || record.v !== 1 || typeof record.secret !== 'string' || !record.secret) {
    return { ok: false, reason: 'absent' };
  }
  let passphrase;
  try {
    passphrase = decrypt(Buffer.from(record.secret, 'base64'));
  } catch {
    return { ok: false, reason: 'broken' };
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return { ok: false, reason: 'broken' };
  }
  return {
    ok: true,
    passphrase,
    expiresAt: Number(record.expiresAt),
    days: clampRememberDays(record.days),
  };
}

function encodeSession({ bootId, locked, passphrase, encrypt }) {
  const record = {
    v: 1,
    bootId: String(bootId),
    locked: Boolean(locked),
  };
  if (!record.locked && passphrase) {
    record.secret = Buffer.from(encrypt(passphrase)).toString('base64');
  }
  return record;
}

function decodeSession(record, decrypt) {
  if (!record || record.v !== 1 || typeof record.bootId !== 'string' || !record.bootId) return null;
  const locked = Boolean(record.locked);
  let passphrase = null;
  if (!locked && typeof record.secret === 'string' && record.secret) {
    try {
      const value = decrypt(Buffer.from(record.secret, 'base64'));
      if (typeof value === 'string' && value.length) passphrase = value;
    } catch {
      passphrase = null;
    }
  }
  return { bootId: record.bootId, locked, passphrase };
}

function classifyRemember(remember, now) {
  if (!remember) return { clear: false, valid: null };
  if (remember.reason === 'unavailable') return { clear: false, valid: null };
  if (!remember.ok || !(Number(remember.expiresAt) > now)) return { clear: true, valid: null };
  return { clear: false, valid: remember };
}

/**
 * What to do when the process starts.
 *
 * A matching boot id means the same Windows boot and logon, so an app restart
 * is not a new login. Remember-me skips the boot prompt until it expires.
 * A lock recorded for this boot still demands the passphrase.
 */
function decideStartup({ bootId, previousBootId, now, remember, session }) {
  const flags = classifyRemember(remember, now);
  // The sealed session carries its own boot identity. Trust that match even
  // if the separate marker write failed; otherwise a remembered login can
  // override a manual lock after an app restart on the same boot.
  const sessionThisBoot = bootId && session && session.bootId === bootId
    ? session
    : null;
  const newBoot = !bootId || (previousBootId !== bootId && !sessionThisBoot);

  if (sessionThisBoot && sessionThisBoot.locked) {
    return {
      action: 'prompt',
      passphrase: null,
      showPanel: false,
      clearRemember: flags.clear,
      clearSession: false,
      reason: 'locked-this-boot',
    };
  }

  if (flags.valid) {
    return {
      action: 'unlock',
      passphrase: flags.valid.passphrase,
      showPanel: false,
      clearRemember: false,
      clearSession: newBoot,
      reason: 'remember-me',
    };
  }

  if (sessionThisBoot && sessionThisBoot.passphrase && !sessionThisBoot.locked) {
    return {
      action: 'unlock',
      passphrase: sessionThisBoot.passphrase,
      showPanel: false,
      clearRemember: flags.clear,
      clearSession: false,
      reason: 'same-boot',
    };
  }

  return {
    action: 'prompt',
    passphrase: null,
    showPanel: newBoot,
    clearRemember: flags.clear,
    clearSession: newBoot,
    reason: !bootId ? 'boot-unknown' : (newBoot ? 'new-boot' : 'needs-unlock'),
  };
}

module.exports = {
  DAY_MS,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_DAYS,
  clampRememberDays,
  rememberExpiry,
  encodeRemember,
  decodeRemember,
  encodeSession,
  decodeSession,
  decideStartup,
};
