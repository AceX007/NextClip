'use strict';

/**
 * Minimal PNG encoder so the tray/app icon can be drawn in code.
 * Uses only node's zlib - no image libraries, no binary assets to ship.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer of width*height*4 bytes */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Tiny drawing surface with just enough primitives for an icon. */
class Canvas {
  constructor(width, height = width) {
    this.width = width;
    this.height = height;
    this.px = Buffer.alloc(width * height * 4);
  }

  blend(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const inv = 1 - a;
    this.px[i] = Math.round(r * a + this.px[i] * inv);
    this.px[i + 1] = Math.round(g * a + this.px[i + 1] * inv);
    this.px[i + 2] = Math.round(b * a + this.px[i + 2] * inv);
    this.px[i + 3] = Math.round(255 * a + this.px[i + 3] * inv);
  }

  /** anti-aliased filled rect via 3x3 supersampling */
  rect(x0, y0, x1, y1, color) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
        let hits = 0;
        for (let sy = 0; sy < 3; sy += 1) {
          for (let sx = 0; sx < 3; sx += 1) {
            const px = x + (sx + 0.5) / 3;
            const py = y + (sy + 0.5) / 3;
            if (px >= x0 && px < x1 && py >= y0 && py < y1) hits += 1;
          }
        }
        if (hits) this.blend(x, y, color, hits / 9);
      }
    }
  }

  /** filled annulus sector, used for the padlock shackle */
  arc(cx, cy, rOuter, rInner, a0, a1, color) {
    for (let y = Math.floor(cy - rOuter) - 1; y <= Math.ceil(cy + rOuter) + 1; y += 1) {
      for (let x = Math.floor(cx - rOuter) - 1; x <= Math.ceil(cx + rOuter) + 1; x += 1) {
        let hits = 0;
        for (let sy = 0; sy < 3; sy += 1) {
          for (let sx = 0; sx < 3; sx += 1) {
            const px = x + (sx + 0.5) / 3 - cx;
            const py = y + (sy + 0.5) / 3 - cy;
            const d = Math.hypot(px, py);
            let a = Math.atan2(py, px);
            if (a < 0) a += Math.PI * 2;
            if (d >= rInner && d <= rOuter && a >= a0 && a <= a1) hits += 1;
          }
        }
        if (hits) this.blend(x, y, color, hits / 9);
      }
    }
  }

  circle(cx, cy, r, color) {
    this.arc(cx, cy, r, 0, 0, Math.PI * 2, color);
  }

  toPng() {
    return encodePng(this.width, this.height, this.px);
  }
}

const ACCENT = [108, 140, 255];
const ACCENT_DARK = [72, 100, 220];
const METAL = [206, 219, 255];

/** Closed padlock: shackle over a body with a keyhole. */
function drawPadlock(size = 16, open = false) {
  const c = new Canvas(size);
  const s = size / 16;
  const body = { x0: 3 * s, y0: 7 * s, x1: 13 * s, y1: 14 * s };

  // shackle
  c.arc(8 * s, 7.2 * s, 3.4 * s, 1.9 * s, Math.PI, Math.PI * 2, METAL);
  if (open) {
    // shackle lifted to the right
    c.rect(11.1 * s, 4.2 * s, 12.5 * s, 7.4 * s, METAL);
  } else {
    c.rect(6.1 * s, 7 * s, 9.9 * s, 7.6 * s, METAL);
  }
  // body
  c.rect(body.x0, body.y0, body.x1, body.y1, ACCENT);
  c.rect(body.x0 + 0.9 * s, body.y0 + 0.9 * s, body.x1 - 0.9 * s, body.y1 - 0.9 * s, ACCENT_DARK);
  // keyhole
  c.circle(8 * s, 10.1 * s, 1.15 * s, [12, 18, 48]);
  c.rect(7.35 * s, 10.1 * s, 8.65 * s, 12.4 * s, [12, 18, 48]);
  return c.toPng();
}

module.exports = { encodePng, Canvas, drawPadlock };