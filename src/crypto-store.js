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
    if (!isEnvelope(envelope)) throw new VaultError('corrupt', 'missing ciphertext envelope');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError('corrupt', 'entry failed authentication');
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  create(passphrase) {
    if (!passphrase || passphrase.length < 6) {
      throw new VaultError('weak', 'Passphrase must be at least 6 characters.');
    }
    if (this.hasVault()) {
      throw new VaultError('exists', 'A vault already exists.');
    }
    const salt = crypto.randomBytes(16);
    const newKey = this._deriveKey(passphrase, salt);
    // Swap the key only after a successful write. Doing it first used to leave
    // an empty vault in memory when mkdir/rename failed, and the next save
    // then replaced the real file with that empty vault under a new key.
    const previous = {
      key: this.key,
      entries: this.entries,
      kdfMeta: this.kdfMeta,
      checkEnvelope: this.checkEnvelope,
    };
    this.key = newKey;
    try {
      this.entries = [];
      this._previews.clear();
      this._fingerprint.clear();
      this.kdfMeta = { ...KDF, salt: salt.toString('base64') };
      this.checkEnvelope = this._seal(SENTINEL);
      this._write();
    } catch (err) {
      this.key = previous.key;
      this.entries = previous.entries;
      this.kdfMeta = previous.kdfMeta;
      this.checkEnvelope = previous.checkEnvelope;
      this._previews.clear();
      this._reindex();
      throw err;
    }
    return true;
  }

  unlock(passphrase) {
    // Changing the passphrase verifies the current phrase while the vault is
    // already open. Use the in-memory header for that check. Re-reading a file
    // replaced by another process could otherwise install its key while the
    // live entries are still sealed with the original key.
    if (!this.locked) {
      if (!this.kdfMeta || typeof this.kdfMeta.salt !== 'string' || !this.checkEnvelope) {
        throw new VaultError('corrupt', 'Vault key check is missing.');
      }
      const liveKey = this.key;
      let candidate;
      try {
        const salt = Buffer.from(this.kdfMeta.salt, 'base64');
        if (!salt.length) throw new VaultError('corrupt', 'Unsupported vault format.');
        candidate = this._deriveKey(passphrase, salt);
      } catch (err) {
        if (err instanceof VaultError) throw err;
        throw new VaultError('corrupt', 'Unsupported vault format.');
      }
      this.key = candidate;
      let opened;
      try {
        opened = this._open(this.checkEnvelope);
      } catch {
        throw new VaultError('badpass', 'Incorrect passphrase.');
      } finally {
        this.key = liveKey;
      }
      if (opened.toString('utf8') !== SENTINEL) {
        throw new VaultError('corrupt', 'Vault key check is damaged.');
      }
      return true;
    }

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
    if (!file || file.version !== VERSION || !file.kdf || typeof file.kdf.salt !== 'string' || !file.kdf.salt) {
      throw new VaultError('corrupt', 'Unsupported vault format.');
    }
    // A missing check blob is damage, not a wrong passphrase. Authentication
    // failure of a well-formed blob still cannot be told apart from a bad key.
    if (!isEnvelope(file.check)) {
      throw new VaultError('corrupt', 'Vault key check is missing.');
    }

    let candidate;
    try {
      const salt = Buffer.from(file.kdf.salt, 'base64');
      if (!salt.length) throw new VaultError('corrupt', 'Unsupported vault format.');
      candidate = this._deriveKey(passphrase, salt);
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError('corrupt', 'Unsupported vault format.');
    }

    // Verify against the sealed sentinel *without* clobbering current state.
    // Authentication failure cannot be told apart from a wrong key. A blob
    // that authenticates but is not the sentinel is damage: the passphrase
    // was able to open it.
    const previousKey = this.key;
    this.key = candidate;
    let opened;
    try {
      opened = this._open(file.check);
    } catch {
      this.key = previousKey;
      throw new VaultError('badpass', 'Incorrect passphrase.');
    }
    if (opened.toString('utf8') !== SENTINEL) {
      this.key = previousKey;
      throw new VaultError('corrupt', 'Vault key check is damaged.');
    }

    // `entries: []` is an empty vault. A missing key is too. Anything else
    // (null, an object) must not be treated as empty: the next save would
    // replace it with [].
    if (Object.prototype.hasOwnProperty.call(file, 'entries') && !Array.isArray(file.entries)) {
      this.key = previousKey;
      throw new VaultError('corrupt', 'Unsupported vault format.');
    }
    const source = Array.isArray(file.entries) ? file.entries : [];
    const entries = source.filter(isEntry);
    // Silently filtering malformed rows makes the next routine save delete
    // their raw ciphertext. Refuse the file instead so recovery remains
    // possible from the untouched bytes on disk.
    if (entries.length !== source.length) {
      this.key = previousKey;
      throw new VaultError('corrupt', 'A vault entry is malformed.');
    }
    // Decrypt per-entry metadata now so the UI can sort without reopening
    // ciphertext on every render. A row whose metadata will not open still
    // stays when its clip does, so the next save does not delete it. If the
    // file has rows and none of them can be read, refuse to install the key:
    // an empty in-memory vault would be written over that ciphertext.
    let readable = 0;
    for (const entry of entries) {
      try {
        hydrate(entry, this.key);
        readable += 1;
      } catch {
        entry._opaque = true;
        try {
          const buf = this._open(entry.blobs.content);
          if (!entry.type) entry.type = looksLikePng(buf) ? 'image' : 'text';
          readable += 1;
        } catch {
          // Metadata and content both failed. The row stays in `entries` only
          // when some sibling can be read; otherwise the check below refuses
          // the file and leaves it untouched.
        }
      }
    }
    if (source.length > 0 && readable === 0) {
      this.key = previousKey;
      throw new VaultError('corrupt', 'A vault entry could not be decrypted.');
    }
    this.entries = entries;
    this.kdfMeta = { ...KDF, salt: file.kdf.salt };
    this.checkEnvelope = file.check;
    this._reindex();
    return true;
  }

  lock() {
    // Flush first. If the write fails, stay unlocked: clearing the key and
    // then unlocking again reloads the stale file and drops clips that were
    // still only in memory.
    if (!this.flush()) {
      throw new VaultError('io', 'Could not save the vault, so it stays unlocked.');
    }
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

  _matching(fp) {
    if (!fp) return null;
    return this._find(this._fingerprint.get(fp));
  }

  /* ---------------------------------------------------------------- write */

  addText(text) {
    if (this.locked) return null;
    if (typeof text !== 'string') return null;
    const normalized = text.replace(/\r\n/g, '\n');
    if (!normalized.length) return null;
    const fp = this._fingerprintOf(Buffer.from(normalized, 'utf8'));
    const existing = this._matching(fp);
    if (existing) {
      if (!this._contentOpens(existing)) {
        // Repair in place. Removing the row and inserting a new one dropped
        // its pin and changed its id, so undo and pin state could not follow
        // the clip the user just copied again.
        const pinned = Boolean(existing.pinned);
        const content = this._seal(Buffer.from(normalized, 'utf8'));
        const meta = this._sealMeta({ ...(existing.meta || {}), type: 'text', pinned });
        existing.blobs = { ...existing.blobs, content, meta };
        existing.type = 'text';
        existing.pinned = pinned;
        existing._opaque = false;
        existing.ts = this._nextTs();
        this._touch();
        return existing.id;
      }
      return this._bumpOpened(existing);
    }

    const entry = {
      id: crypto.randomUUID(),
      ts: this._nextTs(),
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
    if (this.locked) return null;
    if (!full || !full.length) return null;
    // Callers may supply a pixel-based fingerprint: re-encoding the same image
    // produces different PNG bytes, so hashing the bytes would let a restored
    // image land in the history a second time. A repeat copy bumps the existing
    // row instead of disappearing: retention ages from `ts`, and returning null
    // used to leave that age unchanged so the image was pruned right after a recopy.
    const fp = fingerprint || this._fingerprintOf(full);
    const existing = this._matching(fp);
    if (existing) {
      const pinned = Boolean(existing.pinned);
      if (!this._contentOpens(existing)) {
        const content = this._seal(full);
        const sealedThumb = thumb == null ? null : this._seal(thumb);
        const meta = this._sealMeta({ type: 'image', pinned, width, height });
        const blobs = { ...existing.blobs, content, meta };
        if (sealedThumb) blobs.thumb = sealedThumb;
        existing.blobs = blobs;
        existing.type = 'image';
        existing.pinned = pinned;
        existing.meta = { width, height };
        existing._opaque = false;
        existing.ts = this._nextTs();
        this._touch();
        return existing.id;
      }
      if (thumb != null && thumb.length && !this._blobOpens(existing.blobs && existing.blobs.thumb)) {
        const healed = {
          type: 'image',
          pinned,
          width: existing.meta && existing.meta.width != null ? existing.meta.width : width,
          height: existing.meta && existing.meta.height != null ? existing.meta.height : height,
        };
        const sealedThumb = this._seal(thumb);
        const sealedMeta = this._sealMeta(healed);
        existing.blobs = { ...existing.blobs, thumb: sealedThumb, meta: sealedMeta };
        existing.type = healed.type;
        existing.pinned = pinned;
        existing.meta = { width: healed.width, height: healed.height };
        existing._opaque = false;
      }
      return this._bumpOpened(existing);
    }
    const blobs = {
      meta: this._sealMeta({ type: 'image', pinned: false, width, height }),
      content: this._seal(full),
    };
    if (thumb != null) blobs.thumb = this._seal(thumb);
    const entry = {
      id: crypto.randomUUID(),
      ts: this._nextTs(),
      type: 'image',
      pinned: false,
      fp,
      meta: { width, height },
      blobs,
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

  /**
   * Timestamp for a new or bumped entry. Wall-clock ties are common when
   * several copies land in one millisecond; a tie sorts in insertion order
   * and then trim() deletes the wrong end of the list.
   */
  _nextTs() {
    let newest = 0;
    for (const entry of this.entries) {
      if (entry.ts > newest) newest = entry.ts;
    }
    return Math.max(Date.now(), newest + 1);
  }

  _fingerprintWith(key, buf) {
    // HMAC rather than a bare digest: no guessable plaintext hash sits in
    // process memory, and duplicate checks stay cheap.
    return crypto.createHmac('sha256', key).update(buf).digest('base64');
  }

  _fingerprintOf(buf) {
    return this._fingerprintWith(this.key, buf);
  }

  _blobOpens(envelope) {
    try {
      if (!isEnvelope(envelope)) return false;
      this._open(envelope);
      return true;
    } catch {
      return false;
    }
  }

  _contentOpens(entry) {
    return Boolean(entry && entry.blobs && this._blobOpens(entry.blobs.content));
  }

  /**
   * Re-copying should surface the existing row. The caller has already
   * checked that this ciphertext opens. A row whose metadata failed is
   * rebuilt from the clip so the next save does not keep a broken meta blob.
   * Returns the existing id.
   */
  _bumpOpened(existing) {
    if (existing._opaque) {
      const buf = this._open(existing.blobs.content);
      if (!existing.type) existing.type = looksLikePng(buf) ? 'image' : 'text';
      existing.pinned = Boolean(existing.pinned);
      existing._opaque = false;
      existing.blobs.meta = this._sealMeta({
        ...(existing.meta || {}),
        type: existing.type,
        pinned: existing.pinned,
      });
    }
    existing.ts = this._nextTs();
    this._touch();
    return existing.id;
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
    if (this.locked) return false;
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [gone] = this.entries.splice(idx, 1);
    if (gone.fp) this._fingerprint.delete(gone.fp);
    this._previews.delete(id);
    this._save();
    return true;
  }

  togglePin(id) {
    if (this.locked) return false;
    const entry = this._find(id);
    if (!entry) return false;
    // Seal the new metadata before flipping memory. A throw used to leave
    // the pin bit and the ciphertext disagreeing, and a missing type was
    // omitted from JSON so the next unlock stored the row as text.
    let type = entry.type;
    if (type !== 'image' && type !== 'text') {
      try {
        const buf = this._open(entry.blobs.content);
        type = looksLikePng(buf) ? 'image' : 'text';
      } catch {
        return false;
      }
    }
    const pinned = !entry.pinned;
    const meta = this._sealMeta({ ...(entry.meta || {}), type, pinned });
    entry.type = type;
    entry.pinned = pinned;
    entry.blobs.meta = meta;
    entry._opaque = false;
    this._save();
    return entry.pinned;
  }

  /** Restore an entry age after a delayed bitmap proves the text was only
   * another flavor of the same clipboard item. */
  restoreTimestamp(id, timestamp) {
    if (this.locked || !Number.isFinite(Number(timestamp))) return false;
    const entry = this._find(id);
    if (!entry) return false;
    entry.ts = Number(timestamp);
    this.entries.sort((a, b) => b.ts - a.ts);
    this._save();
    return true;
  }

  clearAll() {
    if (this.locked) return;
    this.entries = [];
    this._previews.clear();
    this._fingerprint.clear();
    this._save();
  }

  trim(maxEntries) {
    if (this.locked) return 0;
    const limit = Math.max(20, maxEntries | 0);
    let removed = 0;
    while (this.entries.length > limit) {
      // Entries are newest-first, but timestamps can still tie. Evict the
      // oldest unpinned row. Pinned rows are never evicted. Walking from the
      // front used to delete the clip that was just captured once the cap
      // was reached, and then every capture after that.
      let idx = -1;
      for (let i = 0; i < this.entries.length; i += 1) {
        const entry = this.entries[i];
        // Pin state of a row whose metadata would not decrypt is unknown, so
        // it is kept. Evicting it would delete ciphertext we could not classify.
        if (entry.pinned || entry._opaque) continue;
        if (idx === -1 || entry.ts < this.entries[idx].ts) idx = i;
      }
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
      if (entry.pinned || entry._opaque || entry.ts >= cutoff) continue;
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

  changePassphrase(next, options = {}) {
    if (this.locked) throw new VaultError('locked', 'Vault is locked.');
    if (!next || next.length < 6) throw new VaultError('weak', 'Passphrase must be at least 6 characters.');

    const oldKey = this.key;
    const oldEntries = this.entries;
    const oldKdf = this.kdfMeta;
    const oldCheck = this.checkEnvelope;
    // Phase 1: read every blob under the old key *before* swapping it.
    // A row whose content will not open cannot be re-sealed. Dropping just
    // that row lets the passphrase change finish; if nothing can be read,
    // refuse before the key changes so the vault is not locked to a new
    // passphrase with no history.
    const readable = [];
    for (const entry of oldEntries) {
      try {
        const out = {};
        for (const [name, envelope] of Object.entries(entry.blobs || {})) {
          try {
            out[name] = this._open(envelope);
          } catch (err) {
            if (!(err instanceof VaultError)) throw err;
            // Content is the clip. Metadata and the thumbnail can be rebuilt
            // or omitted; without content there is nothing to re-seal.
            if (name === 'content') throw err;
          }
        }
        if (!out.content) throw new VaultError('corrupt', 'A vault entry could not be decrypted.');
        if (!out.meta) {
          const type = entry.type || (looksLikePng(out.content) ? 'image' : 'text');
          out.meta = Buffer.from(JSON.stringify({
            type,
            pinned: Boolean(entry.pinned),
            ...(entry.meta || {}),
          }), 'utf8');
        }
        readable.push({ entry, out });
      } catch (err) {
        if (!(err instanceof VaultError)) throw err;
      }
    }
    if (oldEntries.length > 0 && readable.length === 0) {
      throw new VaultError('corrupt', 'A vault entry could not be decrypted.');
    }

    // Phase 2: re-seal everything under the new key, in memory only.
    // If the write fails, roll the key AND the envelopes back. Restoring only
    // the key leaves ciphertext the old key cannot open, and the next save
    // persists that mix.
    const salt = crypto.randomBytes(16);
    const newKey = this._deriveKey(next, salt);
    this.key = newKey;
    try {
      const check = this._seal(SENTINEL);
      const entries = readable.map(({ entry, out }) => {
        const blobs = {};
        for (const [name, buf] of Object.entries(out)) blobs[name] = this._seal(buf);
        // Fingerprints are HMACs under the master key. Move text and
        // byte-based image fingerprints with the key. Pixel-based image
        // fingerprints need the PNG decoded before they can be re-keyed.
        let fp = entry.fp;
        if (out.content && fp && fp === this._fingerprintWith(oldKey, out.content)) {
          fp = this._fingerprintWith(newKey, out.content);
        } else if (out.content && fp && entry.type === 'image'
            && typeof options.fingerprintImage === 'function') {
          try {
            const pixels = options.fingerprintImage(out.content);
            if (pixels && pixels.length) fp = this._fingerprintWith(newKey, pixels);
          } catch {
            // Keep the authenticated image if its PNG cannot be decoded.
          }
        }
        const copy = { ...entry, fp, blobs };
        delete copy._opaque;
        if (!copy.type) copy.type = looksLikePng(out.content) ? 'image' : 'text';
        copy.pinned = Boolean(copy.pinned);
        return copy;
      });
      this.entries = entries;
      this.kdfMeta = { ...KDF, salt: salt.toString('base64') };
      this.checkEnvelope = check;
      this._previews.clear();
      this._reindex();
      this._write();
    } catch (err) {
      this.key = oldKey;
      this.entries = oldEntries;
      this.kdfMeta = oldKdf;
      this.checkEnvelope = oldCheck;
      this._previews.clear();
      this._reindex();
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
        try {
          if (entry._opaque) {
            // Metadata failed, but the clip itself may still open. Show that
            // row; a broken thumbnail or a broken sibling must not hide it.
            // A type already known on the row must not be rewritten just
            // because the bytes are not a PNG.
            const buf = this._open(entry.blobs.content);
            if (entry.type !== 'image' && entry.type !== 'text') {
              entry.type = looksLikePng(buf) ? 'image' : 'text';
            }
            if (entry.type === 'image') preview = { thumb: null };
            else preview = { text: buf.toString('utf8') };
          } else if (entry.type === 'image') {
            let thumb = null;
            try {
              thumb = this._open(entry.blobs.thumb).toString('base64');
            } catch {
              thumb = null;
            }
            preview = { thumb };
          } else {
            preview = { text: this._open(entry.blobs.content).toString('utf8') };
          }
        } catch {
          // One undecryptable blob must not reject the whole history list.
          continue;
        }
        this._previews.set(entry.id, preview);
      }
      rows.push({
        id: entry.id,
        ts: entry.ts,
        pinned: Boolean(entry.pinned),
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
    try {
      const buf = this._open(entry.blobs.content);
      let type = entry.type;
      if (type !== 'image' && type !== 'text') {
        type = looksLikePng(buf) ? 'image' : 'text';
        entry.type = type;
      }
      return type === 'image'
        ? { type: 'image', dataUrl: `data:image/png;base64,${buf.toString('base64')}` }
        : { type: 'text', text: buf.toString('utf8') };
    } catch {
      return null;
    }
  }

  /**
   * Capture the current entry list so a destructive action can be undone.
   * Blobs are immutable envelopes, so a shallow copy of each record is safe.
   */
  snapshot() {
    if (this.locked) return null;
    return this.entries.map((e) => ({ ...e, blobs: { ...e.blobs } }));
  }

  /**
   * Put back entries a destructive action removed. Clips captured after the
   * snapshot stay; replacing the whole list used to discard them on Undo.
   * Returns how many entries were put back.
   */
  restoreSnapshot(snapshot) {
    if (this.locked || !Array.isArray(snapshot)) return 0;
    const liveIds = new Set();
    const liveFp = new Set();
    for (const entry of this.entries) {
      liveIds.add(entry.id);
      if (entry.fp) liveFp.add(entry.fp);
    }
    const added = [];
    for (const entry of snapshot) {
      if (!entry || typeof entry.id !== 'string' || !entry.blobs) continue;
      if (liveIds.has(entry.id)) continue;
      if (entry.fp && liveFp.has(entry.fp)) continue;
      // Snapshots taken before a passphrase change are sealed with the old
      // key. Putting those blobs back made the next unlock fail for every row.
      // Metadata can be rebuilt when the clip itself still opens.
      const copy = { ...entry, blobs: { ...entry.blobs } };
      if (!this._acceptRestored(copy)) continue;
      delete copy._opaque;
      this.entries.push(copy);
      liveIds.add(copy.id);
      if (copy.fp) liveFp.add(copy.fp);
      added.push(copy);
    }
    if (!added.length) return 0;
    this._previews.clear();
    this._reindex();
    this.entries.sort((a, b) => b.ts - a.ts);
    if (!this.flush()) {
      for (const copy of added) {
        const idx = this.entries.indexOf(copy);
        if (idx !== -1) this.entries.splice(idx, 1);
      }
      this._previews.clear();
      this._reindex();
      this.entries.sort((a, b) => b.ts - a.ts);
      throw new VaultError('io', 'Could not save the vault, so the undo was not kept.');
    }
    return added.length;
  }

  /**
   * True when `copy` belongs to the current key. Metadata is enough; if it
   * will not open, the clip itself must. Old-key snapshots fail both and are
   * left out.
   */
  _acceptRestored(copy) {
    try {
      hydrate(copy, this.key);
      return true;
    } catch {
      let buf;
      try {
        buf = this._open(copy.blobs.content);
      } catch {
        return false;
      }
      const pinned = Boolean(copy.pinned);
      const type = copy.type || (looksLikePng(buf) ? 'image' : 'text');
      const meta = {
        width: copy.meta && copy.meta.width,
        height: copy.meta && copy.meta.height,
      };
      let sealed;
      try {
        sealed = this._sealMeta({ ...meta, type, pinned });
      } catch {
        return false;
      }
      copy.type = type;
      copy.pinned = pinned;
      copy.meta = meta;
      copy.blobs = { ...copy.blobs, meta: sealed };
      return true;
    }
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
      return true;
    } catch (err) {
      console.error('[clipvault] vault flush failed:', err.message);
      return false;
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
  // A missing metadata envelope is damage, not a reason to drop the row.
  // Filtering it out here deletes the clip on the next save.
  return Boolean(e)
    && typeof e.id === 'string'
    && e.id.length > 0
    && e.blobs
    && typeof e.blobs === 'object'
    && (isEnvelope(e.blobs.meta) || isEnvelope(e.blobs.content));
}

function isEnvelope(envelope) {
  return Boolean(envelope)
    && typeof envelope.iv === 'string'
    && typeof envelope.tag === 'string'
    && typeof envelope.ct === 'string';
}

function looksLikePng(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= 4
    && buf[0] === 0x89
    && buf[1] === 0x50
    && buf[2] === 0x4e
    && buf[3] === 0x47;
}

module.exports = { Vault, VaultError };
