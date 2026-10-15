'use strict';

/**
 * Screenshot selection overlay.
 *
 * The screen was already frozen by the main process *before* this window
 * existed, so the overlay can never photograph itself. This file only draws
 * that snapshot, collects a drag rectangle, and crops it back out.
 *
 * clamp() is (value, max). It already floors at 0. Passing 0 as max pins
 * the value to the origin — that is what stuck Shift-drag squares in the
 * top-left corner. Never call it as (value, min, max).
 */

function clamp(value, max) {
  return Math.max(0, Math.min(value, max));
}

function rectFrom(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Square from the anchor toward the pointer, using the smaller axis, shrunk
 * so the square stays inside the window. The anchor remains a corner.
 */
function squareFrom(anchor, current, maxW, maxH) {
  const ax = clamp(anchor.x, maxW);
  const ay = clamp(anchor.y, maxH);
  const cx = clamp(current.x, maxW);
  const cy = clamp(current.y, maxH);
  const dx = cx - ax;
  const dy = cy - ay;
  let side = Math.min(Math.abs(dx), Math.abs(dy));
  side = Math.min(side, maxW, maxH);
  if (dx < 0) side = Math.min(side, ax);
  else side = Math.min(side, Math.max(0, maxW - ax));
  if (dy < 0) side = Math.min(side, ay);
  else side = Math.min(side, Math.max(0, maxH - ay));
  side = Math.max(0, side);
  const x = dx < 0 ? ax - side : ax;
  const y = dy < 0 ? ay - side : ay;
  const xMax = Math.max(0, maxW - side);
  const yMax = Math.max(0, maxH - side);
  return {
    // When the square fills the axis, the only legal origin is 0. Don't hand
    // clamp() a max of 0 in the other cases — that pins every square to 0.
    x: xMax === 0 ? 0 : clamp(x, xMax),
    y: yMax === 0 ? 0 : clamp(y, yMax),
    w: side,
    h: side,
  };
}

/**
 * Intersection of the CSS selection with the snapshot, in source pixels.
 * The overlap is clipped to the image first. Each edge is then rounded, so
 * the crop is the pixels the selection actually covers: rounding the width
 * on its own pulls in the next pixel, and a sub-pixel overlap must not
 * become a 1px sliver. A selection that misses the image (letterbox) is
 * empty, and a selection that starts outside does not keep the width it
 * had before the clip.
 */
function sourceRectFor(rect, view, imageW, imageH) {
  if (!rect || !view || !imageW || !imageH || !view.w || !view.h) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const left = Math.max(rect.x, view.x);
  const top = Math.max(rect.y, view.y);
  const right = Math.min(rect.x + rect.w, view.x + view.w);
  const bottom = Math.min(rect.y + rect.h, view.y + view.h);
  if (right - left <= 0 || bottom - top <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const kx = imageW / view.w;
  const ky = imageH / view.h;
  let x = Math.round((left - view.x) * kx);
  let y = Math.round((top - view.y) * ky);
  let r = Math.round((right - view.x) * kx);
  let b = Math.round((bottom - view.y) * ky);
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (r > imageW) r = imageW;
  if (b > imageH) b = imageH;
  if (x >= imageW || y >= imageH || r <= x || b <= y) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x, y, width: r - x, height: b - y };
}

function startCaptureOverlay() {
  // One document can evaluate this file only once, but a second call (reload
  // into the same realm, or a retried init) must not stack another set of
  // window listeners on top of the first. The flag is set only after the
  // nodes exist, so a throw before that can still bind on a later call.
  if (window.__clipvaultCaptureBound) return;

  const canvas = document.getElementById('stage');
  const shade = document.getElementById('shade');
  const frame = document.getElementById('frame');
  const sizeLabel = document.getElementById('size');
  const hint = document.getElementById('hint');
  const guideX = document.getElementById('guideX');
  const guideY = document.getElementById('guideY');
  const flash = document.getElementById('flash');
  const ctx = canvas && canvas.getContext('2d');
  if (!canvas || !ctx || !shade || !frame || !sizeLabel || !hint || !guideX || !guideY || !flash) {
    const call = window.capture && window.capture.cancel;
    if (typeof call === 'function') Promise.resolve(call()).catch(() => {});
    else {
      try { window.close(); } catch { /* already closing */ }
    }
    return;
  }
  window.__clipvaultCaptureBound = true;

  const selfId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const FOCUS_KEY = 'clipvault-capture-focus';
  const PEER_TTL_MS = 1200;
  const BOOT_MS = 1000;
  const bootedAt = Date.now();
  // id -> last time that overlay said it was focused. A Set never expired,
  // so a peer that died without a blur message left this overlay up forever.
  const peers = new Map();
  const detach = [];
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    detach.push(() => target.removeEventListener(type, fn, options));
  }
  let channel = null;
  try {
    channel = new BroadcastChannel('clipvault-capture');
  } catch { channel = null; }

  const state = {
    image: null,      // frozen screen snapshot (natural size = device pixels)
    view: null,       // where the snapshot actually landed on screen
    anchor: null,     // {x, y} where the drag started
    rect: null,       // {x, y, w, h} in CSS pixels
    pointer: null,    // last known cursor position, for the crosshair guides
    dragging: false,
    pointerId: null,
    painted: false,   // canvas backing store matches the snapshot
    done: false,      // confirm succeeded; flash is playing
    submitting: false,
    closed: false,    // cancel has been asked of the main process
    closeTimer: 0,
    blurTimer: 0,
    heartTimer: 0,
  };

  function announce(type) {
    if (!channel) return;
    try { channel.postMessage({ type, id: selfId }); }
    catch { /* channel already closed */ }
  }

  function readFocus() {
    try {
      const raw = localStorage.getItem(FOCUS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeFocus() {
    try {
      localStorage.setItem(FOCUS_KEY, JSON.stringify({ id: selfId, at: Date.now() }));
    } catch { /* storage unavailable; BroadcastChannel is the other signal */ }
  }

  function peerFocused() {
    const now = Date.now();
    for (const [id, at] of peers) {
      if (now - at > PEER_TTL_MS) peers.delete(id);
    }
    if (peers.size > 0) return true;
    const data = readFocus();
    return !!(data && data.id !== selfId && now - Number(data.at) < PEER_TTL_MS);
  }

  /**
   * Fit the snapshot into the window without distorting it, so the mapping from
   * on-screen selection to source pixels stays correct even if the window ends
   * up a different size or aspect than the display it froze.
   */
  function computeView() {
    if (!state.image || !state.image.naturalWidth || !state.image.naturalHeight) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(w / state.image.naturalWidth, h / state.image.naturalHeight);
    const dw = state.image.naturalWidth * scale;
    const dh = state.image.naturalHeight * scale;
    return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh, scale };
  }

  function sourceRect() {
    if (!state.rect || !state.view || !state.image) return { x: 0, y: 0, width: 0, height: 0 };
    return sourceRectFor(state.rect, state.view, state.image.naturalWidth, state.image.naturalHeight);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Assigning canvas.width drops the bitmap and, on some Chromium builds,
    // pointer capture. A drag that does that on the first move never receives
    // pointerup. Repaint only when the backing store is actually stale.
    const nextW = Math.max(1, Math.round(w * dpr));
    const nextH = Math.max(1, Math.round(h * dpr));
    const view = computeView();
    const prev = state.view;
    const viewChanged = !prev || !view
      || prev.x !== view.x || prev.y !== view.y
      || prev.w !== view.w || prev.h !== view.h;
    if (!state.painted || viewChanged || canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      state.view = view;
      if (state.image && state.view) ctx.drawImage(state.image, state.view.x, state.view.y, state.view.w, state.view.h);
      state.painted = true;
    }

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

  function endDrag() {
    if (!state.dragging) return;
    state.dragging = false;
    document.body.classList.remove('dragging');
    if (state.pointerId != null) {
      try { canvas.releasePointerCapture(state.pointerId); }
      catch { /* capture already released by pointerup */ }
    }
    if (!state.rect || state.rect.w < 4 || state.rect.h < 4) {
      state.rect = null;
      hint.classList.remove('fading');
    }
    draw();
  }

  function updateDrag(event) {
    state.pointer = { x: event.clientX, y: event.clientY };
    if (!state.dragging || state.closed) {
      draw();
      return;
    }
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    const anchor = state.anchor || { x: event.clientX, y: event.clientY };
    const current = { x: event.clientX, y: event.clientY };
    state.rect = event.shiftKey
      ? squareFrom(anchor, current, maxW, maxH)
      : rectFrom(
          { x: clamp(anchor.x, maxW), y: clamp(anchor.y, maxH) },
          { x: clamp(current.x, maxW), y: clamp(current.y, maxH) },
        );
    draw();
  }

  function cancel() {
    if (state.closed) return;
    state.closed = true;
    state.done = true;
    state.submitting = false;
    state.dragging = false;
    document.body.classList.remove('dragging');
    clearTimeout(state.blurTimer);
    clearTimeout(state.closeTimer);
    announce('close');
    try {
      const mine = readFocus();
      if (mine && mine.id === selfId) localStorage.removeItem(FOCUS_KEY);
    } catch { /* already gone */ }
    const call = window.capture && window.capture.cancel;
    if (typeof call !== 'function') {
      try { window.close(); } catch { /* already closing */ }
      return;
    }
    Promise.resolve(call()).then((closed) => {
      // A sibling overlay may have taken focus just before this blur cancel
      // arrived. The main process ignores that cancel; keep this overlay
      // interactive in case the pointer returns to its display.
      if (closed === false) {
        state.closed = false;
        state.done = false;
      }
    }).catch(() => {
      // Leave Escape able to try again if the main process rejected the close.
      state.closed = false;
      state.done = false;
    });
  }

  async function confirm() {
    if (state.closed || state.submitting || state.done) return;
    if (!state.image || !state.rect || state.rect.w < 4 || state.rect.h < 4) return;
    const src = sourceRect();
    if (src.width < 1 || src.height < 1) return;

    state.submitting = true;
    endDrag();

    // Flash the cropped region, not the part of the drag that sat in the
    // letterbox. done stays false until submit succeeds: a throw from the
    // crop must still reach cancel(), or Escape is ignored and the overlay
    // stays up.
    const view = state.view || { x: 0, y: 0, w: 0, h: 0 };
    const fx = Math.max(state.rect.x, view.x);
    const fy = Math.max(state.rect.y, view.y);
    const fr = Math.min(state.rect.x + state.rect.w, view.x + view.w);
    const fb = Math.min(state.rect.y + state.rect.h, view.y + view.h);
    flash.style.left = `${fx}px`;
    flash.style.top = `${fy}px`;
    flash.style.width = `${Math.max(0, fr - fx)}px`;
    flash.style.height = `${Math.max(0, fb - fy)}px`;
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');

    let dataUrl;
    try {
      // Crop from the untouched snapshot so we never re-read a scaled canvas.
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const outCtx = out.getContext('2d');
      if (!outCtx) throw new Error('crop context unavailable');
      outCtx.drawImage(
        state.image,
        src.x, src.y, src.width, src.height,
        0, 0, src.width, src.height,
      );
      dataUrl = out.toDataURL('image/png');
    } catch {
      if (!state.closed) {
        state.submitting = false;
        cancel();
      }
      return;
    }

    try {
      if (state.closed) {
        state.submitting = false;
        return;
      }
      const result = await window.capture.submit(dataUrl, {
        x: state.rect.x,
        y: state.rect.y,
        width: src.width,
        height: src.height,
      });
      if (state.closed) {
        state.submitting = false;
        return;
      }
      if (!result || result.ok === false) {
        state.submitting = false;
        cancel();
        return;
      }
      state.done = true;
      state.submitting = false;
      state.closeTimer = setTimeout(() => cancel(), 170); // let the flash play first
    } catch {
      // A throw after marking the capture done used to ignore Escape and
      // leave the fullscreen overlay up with the main-process lock stuck.
      if (!state.closed) {
        state.submitting = false;
        cancel();
      }
    }
  }

  listen(canvas, 'pointerdown', (event) => {
    if (state.closed || state.done || state.submitting) return;
    if (event.button !== 0) return;
    state.anchor = { x: event.clientX, y: event.clientY };
    state.rect = { x: event.clientX, y: event.clientY, w: 0, h: 0 };
    state.dragging = true;
    state.pointerId = event.pointerId;
    document.body.classList.add('dragging');
    hint.classList.add('fading');
    // Paint before capturing. Resizing the canvas after setPointerCapture
    // drops the capture, and the drag then never sees pointerup.
    draw();
    try { canvas.setPointerCapture(event.pointerId); }
    catch { /* pointer already released */ }
  });

  listen(window, 'pointermove', updateDrag);
  // pointerup is listened for on both the canvas and the window, in the
  // capture phase. Capture retargets the event, and a release outside the
  // window used to leave `dragging` true because mouseup never reached the
  // canvas. button is -1 on some synthesized pointerups; buttons tells us
  // the primary button is actually up.
  const endPrimaryDrag = (event) => {
    if (typeof event.buttons === 'number' && (event.buttons & 1) === 1) return;
    if (event.button !== 0 && event.button !== -1) return;
    endDrag();
  };
  listen(canvas, 'pointerup', endPrimaryDrag);
  listen(window, 'pointerup', endPrimaryDrag, true);
  listen(window, 'pointercancel', () => endDrag());
  listen(canvas, 'lostpointercapture', (event) => {
    if (!state.dragging) return;
    // Leaving the window must not finish the drag while the button is held.
    // Take capture back; pointerup (including outside the window) ends it.
    if (event.buttons & 1) {
      try { canvas.setPointerCapture(event.pointerId); }
      catch { /* pointer already up */ }
      return;
    }
    endDrag();
  });

  listen(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    }
  });

  listen(window, 'resize', () => {
    state.painted = false;
    draw();
  });
  listen(window, 'contextmenu', (event) => event.preventDefault());

  listen(window, 'focus', () => {
    clearTimeout(state.blurTimer);
    writeFocus();
    announce('focus');
  });

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data || {};
      if (!data.id || data.id === selfId) return;
      if (data.type === 'focus') {
        peers.set(data.id, Date.now());
        clearTimeout(state.blurTimer);
      } else if (data.type === 'blur' || data.type === 'close') {
        peers.delete(data.id);
      }
    };
  }

  listen(window, 'storage', (event) => {
    if (event.key === FOCUS_KEY && peerFocused()) clearTimeout(state.blurTimer);
  });

  function scheduleBlurCancel() {
    clearTimeout(state.blurTimer);
    // The other display's overlay may still be loading. Cancelling in that
    // gap closes every monitor, because capture:cancel destroys them all.
    const elapsed = Date.now() - bootedAt;
    const wait = elapsed < BOOT_MS ? Math.max(280, BOOT_MS - elapsed) : 280;
    state.blurTimer = setTimeout(() => {
      if (state.closed || state.done || state.submitting) return;
      if (document.hasFocus() || peerFocused()) return;
      cancel();
    }, wait);
  }

  listen(window, 'blur', () => {
    // Another display's overlay taking focus is not "the user left".
    // Alt-tab still cancels, so a fullscreen window can't sit there forever.
    endDrag();
    announce('blur');
    try {
      const mine = readFocus();
      if (mine && mine.id === selfId) localStorage.removeItem(FOCUS_KEY);
    } catch { /* ignore */ }
    scheduleBlurCancel();
  });

  // Heartbeat so a sibling overlay can tell this one is still focused.
  // Without it, a missed blur message left the other fullscreen window stuck.
  state.heartTimer = setInterval(() => {
    if (state.closed || !document.hasFocus()) return;
    writeFocus();
    announce('focus');
  }, 400);

  listen(window, 'pagehide', () => {
    clearInterval(state.heartTimer);
    clearTimeout(state.blurTimer);
    clearTimeout(state.closeTimer);
    detach.splice(0).forEach((off) => {
      try { off(); } catch { /* node already gone */ }
    });
    try { if (channel) channel.close(); } catch { /* already closed */ }
  });

  if (document.hasFocus()) {
    writeFocus();
    announce('focus');
  }

  (async function init() {
    let snap = null;
    try {
      snap = await window.capture.snapshot();
    } catch {
      cancel();
      return;
    }
    if (state.closed) return;
    if (!snap || !snap.dataUrl) {
      cancel();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (state.closed) return;
      state.image = image;
      state.painted = false;
      draw();
    };
    image.onerror = () => cancel();
    image.src = snap.dataUrl;
  })();
}

if (typeof document === 'undefined') {
  module.exports = { clamp, squareFrom, sourceRectFor, rectFrom };
} else {
  startCaptureOverlay();
}
