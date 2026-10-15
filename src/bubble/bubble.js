'use strict';

// Window is 52px; the disc is 40px. The 6px margin is where the rim fades
// out so the circle is not cut by the window edge.
const DISC = 40;
const SAMPLES = 4;

const button = document.getElementById('open');
const canvas = document.getElementById('disc');

function tone() {
  if (!button) return { fill: [7, 7, 7], ring: 0.18 };
  if (button.matches(':active')) return { fill: [16, 16, 16], ring: 0.22 };
  if (button.matches(':hover')) return { fill: [20, 20, 20], ring: 0.28 };
  if (button.matches(':focus-visible')) return { fill: [7, 7, 7], ring: 0.45 };
  return { fill: [7, 7, 7], ring: 0.18 };
}

function paint() {
  if (!canvas) return;
  const css = canvas.clientWidth;
  if (!css) {
    requestAnimationFrame(paint);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(css * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d', { alpha: true });
  const image = ctx.createImageData(px, px);
  const data = image.data;
  const cx = px / 2;
  const cy = px / 2;
  const radius = (DISC / 2) * dpr;
  const hair = Math.max(1, dpr);
  const fillR = radius - hair;
  const look = tone();
  const fr = look.fill[0];
  const fg = look.fill[1];
  const fb = look.fill[2];
  const rr = Math.round(fr + (255 - fr) * look.ring);
  const rg = Math.round(fg + (255 - fg) * look.ring);
  const rb = Math.round(fb + (255 - fb) * look.ring);
  const n = SAMPLES * SAMPLES;

  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        const py = y + (sy + 0.5) / SAMPLES;
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const sampleX = x + (sx + 0.5) / SAMPLES;
          const dx = sampleX - cx;
          const dy = py - cy;
          const dist = Math.hypot(dx, dy);
          if (dist > radius) continue;
          covered += 1;
          if (dist >= fillR) {
            r += rr;
            g += rg;
            b += rb;
          } else {
            r += fr;
            g += fg;
            b += fb;
          }
        }
      }
      const i = (y * px + x) * 4;
      if (!covered) continue;
      data[i] = Math.round(r / covered);
      data[i + 1] = Math.round(g / covered);
      data[i + 2] = Math.round(b / covered);
      data[i + 3] = Math.round((covered / n) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

if (button) {
  button.addEventListener('pointerenter', paint);
  button.addEventListener('pointerleave', paint);
  button.addEventListener('pointerdown', paint);
  button.addEventListener('pointerup', paint);
  button.addEventListener('focus', paint);
  button.addEventListener('blur', paint);
  button.addEventListener('click', () => {
    Promise.resolve(window.bubble && window.bubble.toggle()).catch(() => {});
  });
}
// The renderer owns this action because native context menus on a tiny
// transparent window are unreliable on Windows. It also covers the clear
// padding around the visible disc.
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  Promise.resolve(window.bubble && window.bubble.unpin()).catch(() => {});
});
window.addEventListener('resize', paint);
paint();
