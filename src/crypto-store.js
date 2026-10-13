'use strict';

/**
 * Encrypted clipboard vault.
 *
 * Design notes:
 *  - The master key is derived from the user passphrase with scrypt (N=2^14, r=8, p=1).
 *  - Every stored blob is sealed with AES-256-GCM using a fresh random 12-byte IV.
 *  - Entry type, the pinned flag and the payload all live *inside* ciphertext. The
 *    file on disk only carries opaque material: an id, a timestamp, blob sizes and
 *    base64 ciphertext. Metadata needed for fast UI (type, pinned) is decrypted into
 *    memory at unlock time.
 *  - A sealed sentinel tells "wrong passphrase" apart from "corrupt file".
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SENTINEL = 'clipvault/v1/keycheck';
const KDF = {
  algo: 'scrypt',
  N: 1 << 14,
  r: 8,
  p: 1,
  maxmem: 96 * 1024 * 1024,
};

class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Vault {
  constructor(file) {
    this.file = file;
    this.key = null;
    this.entries = [];            // in-memory records; blobs stay encrypted on disk
    this._previews = new Map();   // id -> display payload
    this._fingerprint = new Map();// fingerprint -> id (dedupe while unlocked)
    this._flushTimer = null;
    this.kdfMeta = null;          // retained so routine saves never rewrite the header
    this.checkEnvelope = null;
  }

  get locked() {
    return this.key === null;
  }

  hasVault() {
    return fs.existsSync(this.file);
  }

  /* ---------------------------------------------------------------- keys */

  _deriveKey(passphrase, salt) {
    return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_BYTES, KDF);
  }

  _seal(plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  _open(envelope) {
    if (!envelope) throw new VaultError('corrupt', 'missing ciphertext envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    } catch {
      throw new VaultError('corrupt', 'entry failed authentication');
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  create(passphrase) {
    if (!passphrase || passphrase.length < 6) {
      throw new VaultError('weak', 'Passphrase must be at least 6 characters.');
    }
    const salt = crypto.randomBytes(16);
    this.key = this._deriveKey(passphrase, salt);
    this.entries = [];
    this._previews.clear();
    this._fingerprint.clear();
    this.kdfMeta = { ...KDF, salt: salt.toString('base64') };
    this.checkEnvelope = this._seal(SENTINEL);
    this._write();
    return true;
  }

  unlock(passphrase) {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      throw new VaultError('missing', 'No vault found.');
    }
    let file;
    try {
      file = JSON.parse(raw);
    } catch {
      throw new VaultError('corrupt', 'Vault file is not valid JSON.');
    }
    if (!file || file.version !== VERSION || !file.kdf || !file.kdf.salt) {
      throw new VaultError('corrupt', 'Unsupported vault format.');
    }

    const salt = Buffer.from(file.kdf.salt, 'base64');
    const candidate = this._deriveKey(passphrase, salt);

    // Verify against the sealed sentinel *without* clobbering current state.
    const previousKey = this.key;
    this.key = candidate;
    let ok = false;
    try {
      ok = this._open(file.check).toString('utf8') === SENTINEL;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.key = previousKey;
      throw new VaultError('badpass', 'Incorrect passphrase.');
    }

    const entries = (Array.isArray(file.entries) ? file.entries : []).filter(isEntry);
    // Decrypt the per-entry metadata now so the UI can sort/filter without
    // re-opening ciphertext on every render.
    for (const entry of entries) hydrate(entry, this.key);
    this.entries = entries;
    this.kdfMeta = { ...KDF, salt: file.kdf.salt };
    this.checkEnvelope = file.check;
    this._reindex();
    return true;
  }

  lock() {
    this.flush();
    this.key = null;
    this._previews.clear();
    this._fingerprint.clear();
  }

  /* ------------------------------------------------------------ indexing */

  _reindex() {
    this._previews.clear();
    this._fingerprint.clear();
    for (const entry of this.entries) {
      if (entry.fp) this._fingerprint.set(entry.fp, entry.id);
    }
  }

  _find(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /* ---------------------------------------------------------------- write */

  addText(text) {
    if (typeof text !== 'string') return null;
    const normalized = text.replace(/\r\n/g, '\n');
    if (!normalized.length) return null;
    const fp = this._fingerprintOf(Buffer.from(normalized, 'utf8'));

    const dupId = this._fingerprint.get(fp);
    if (dupId) {
      const existing = this._find(dupId);
      if (existing) {
        // Re-copying moves an entry back to the top. Date.now() can tie with the
        // newest entry when two copies land in the same millisecond, so make the
        // bump strictly monotonic and keep the sort deterministic.
        const newest = this.entries.reduce((max, e) => (e.ts > max ? e.ts : max), 0);
        existing.ts = Math.max(Date.now(), newest + 1);
        this._touch();
        return existing.id;
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'text',
      pinned: false,
      fp,
      blobs: {
        meta: this._sealMeta({ type: 'text', pinned: false }),
        content: this._seal(Buffer.from(normalized, 'utf8')),
      },
    };
    this._push(entry);
    return entry.id;
  }

  addImage({ full, thumb, width, height, fingerprint }) {
    if (!full || !full.length) return null;
    // Callers may supply a pixel-based fingerprint: re-encoding the same image
    // produces different PNG bytes, so hashing the bytes would let a restored
    // image land in the history a second time.
    const fp = fingerprint || this._fingerprintOf(full);
    if (this._fingerprint.has(fp)) return null;
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'image',
      pinned: false,
      fp,
      meta: { width, height },
      blobs: {
        meta: this._sealMeta({ type: 'image', pinned: false, width, height }),
        content: this._seal(full),
        thumb: this._seal(thumb),
      },
    };
    this._push(entry);
    return entry.id;
  }

  /** Fingerprint arbitrary bytes under the current key (used for pixel hashing). */
  fingerprint(buf) {
    if (this.locked) return null;
    return this._fingerprintOf(buf);
  }

  _sealMeta(meta) {
    return this._seal(Buffer.from(JSON.stringify(meta), 'utf8'));
  }

  _fingerprintOf(buf) {
    // HMAC rather than a bare digest: no guessable plaintext hash sits in
    // process memory, and duplicate checks stay cheap.
    return crypto.createHmac('sha256', this.key).update(buf).digest('base64');
  }

  _push(entry) {
    this.entries.push(entry);
    this._fingerprint.set(entry.fp, entry.id);
    this._touch();
  }

  _touch() {
    this.entries.sort((a, b) => b.ts - a.ts);
    this._previews.clear();
    this._save();
  }

  remove(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [gone] = this.entries.splice(idx, 1);
    if (gone.fp) this._fingerprint.delete(gone.fp);
    this._previews.delete(id);
    this._save();
    return true;
  }

  togglePin(id) {
    const entry = this._find(id);
    if (!entry) return false;
    entry.pinned = !entry.pinned;
    entry.blobs.meta = this._sealMeta({ type: entry.type, pinned: entry.pinned, ...(entry.meta || {}) });
    this._save();
    return entry.pinned;
  }

  clearAll() {
    this.entries = [];
    this._previews.clear();
    this._fingerprint.clear();
    this._save();
  }

  trim(maxEntries) {
    const limit = Math.max(20, maxEntries | 0);
    let removed = 0;
    while (this.entries.length > limit) {
      const idx = this.entries.findIndex((e) => !e.pinned); // pinned is never evicted
      if (idx === -1) break;
      const [gone] = this.entries.splice(idx, 1);
      if (gone.fp) this._fingerprint.delete(gone.fp);
      removed += 1;
    }
    if (removed) {
      this._previews.clear();
      this._save();
    }
    return removed;
  }

  /**
   * Delete unpinned entries older than `hours`. Pinned entries are never
   * touched, and a non-positive `hours` disables the sweep entirely.
   */
  pruneOlderThan(hours, now = Date.now()) {
    if (this.locked || !hours || hours <= 0) return 0;
    const cutoff = now - hours * 3_600_000;
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry.pinned || entry.ts >= cutoff) continue;
      this.entries.splice(i, 1);
      if (entry.fp) this._fingerprint.delete(entry.fp);
      removed += 1;
    }
    if (removed) {
      this._previews.clear();
      this._save();
    }
    return removed;
  }

  changePassphrase(next) {
    if (this.locked) throw new VaultError('locked', 'Vault is locked.');
    if (!next || next.length < 6) throw new VaultError('weak', 'Passphrase must be at least 6 characters.');

    const oldKey = this.key;
    // Phase 1: read every blob under the old key *before* swapping it.
    const plaintexts = this.entries.map((entry) => {
      const out = {};
      for (const [name, envelope] of Object.entries(entry.blobs)) out[name] = this._open(envelope);
      return out;
    });

    // Phase 2: re-seal everything under the new key, in memory only.
    const salt = crypto.randomBytes(16);
    const newKey = this._deriveKey(next, salt);
    this.key = newKey;
    try {
      const check = this._seal(SENTINEL);
      const entries = this.entries.map((entry, i) => {
        const blobs = {};
        for (const [name, buf] of Object.entries(plaintexts[i])) blobs[name] = this._seal(buf);
        return { ...entry, blobs };
      });
      this.entries = entries;
      this.kdfMeta = { ...KDF, salt: salt.toString('base64') };
      this.checkEnvelope = check;
      this._previews.clear();
      this._reindex();
      this._write();
    } catch (err) {
      this.key = oldKey;
      throw err;
    }
    return true;
  }

  /* ----------------------------------------------------------------- read */

  /** Decrypted, display-ready rows. Thumbnails are tiny so this stays cheap. */
  list() {
    if (this.locked) return [];
    const rows = [];
    for (const entry of this.entries) {
      let preview = this._previews.get(entry.id);
      if (!preview) {
        preview = entry.type === 'image'
          ? { thumb: this._open(entry.blobs.thumb).toString('base64') }
          : { text: this._open(entry.blobs.content).toString('utf8') };
        this._previews.set(entry.id, preview);
      }
      rows.push({
        id: entry.id,
        ts: entry.ts,
        pinned: entry.pinned,
        type: entry.type,
        width: entry.meta?.width ?? null,
        height: entry.meta?.height ?? null,
        text: preview.text ?? null,
        thumb: preview.thumb ? `data:image/png;base64,${preview.thumb}` : null,
      });
    }
    return rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.ts - a.ts));
  }

  /** Full payload, fetched only when the user actually restores an entry. */
  payload(id) {
    if (this.locked) return null;
    const entry = this._find(id);
    if (!entry) return null;
    const buf = this._open(entry.blobs.content);
    return entry.type === 'image'
      ? { type: 'image', dataUrl: `data:image/png;base64,${buf.toString('base64')}` }
      : { type: 'text', text: buf.toString('utf8') };
  }

  /**
   * Capture the current entry list so a destructive action can be undone.
   * Blobs are immutable envelopes, so a shallow copy of each record is safe.
   */
  snapshot() {
    if (this.locked) return null;
    return this.entries.map((e) => ({ ...e, blobs: { ...e.blobs } }));
  }

  /** Restore a snapshot taken by snapshot(), replacing everything after it. */
  restoreSnapshot(snapshot) {
    if (this.locked || !Array.isArray(snapshot)) return 0;
    this.entries = snapshot.map((e) => ({ ...e, blobs: { ...e.blobs } }));
    this._previews.clear();
    this._reindex();
    this.flush();
    return this.entries.length;
  }

  stats() {
    return {
      entries: this.entries.length,
      text: this.entries.filter((e) => e.type === 'text').length,
      images: this.entries.filter((e) => e.type === 'image').length,
      pinned: this.entries.filter((e) => e.pinned).length,
    };
  }

  /* -------------------------------------------------------------- persist */

  _write() {
    if (this.locked || !this.kdfMeta || !this.checkEnvelope) return;
    const doc = {
      version: VERSION,
      kdf: this.kdfMeta,
      check: this.checkEnvelope,
      // Only opaque fields: ids, timestamps, fingerprints and ciphertext.
      entries: this.entries.map((e) => ({ id: e.id, ts: e.ts, fp: e.fp, blobs: e.blobs })),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _save() {
    if (this.locked || !this.kdfMeta || !this.checkEnvelope) return;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      try {
        this._write();
      } catch (err) {
        console.error('[clipvault] vault write failed:', err.message);
      }
    }, 350);
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    try {
      this._write();
    } catch (err) {
      console.error('[clipvault] vault flush failed:', err.message);
    }
  }
}

/** Pull the sealed per-entry metadata back into memory after unlock. */
function hydrate(entry, key) {
  const meta = JSON.parse(decryptWith(entry.blobs.meta, key).toString('utf8'));
  entry.type = meta.type || 'text';
  entry.pinned = Boolean(meta.pinned);
  entry.meta = { width: meta.width, height: meta.height };
}

function decryptWith(envelope, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
}

function isEntry(e) {
  return e && typeof e.id === 'string' && e.blobs && typeof e.blobs === 'object' && e.blobs.meta;
}

module.exports = { Vault, VaultError };