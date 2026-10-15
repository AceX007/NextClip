'use strict';

/**
 * Clipboard watcher.
 *
 * Lives apart from main.js so it can be driven directly in tests: it takes the
 * pieces it needs (clipboard module, vault, settings) and exposes a single
 * tick() plus a restore() that round-trips an entry back to the system.
 */

const { nativeImage } = require('electron');

const IMAGE_MAX_EDGE = 2200;
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const THUMB_MAX_EDGE = 320;
const SELF_COPY_GRACE_MS = 900;
const MAX_TEXT_BYTES = 1024 * 1024;
// How long a text hit may be collapsed when the same clipboard item's image
// arrives on a later poll (delayed bitmap render).
const TEXT_IMAGE_RACE_MS = 1500;
// Real Explorer drops. text/uri-list is not one of them: browsers put it on
// ordinary URL copies, and treating it as a file drop swallowed the link.
const FILE_DROP_FORMATS = ['FileNameW', 'CF_HDROP', 'Shell IDList Array'];

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function isFileUriText(text) {
  const lines = normalizeText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^file:/i.test(line));
}

function readUriList(clipboard) {
  if (!clipboard || typeof clipboard.readBuffer !== 'function') return '';
  try {
    const bytes = clipboard.readBuffer('text/uri-list');
    if (!Buffer.isBuffer(bytes) || !bytes.length) return '';
    const lines = bytes.toString('utf8').replace(/\0/g, '').split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && /^[a-z][a-z0-9+.-]*:/i.test(line));
    return lines.join('\n');
  } catch {
    return '';
  }
}

function codePointChar(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF) return '';
  if (code >= 0xD800 && code <= 0xDFFF) return '';
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  // Decode in one pass. Sequential replacements turn `&amp;lt;` into `<`
  // even though the clipboard text represented the literal string `&lt;`.
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return codePointChar(parseInt(lower.slice(2), 16)) || whole;
    if (lower.startsWith('#')) return codePointChar(Number(lower.slice(1))) || whole;
    return named[lower] ?? whole;
  });
}

function htmlToPlain(html) {
  const raw = String(html || '');
  if (!raw || raw.length > MAX_TEXT_BYTES * 2) return '';
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = decodeHtmlEntities(stripped);
  return normalizeText(decoded)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Downscale oversized clipboard bitmaps the same way every fingerprint does. */
function scaledImage(image) {
  const size0 = image.getSize();
  if (!size0 || size0.width < 1 || size0.height < 1) return null;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(size0.width, size0.height));
  if (!(scale < 1)) return { image, size0, size: size0 };
  const resized = image.resize({
    width: Math.max(1, Math.round(size0.width * scale)),
    height: Math.max(1, Math.round(size0.height * scale)),
    quality: 'good',
  });
  const size = resized.getSize();
  if (!size || size.width < 1 || size.height < 1) return null;
  return { image: resized, size0, size };
}

class Monitor {
  constructor({ clipboard, vault, settings, getSettings, onChange, isPaused }) {
    this.clipboard = clipboard;
    this.vault = vault;
    this.settings = settings;      // fallback when no live getter is supplied
    this.getSettings = getSettings || (() => this.settings);
    this.onChange = onChange || (() => {});
    this.isPaused = isPaused || (() => false);
    this.lastText = null;
    this.lastImageKey = null;
    this.lastImageFp = null;
    this.lastImageBytesFp = null;
    this.selfCopyUntil = 0;
    // Clipboard text/pixels we ourselves just wrote. Kept until the clipboard
    // actually changes. The grace timer only covers the OS publish race;
    // after it, a raw compare misses Windows CRLF conversion and re-files
    // the restore as a new copy (which also resets that clip's retention age).
    // Image PNG length is the same trap: a re-encode changes the byte size
    // while the pixels stay put, so the fingerprint has to outlive that.
    this.suppressedText = null;
    this.suppressedImageFp = null;
    // What was on the clipboard immediately before our write. A tick that
    // lands inside the grace window can still see it.
    this.staleText = null;
    this.staleImageFp = null;
    this.foreignKind = null;
    this.emptyStreak = 0;
    // Text filed on the previous poll that may have been the early half of
    // one clipboard item whose bitmap was not ready yet.
    this.racedText = null;
    // Sibling text that belongs to the image currently on the clipboard.
    // While that image stays, the text is not filed as its own row. A new
    // string, or the image going away, still captures.
    this.imageTextLatch = null;
    this.imageLatchFp = null;
    this.imageSeenAt = 0;
    this.stats = { captured: 0, skipped: 0, failed: 0 };
  }

  clearImageLatch() {
    this.imageTextLatch = null;
    this.imageLatchFp = null;
    this.imageSeenAt = 0;
  }

  forgetClipboardMemory() {
    this.lastText = null;
    this.lastImageKey = null;
    this.lastImageFp = null;
    this.lastImageBytesFp = null;
    this.suppressedText = null;
    this.suppressedImageFp = null;
    this.staleText = null;
    this.staleImageFp = null;
    this.foreignKind = null;
    this.racedText = null;
    this.emptyStreak = 0;
    this.selfCopyUntil = 0;
    this.clearImageLatch();
  }

  /**
   * The bitmap now on the clipboard is the one we already adopted, including
   * the downscale used for its fingerprint. A poll that ran inside
   * writeImage already filed it; forgetting the fingerprint would file it again.
   */
  currentImageMatchesLast() {
    if (!this.lastImageFp || String(this.lastImageFp).startsWith('too-large:')) return false;
    try {
      const formats = this.clipboard.availableFormats() || [];
      if (!formats.some((f) => typeof f === 'string' && f.startsWith('image/'))) return false;
      const image = this.clipboard.readImage();
      if (!image || image.isEmpty()) return false;
      const scaled = scaledImage(image);
      if (!scaled) return false;
      const fp = this.vault.fingerprint(scaled.image.toBitmap());
      return !!(fp && fp === this.lastImageFp);
    } catch {
      return false;
    }
  }

  /** Called when an entry is pushed back onto the clipboard by the user. */
  suppressSelfCopy(ms = SELF_COPY_GRACE_MS) {
    this.selfCopyUntil = Date.now() + ms;
  }

  /**
   * A screenshot (or anything else we wrote on purpose and DO want filed)
   * must not be swallowed by a restore that is still sitting on the clipboard.
   */
  noticeExternalClipboard() {
    if (this.currentImageMatchesLast()) {
      // Keep the fingerprint so the next poll sees a duplicate, not a recopy.
      this.suppressedText = null;
      this.suppressedImageFp = null;
      this.staleText = null;
      this.staleImageFp = null;
      this.lastText = null;
      this.foreignKind = null;
      this.racedText = null;
      this.emptyStreak = 0;
      this.selfCopyUntil = 0;
      this.clearImageLatch();
      return;
    }
    this.forgetClipboardMemory();
  }

  reset() {
    this.forgetClipboardMemory();
  }

  captureImagesEnabled() {
    try {
      const settings = this.getSettings();
      return Boolean(settings && settings.captureImages);
    } catch {
      return false;
    }
  }

  /**
   * The clipboard left text/image content (files, empty, or an unknown
   * format). Forget the last clip so copying it again refreshes its age,
   * and drop restore suppression — the clipboard really did change.
   * File copies only count as skipped once per streak.
   */
  noteForeign(kind) {
    const first = this.foreignKind !== kind
      || this.lastText != null
      || this.lastImageKey != null
      || this.lastImageFp != null
      || this.suppressedText != null
      || this.suppressedImageFp != null;
    this.lastText = null;
    this.lastImageKey = null;
    this.lastImageFp = null;
    this.lastImageBytesFp = null;
    this.suppressedText = null;
    this.suppressedImageFp = null;
    this.racedText = null;
    this.emptyStreak = 0;
    this.foreignKind = kind;
    this.clearImageLatch();
    if (first && kind === 'files') this.stats.skipped += 1;
  }

  /** Best-effort read of whatever is on the clipboard before we replace it. */
  snapshotClipboard() {
    const snap = { text: null, imageFp: null };
    try {
      const formats = this.clipboard.availableFormats() || [];
      if (formats.includes('text/plain')) {
        const text = this.clipboard.readText();
        if (text) snap.text = normalizeText(text);
      }
      if (formats.some((f) => typeof f === 'string' && f.startsWith('image/'))) {
        const image = this.clipboard.readImage();
        if (image && !image.isEmpty()) {
          try {
            const scaled = scaledImage(image);
            if (scaled) snap.imageFp = this.vault.fingerprint(scaled.image.toBitmap());
          }
          catch { snap.imageFp = null; }
        }
      }
    } catch { /* the grace window still covers a missed snapshot */ }
    return snap;
  }

  tick() {
    if (this.vault.locked || this.isPaused()) return 'idle';

    let formats = [];
    try {
      formats = this.clipboard.availableFormats() || [];
    } catch {
      this.stats.failed += 1;
      return 'error';
    }
    if (!Array.isArray(formats)) formats = [];

    const duringGrace = Date.now() < this.selfCopyUntil;
    if (!duringGrace) {
      this.staleText = null;
      this.staleImageFp = null;
    }

    const fileLike = formats.some((f) => FILE_DROP_FORMATS.includes(f));
    const hasImage = formats.some((f) => typeof f === 'string' && f.startsWith('image/'));
    const hasPlain = formats.includes('text/plain');

    let siblingText = '';
    const uriList = formats.includes('text/uri-list');
    const uriListText = uriList ? readUriList(this.clipboard) : '';
    if (hasPlain) {
      try {
        siblingText = this.clipboard.readText() || '';
      } catch {
        this.stats.failed += 1;
        return 'error';
      }
    }
    // Some apps publish a URL only as text/uri-list. Reading it as bytes
    // preserves ordinary links while still allowing file:// entries to be
    // excluded below.
    if (!siblingText && !hasImage && uriListText) {
      siblingText = normalizeText(uriListText).split('\n')
        .filter((line) => !/^file:/i.test(line.trim()))
        .join('\n');
    }
    // HTML-only copies (and an empty text/plain paired with HTML) still have
    // the words the user copied. Skip this when an image is listed: that
    // bitmap is the clipboard item, and the HTML is its source.
    if (!siblingText && !hasImage && formats.includes('text/html')
        && this.clipboard && typeof this.clipboard.readHTML === 'function') {
      try { siblingText = htmlToPlain(this.clipboard.readHTML()); }
      catch { siblingText = ''; }
    }

    const fileDrop = fileLike || (uriList && isFileUriText(uriListText || siblingText));

    // A screenshot tool often sets CF_HDROP beside the bitmap. The image is
    // the clip; the path is not. Try the image before classifying files.
    if (hasImage && this.captureImagesEnabled()) {
      const outcome = this.captureImage(siblingText, duringGrace);
      if (outcome !== 'empty') {
        this.emptyStreak = 0;
        return outcome;
      }
      // Pixels were listed but not readable. Text on that clipboard still
      // counts. A file path next to a drop does not.
      if (siblingText && !fileDrop) {
        this.emptyStreak = 0;
        return this.captureText(siblingText, duringGrace);
      }
      // One undecoded image is the gap before a delayed bitmap, not proof
      // the clipboard changed. Forgetting a restore here re-files it.
      if (duringGrace) return 'self-copy';
      this.emptyStreak += 1;
      if (this.emptyStreak < 2) return 'empty';
      this.noteForeign(fileDrop ? 'files' : 'other');
      return fileDrop ? 'files' : 'empty';
    }

    // Explorer file copies are not clipboard-history items. During the
    // publish grace they may still be the previous clipboard, so don't
    // forget a restore because of that stale read.
    if (fileDrop) {
      if (duringGrace) return 'self-copy';
      this.noteForeign('files');
      return 'files';
    }

    if (siblingText) {
      this.emptyStreak = 0;
      return this.captureText(siblingText, duringGrace);
    }

    if (duringGrace) return 'self-copy';

    // A single empty read is often the gap between clipboard updates.
    // Forgetting a restore on that gap re-files it and resets its age.
    const transient = !formats.length || (hasPlain && !siblingText);
    if (transient) {
      this.emptyStreak += 1;
      if (this.emptyStreak < 2) return 'empty';
    }
    this.noteForeign(formats.length ? 'other' : 'empty');
    return 'empty';
  }

  /**
   * Text sitting next to an image we already adopted. File it when it is a
   * new copy. Keep it off the history when it is the text flavor of that
   * same image (it showed up with the bitmap, or within the race window).
   * Returns null when the image result should stand.
   */
  considerSiblingText(siblingText, duringGrace) {
    const normalized = normalizeText(siblingText);
    if (!normalized) return null;
    if (this.suppressedText && normalized === this.suppressedText) return null;
    const prev = this.lastText == null ? null : normalizeText(this.lastText);
    if (prev != null && prev === normalized) return null;
    const sameImage = !!(this.imageLatchFp && this.lastImageFp && this.imageLatchFp === this.lastImageFp);
    if (sameImage && this.imageTextLatch && this.imageTextLatch === normalized) return null;
    const fresh = sameImage && this.imageSeenAt && (Date.now() - this.imageSeenAt) < TEXT_IMAGE_RACE_MS;
    if (fresh && !this.imageTextLatch) {
      this.imageTextLatch = normalized;
      return null;
    }
    return this.captureText(siblingText, duringGrace, { keepImage: true });
  }

  captureText(text, duringGrace, options = {}) {
    const normalized = normalizeText(text);
    const keepImage = Boolean(options.keepImage);
    if (!normalized) return 'empty';

    // OS has not published our write yet. Don't file the previous clip, and
    // don't drop the suppression that is waiting for the write to land.
    if (duringGrace && this.staleText && normalized === this.staleText) return 'self-copy';

    if (this.suppressedText && normalized === this.suppressedText) {
      // Keep the normalized text for as long as the clipboard still holds it.
      // Windows turns \n into \r\n; comparing the raw strings re-files it.
      this.lastText = text;
      if (!keepImage) {
        this.lastImageKey = null;
        this.lastImageFp = null;
        this.lastImageBytesFp = null;
        this.suppressedImageFp = null;
        this.clearImageLatch();
      }
      this.foreignKind = null;
      return 'self-copy';
    }
    this.suppressedText = null;
    if (!(keepImage && this.suppressedImageFp && this.lastImageFp === this.suppressedImageFp)) {
      this.suppressedImageFp = null;
    }

    const prev = this.lastText == null ? null : normalizeText(this.lastText);
    if (prev != null && normalized === prev) {
      if (!keepImage) {
        this.lastImageKey = null;
        this.lastImageFp = null;
        this.lastImageBytesFp = null;
        this.clearImageLatch();
      }
      return 'duplicate';
    }

    if (Buffer.byteLength(normalized, 'utf8') > MAX_TEXT_BYTES) {
      this.lastText = text;
      if (!keepImage) {
        this.lastImageKey = null;
        this.lastImageFp = null;
        this.lastImageBytesFp = null;
        this.clearImageLatch();
      }
      this.foreignKind = null;
      this.stats.skipped += 1;
      return 'too-large';
    }

    const tsBefore = new Map();
    if (Array.isArray(this.vault.entries)) {
      for (const entry of this.vault.entries) {
        if (entry && entry.id) tsBefore.set(entry.id, entry.ts);
      }
    }
    const before = Array.isArray(this.vault.entries) ? this.vault.entries.length : null;
    let id;
    try {
      // Store LF. The vault fingerprints the same normalization, and Windows
      // will hand the next poll back with CRLF.
      id = this.vault.addText(normalized);
    } catch {
      this.stats.failed += 1;
      return 'error';
    }
    this.lastText = normalized;
    if (!keepImage) {
      this.lastImageKey = null;
      this.lastImageFp = null;
      this.lastImageBytesFp = null;
      this.clearImageLatch();
    }
    this.foreignKind = null;
    const after = Array.isArray(this.vault.entries) ? this.vault.entries.length : null;
    const created = before != null && after != null && after > before;
    if (keepImage) {
      // This text is its own clip beside an image we are keeping. Don't let
      // the image race delete it, and don't drop the image fingerprint.
      this.racedText = null;
    } else if (created && id) {
      this.racedText = { id, normalized, at: Date.now() };
    } else if (id && tsBefore.has(id)) {
      const prevTs = tsBefore.get(id);
      const entry = this.vault.entries.find((e) => e.id === id);
      // A late bitmap for this same clipboard bumps an older row's age before
      // the pixels arrive. Remember the previous age so the image can put it back.
      if (entry && entry.ts !== prevTs) this.racedText = { id, normalized, at: Date.now(), prevTs };
      else if (!this.racedText || this.racedText.normalized !== normalized) this.racedText = null;
    } else if (!this.racedText || this.racedText.normalized !== normalized) this.racedText = null;
    if (!id) return 'duplicate';
    this.stats.captured += 1;
    this.onChange();
    return 'captured';
  }

  captureImage(siblingText, duringGrace) {
    let image;
    try {
      image = this.clipboard.readImage();
    } catch {
      // Text on the same clipboard still needs a chance to be filed.
      if (!siblingText) this.stats.failed += 1;
      return 'empty';
    }
    if (!image || image.isEmpty()) return 'empty';

    let scaled;
    try {
      scaled = scaledImage(image);
    } catch {
      if (!siblingText) this.stats.failed += 1;
      return 'empty';
    }
    if (!scaled) return 'empty';
    const { size0 } = scaled;
    const full = scaled.image;
    const size = scaled.size;

    let png;
    try {
      // Encode after the downscale. toPNG() on the full bitmap throws or
      // stalls the poll for a large screenshot, and the copy is missed.
      png = full.toPNG();
    } catch {
      if (!siblingText) this.stats.failed += 1;
      return 'empty';
    }

    const key = `${size0.width}x${size0.height}:${png.length}`;
    // Exact encoded bytes are a safe fast path. Dimensions and encoded size
    // alone are not: two different images can share both values.
    let pngFp = null;
    if (png.length <= IMAGE_MAX_BYTES && key === this.lastImageKey && this.lastImageFp) {
      try { pngFp = this.vault.fingerprint(png); }
      catch { pngFp = null; }
    }
    const fingerprintPng = () => {
      if (pngFp) return pngFp;
      try { pngFp = this.vault.fingerprint(png); }
      catch { pngFp = null; }
      return pngFp;
    };
    if (pngFp && pngFp === this.lastImageBytesFp && this.lastImageFp) {
      if (duringGrace && this.staleImageFp && this.lastImageFp === this.staleImageFp) return 'self-copy';
      if (this.suppressedImageFp && this.lastImageFp === this.suppressedImageFp) {
        this.foreignKind = null;
        return 'self-copy';
      }
      const beside = this.considerSiblingText(siblingText, duringGrace);
      if (beside) return beside;
      if (!normalizeText(siblingText)) this.lastText = null;
      this.foreignKind = null;
      return 'duplicate';
    }

    if (png.length > IMAGE_MAX_BYTES) {
      const standIn = `too-large:${key}`;
      const first = this.lastImageFp !== standIn;
      this.lastImageKey = key;
      // Stand-in so repeated polls do not count the same oversized image as
      // skipped again.
      this.lastImageFp = standIn;
      this.lastImageBytesFp = null;
      this.suppressedText = null;
      this.suppressedImageFp = null;
      this.foreignKind = null;
      this.clearImageLatch();
      if (first) this.stats.skipped += 1;
      if (siblingText) {
        const textOutcome = this.captureText(siblingText, duringGrace, { keepImage: true });
        this.lastImageKey = key;
        this.lastImageFp = standIn;
        return textOutcome === 'empty' ? 'too-large' : textOutcome;
      }
      this.lastText = null;
      return 'too-large';
    }

    let pixelFp = null;
    try {
      pixelFp = this.vault.fingerprint(full.toBitmap());
    } catch {
      pixelFp = null;
    }

    if (duringGrace && pixelFp && this.staleImageFp && pixelFp === this.staleImageFp) {
      return 'self-copy';
    }

    if (this.suppressedImageFp && pixelFp && pixelFp === this.suppressedImageFp) {
      // PNG byte length changes when Windows re-encodes the bitmap. Remember
      // the new key, and keep the pixel fingerprint until the pixels change.
      this.lastImageKey = key;
      this.lastImageFp = pixelFp;
      this.lastImageBytesFp = fingerprintPng();
      this.lastText = null;
      this.suppressedText = null;
      this.foreignKind = null;
      return 'self-copy';
    }

    if (pixelFp && pixelFp === this.lastImageFp) {
      this.lastImageKey = key;
      this.lastImageFp = pixelFp;
      this.lastImageBytesFp = fingerprintPng();
      const beside = this.considerSiblingText(siblingText, duringGrace);
      if (beside) return beside;
      if (!normalizeText(siblingText)) this.lastText = null;
      this.foreignKind = null;
      return 'duplicate';
    }

    const tScale = Math.min(1, THUMB_MAX_EDGE / Math.max(size.width, size.height));
    let thumb;
    try {
      thumb = (tScale < 1
        ? full.resize({
            width: Math.max(1, Math.round(size.width * tScale)),
            height: Math.max(1, Math.round(size.height * tScale)),
            quality: 'good',
          })
        : full).toPNG();
    } catch {
      if (siblingText) return 'empty';
      this.stats.failed += 1;
      return 'error';
    }

    let id;
    // Pixel hashing can fail independently of PNG encoding (for example, if
    // Electron cannot expose a bitmap for this clipboard image). In that
    // case addImage falls back to hashing the PNG bytes, so track that same
    // identity locally or every poll will bump the same row again.
    const storedFp = pixelFp || fingerprintPng();
    try {
      id = this.vault.addImage({
        full: png,
        thumb,
        width: size.width,
        height: size.height,
        // Prefer decoded-pixel identity; use the PNG fingerprint only when
        // Electron could not expose pixels for this clipboard image.
        fingerprint: storedFp,
      });
    } catch {
      if (siblingText) return 'empty';
      this.stats.failed += 1;
      return 'error';
    }

    this.lastImageKey = key;
    this.lastImageFp = storedFp;
    this.lastImageBytesFp = fingerprintPng();
    this.lastText = null;
    this.suppressedText = null;
    this.suppressedImageFp = null;
    this.foreignKind = null;
    this.imageSeenAt = Date.now();
    // Pixel extraction is not guaranteed even when PNG encoding succeeds.
    // Use the same fallback identity as lastImageFp so sibling text remains
    // attached to this image on later polls instead of becoming a new row.
    this.imageLatchFp = storedFp;
    this.imageTextLatch = normalizeText(siblingText) || null;
    if (!id) return 'duplicate';
    this.dropRacedText(normalizeText(siblingText));
    this.stats.captured += 1;
    this.onChange();
    return 'captured';
  }

  /**
   * A text row filed a moment ago, while this same clipboard item only had
   * text, is not a second clip. Remove it once the bitmap lands.
   */
  dropRacedText(normalized) {
    const raced = this.racedText;
    this.racedText = null;
    if (!raced || !normalized || raced.normalized !== normalized) return;
    if (Date.now() - raced.at > TEXT_IMAGE_RACE_MS) return;
    let entry = null;
    if (Array.isArray(this.vault.entries)) {
      entry = this.vault.entries.find((e) => e.id === raced.id) || null;
    }
    if (raced.prevTs != null) {
      // The text was an older row. The early poll bumped its age before the
      // bitmap landed. Put the age back; deleting the row would drop a clip
      // the user already had.
      if (!entry || entry.type !== 'text') return;
      try { this.vault.restoreTimestamp(raced.id, raced.prevTs); }
      catch { /* keep the bumped age rather than disrupt image capture */ }
      return;
    }
    if (entry) {
      if (entry.pinned || entry.type !== 'text') return;
    } else {
      try {
        const row = this.vault.list().find((r) => r.id === raced.id);
        if (!row || row.pinned || row.type !== 'text') return;
      } catch {
        return;
      }
    }
    try { this.vault.remove(raced.id); }
    catch { /* keep both rather than lose the text */ }
  }

  /** Put an entry back on the system clipboard. */
  restore(id) {
    let payload;
    try {
      payload = this.vault.payload(id);
    } catch {
      return { ok: false, error: 'Entry is no longer available.' };
    }
    if (!payload) return { ok: false, error: 'Entry is no longer available.' };

    const snap = this.snapshotClipboard();
    const previous = {
      selfCopyUntil: this.selfCopyUntil,
      suppressedText: this.suppressedText,
      suppressedImageFp: this.suppressedImageFp,
      staleText: this.staleText,
      staleImageFp: this.staleImageFp,
      lastText: this.lastText,
      lastImageKey: this.lastImageKey,
      lastImageFp: this.lastImageFp,
      lastImageBytesFp: this.lastImageBytesFp,
      foreignKind: this.foreignKind,
      racedText: this.racedText,
      emptyStreak: this.emptyStreak,
      imageTextLatch: this.imageTextLatch,
      imageLatchFp: this.imageLatchFp,
      imageSeenAt: this.imageSeenAt,
    };

    try {
      if (payload.type === 'image') {
        const encoded = String(payload.dataUrl || '').split(',')[1];
        if (!encoded) return { ok: false, error: 'Could not restore that image.' };
        const img = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'));
        if (img.isEmpty()) return { ok: false, error: 'Could not restore that image.' };
        const restored = scaledImage(img);
        if (!restored) return { ok: false, error: 'Could not restore that image.' };
        let fp = null;
        try { fp = this.vault.fingerprint(restored.image.toBitmap()); }
        catch { fp = null; }
        let key = null;
        let bytesFp = null;
        try {
          const png = restored.image.toPNG();
          key = `${restored.size0.width}x${restored.size0.height}:${png.length}`;
          bytesFp = this.vault.fingerprint(png);
        } catch {
          key = null;
          bytesFp = null;
        }
        if (!fp) fp = bytesFp;
        // Arm before write. On Windows the clipboard call can pump, and a
        // tick in the middle must not file the outgoing clip or our write.
        this.staleText = snap.text;
        this.staleImageFp = snap.imageFp;
        this.suppressSelfCopy();
        this.suppressedText = null;
        this.suppressedImageFp = fp;
        this.lastImageFp = fp;
        this.lastImageBytesFp = bytesFp;
        this.lastText = null;
        this.lastImageKey = key;
        this.foreignKind = null;
        this.racedText = null;
        this.emptyStreak = 0;
        this.clearImageLatch();
        this.clipboard.writeImage(img);
      } else {
        const text = String(payload.text || '');
        this.staleText = snap.text;
        this.staleImageFp = snap.imageFp;
        this.suppressSelfCopy();
        this.suppressedText = normalizeText(text);
        this.suppressedImageFp = null;
        this.lastText = text;
        this.lastImageKey = null;
        this.lastImageFp = null;
        this.lastImageBytesFp = null;
        this.foreignKind = null;
        this.racedText = null;
        this.emptyStreak = 0;
        this.clearImageLatch();
        this.clipboard.writeText(text);
      }
    } catch {
      this.selfCopyUntil = previous.selfCopyUntil;
      this.suppressedText = previous.suppressedText;
      this.suppressedImageFp = previous.suppressedImageFp;
      this.staleText = previous.staleText;
      this.staleImageFp = previous.staleImageFp;
      this.lastText = previous.lastText;
      this.lastImageKey = previous.lastImageKey;
      this.lastImageFp = previous.lastImageFp;
      this.lastImageBytesFp = previous.lastImageBytesFp;
      this.foreignKind = previous.foreignKind;
      this.racedText = previous.racedText;
      this.emptyStreak = previous.emptyStreak;
      this.imageTextLatch = previous.imageTextLatch;
      this.imageLatchFp = previous.imageLatchFp;
      this.imageSeenAt = previous.imageSeenAt;
      return { ok: false, error: 'Could not restore that entry.' };
    }
    return { ok: true, type: payload.type };
  }
}

module.exports = { Monitor };
