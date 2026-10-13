'use strict';

/**
 * Screenshot selection overlay.
 *
 * The screen was already frozen by the main process *before* this window
 * existed, so the overlay can never photograph itself. This file only draws
 * that snapshot, collects a drag rectangle, and crops it back out.
 */

const canvas = document.getElementById('stage');
const shade = document.getElementById('shade');
const frame = document.getElementById('frame');
const sizeLabel = document.getElementById('size');
const hint = document.getElementById('hint');
const guideX = document.getElementById('guideX');
const guideY = document.getElementById('guideY');
const flash = document.getElementById('flash');
const ctx = canvas.getContext('2d');

const state = {
  image: null,      // frozen screen snapshot (natural size = device pixels)
  view: null,       // where the snapshot actually landed on screen
  anchor: null,     // {x, y} where the drag started
  rect: null,       // {x, y, w, h} in CSS pixels
  pointer: null,    // last known cursor position, for the crosshair guides
  dragging: false,
  done: false,
};

function clamp(value, max) {
  return Math.max(0, Math.min(value, max));
}

/**
 * Fit the snapshot into the window without distorting it, so the mapping from
 * on-screen selection to source pixels stays correct even if the window ends
 * up a different size or aspect than the display it froze.
 */
function computeView() {
  if (!state.image) return null;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = Math.min(w / state.image.naturalWidth, h / state.image.naturalHeight);
  const dw = state.image.naturalWidth * scale;
  const dh = state.image.naturalHeight * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh, scale };
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  state.view = computeView();
  if (state.image && state.view) ctx.drawImage(state.image, state.view.x, state.view.y, state.view.w, state.view.h);

  // Crosshair guides follow the pointer until a drag starts.
  if (state.pointer && !state.rect) {
    guideX.style.display = 'block';
    guideY.style.display = 'block';
    guideX.style.left = `${state.pointer.x}px`;
    guideY.style.top = `${state.pointer.y}px`;
  } else {
    guideX.style.display = 'none';
    guideY.style.display = 'none';
  }

  if (!state.rect) {
    shade.style.display = 'none';
    frame.classList.add('hidden');
    return;
  }
  const { x, y, w: rw, h: rh } = state.rect;
  const src = sourceRect();
  shade.style.display = 'block';
  shade.style.left = `${x}px`;
  shade.style.top = `${y}px`;
  shade.style.width = `${rw}px`;
  shade.style.height = `${rh}px`;
  frame.classList.remove('hidden');
  frame.style.left = `${x}px`;
  frame.style.top = `${y}px`;
  frame.style.width = `${rw}px`;
  frame.style.height = `${rh}px`;
  sizeLabel.textContent = `${src.width} × ${src.height} px`;
  // Keep the label inside the window when the selection is near the top.
  sizeLabel.classList.toggle('flip', y < 34);
}

/** Map the current selection from screen coordinates into snapshot pixels. */
function sourceRect() {
  if (!state.rect || !state.view) return { x: 0, y: 0, width: 0, height: 0 };
  const kx = state.image.naturalWidth / state.view.w;
  const ky = state.image.naturalHeight / state.view.h;
  const x = Math.round((state.rect.x - state.view.x) * kx);
  const y = Math.round((state.rect.y - state.view.y) * ky);
  const width = Math.round(state.rect.w * kx);
  const height = Math.round(state.rect.h * ky);
  const maxW = state.image.naturalWidth;
  const maxH = state.image.naturalHeight;
  const cx = Math.max(0, Math.min(x, maxW - 1));
  const cy = Math.max(0, Math.min(y, maxH - 1));
  return {
    x: cx,
    y: cy,
    width: Math.max(1, Math.min(width, maxW - cx)),
    height: Math.max(1, Math.min(height, maxH - cy)),
  };
}

function rectFrom(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

canvas.addEventListener('mousedown', (event) => {
  if (state.done) return;
  state.anchor = { x: event.clientX, y: event.clientY };
  state.rect = { x: event.clientX, y: event.clientY, w: 0, h: 0 };
  state.dragging = true;
  document.body.classList.add('dragging');
  hint.classList.add('fading');
  draw();
});

window.addEventListener('mousemove', (event) => {
  state.pointer = { x: event.clientX, y: event.clientY };
  if (!state.dragging) {
    draw();
    return;
  }
  const current = { x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight) };
  let rect = rectFrom(state.anchor, current);

  if (event.shiftKey) {
    // Constrain to a square using the smaller side.
    const side = Math.min(rect.w, rect.h);
    rect = {
      x: rect.w >= rect.h ? current.x - side : rect.x,
      y: rect.w >= rect.h ? rect.y : current.y - side,
      w: side,
      h: side,
    };
    rect.x = clamp(rect.x, 0, window.innerWidth - side);
    rect.y = clamp(rect.y, 0, window.innerHeight - side);
  }
  state.rect = rect;
  draw();
});

window.addEventListener('mouseup', () => {
  if (!state.dragging) return;
  state.dragging = false;
  document.body.classList.remove('dragging');
  if (!state.rect || state.rect.w < 4 || state.rect.h < 4) {
    state.rect = null;
    hint.classList.remove('fading');
  }
  draw();
});

function cancel() {
  if (state.done) return;
  state.done = true;
  window.capture.cancel();
}

async function confirm() {
  if (state.done) return;
  if (!state.rect || state.rect.w < 4 || state.rect.h < 4) return;
  state.done = true;

  const src = sourceRect();

  // Flash the region so it reads as "this is what you just took".
  flash.style.left = `${state.rect.x}px`;
  flash.style.top = `${state.rect.y}px`;
  flash.style.width = `${state.rect.w}px`;
  flash.style.height = `${state.rect.h}px`;
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');

  // Crop from the untouched snapshot so we never re-read a scaled canvas.
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.getContext('2d').drawImage(
    state.image,
    src.x, src.y, src.width, src.height,
    0, 0, src.width, src.height,
  );

  const dataUrl = out.toDataURL('image/png');
  const result = await window.capture.submit(dataUrl, {
    x: state.rect.x,
    y: state.rect.y,
    width: src.width,
    height: src.height,
  });
  if (result && result.ok === false) cancel();
  else setTimeout(() => window.capture.cancel(), 170); // let the flash play first
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    confirm();
  }
});

window.addEventListener('resize', draw);

window.addEventListener('blur', () => {
  // Losing focus means the user clicked away or alt-tabbed: treat as cancel so
  // we never leave a fullscreen black overlay stranded.
  setTimeout(() => {
    if (!document.hasFocus() && !state.done) cancel();
  }, 200);
});

(async function init() {
  const snap = await window.capture.snapshot();
  if (!snap || !snap.dataUrl) {
    cancel();
    return;
  }
  const image = new Image();
  image.onload = () => {
    state.image = image;
    draw();
  };
  image.onerror = () => cancel();
  image.src = snap.dataUrl;
})();