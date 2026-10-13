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
const FILE_FORMATS = ['text/uri-list', 'FileNameW', 'CF_HDROP', 'Shell IDList Array'];

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
    this.selfCopyUntil = 0;
    this.stats = { captured: 0, skipped: 0, failed: 0 };
  }

  /** Called when an entry is pushed back onto the clipboard by the user. */
  suppressSelfCopy(ms = SELF_COPY_GRACE_MS) {
    this.selfCopyUntil = Date.now() + ms;
  }

  reset() {
    this.lastText = null;
    this.lastImageKey = null;
  }

  tick() {
    if (this.vault.locked || this.isPaused()) return 'idle';
    if (Date.now() < this.selfCopyUntil) return 'self-copy';

    let formats = [];
    try {
      formats = this.clipboard.availableFormats();
    } catch {
      this.stats.failed += 1;
      return 'error';
    }

    // Explorer file copies are not clipboard-history items.
    if (formats.some((f) => FILE_FORMATS.includes(f))) {
      this.stats.skipped += 1;
      return 'files';
    }

    const hasImage = formats.some((f) => f.startsWith('image/'));
    if (hasImage && this.getSettings().captureImages) return this.captureImage();
    if (formats.includes('text/plain')) return this.captureText();
    return 'empty';
  }

  captureText() {
    let text;
    try {
      text = this.clipboard.readText();
    } catch {
      this.stats.failed += 1;
      return 'error';
    }
    if (!text || text === this.lastText) return 'duplicate';
    this.lastText = text;
    this.lastImageKey = null;

    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      this.stats.skipped += 1;
      return 'too-large';
    }
    const id = this.vault.addText(text);
    if (!id) return 'duplicate';
    this.stats.captured += 1;
    this.onChange();
    return 'captured';
  }

  captureImage() {
    let image;
    try {
      image = this.clipboard.readImage();
    } catch {
      this.stats.failed += 1;
      return 'error';
    }
    if (!image || image.isEmpty()) return 'empty';

    const size0 = image.getSize();
    const key = `${size0.width}x${size0.height}:${image.toPNG().length}`;
    if (key === this.lastImageKey) return 'duplicate';
    this.lastImageKey = key;
    this.lastText = null;

    let full = image;
    let size = size0;
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(size.width, size.height));
    if (scale < 1) {
      full = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good',
      });
      size = full.getSize();
    }

    let png = full.toPNG();
    if (png.length > IMAGE_MAX_BYTES) {
      this.stats.skipped += 1;
      return 'too-large';
    }

    const tScale = Math.min(1, THUMB_MAX_EDGE / Math.max(size.width, size.height));
    const thumb = (tScale < 1
      ? full.resize({
          width: Math.max(1, Math.round(size.width * tScale)),
          height: Math.max(1, Math.round(size.height * tScale)),
          quality: 'good',
        })
      : full).toPNG();

    const id = this.vault.addImage({
      full: png,
      thumb,
      width: size.width,
      height: size.height,
      // Hash decoded pixels, not PNG bytes: writing an image back to the
      // clipboard re-encodes it, which would otherwise look like a new copy.
      fingerprint: this.vault.fingerprint(full.toBitmap()),
    });
    if (!id) return 'duplicate';
    this.stats.captured += 1;
    this.onChange();
    return 'captured';
  }

  /** Put an entry back on the system clipboard. */
  restore(id) {
    const payload = this.vault.payload(id);
    if (!payload) return { ok: false, error: 'Entry is no longer available.' };

    this.suppressSelfCopy();
    if (payload.type === 'image') {
      const img = nativeImage.createFromBuffer(Buffer.from(payload.dataUrl.split(',')[1], 'base64'));
      if (img.isEmpty()) return { ok: false, error: 'Could not restore that image.' };
      this.clipboard.writeImage(img);
    } else {
      this.clipboard.writeText(payload.text);
    }
    return { ok: true, type: payload.type };
  }
}

module.exports = { Monitor };