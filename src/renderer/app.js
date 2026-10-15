'use strict';

/* NextClip panel logic. Talks to the main process only through window.clipvault. */

const api = window.clipvault;

const el = (id) => document.getElementById(id);

const ui = {
  statusDot: el('statusDot'),
  statusText: el('statusText'),
  lockScreen: el('lockScreen'),
  lockTitle: el('lockTitle'),
  lockHint: el('lockHint'),
  lockFootnote: el('lockFootnote'),
  lockError: el('lockError'),
  passForm: el('passForm'),
  passInput: el('passInput'),
  passConfirm: el('passConfirm'),
  passSubmit: el('passSubmit'),
  rememberMe: el('rememberMe'),
  rememberDays: el('rememberDays'),

  historyScreen: el('historyScreen'),
  settingsScreen: el('settingsScreen'),
  search: el('search'),
  searchClear: el('searchClear'),
  resultCount: el('resultCount'),
  emptyArt: el('emptyArt'),
  emptyHint: el('emptyHint'),
  list: el('list'),
  empty: el('empty'),
  emptyText: el('emptyText'),
  counts: el('counts'),
  toast: el('toast'),
  toastText: el('toastText'),
  toastAction: el('toastAction'),
  rowMenu: el('rowMenu'),

  btnPause: el('btnPause'),
  btnClear: el('btnClear'),
  btnClose: el('btnClose'),
  btnLock: el('btnLock'),
  btnSettings: el('btnSettings'),
  pauseBanner: el('pauseBanner'),
};

let state = null;
let rows = [];
let filter = 'all';
let selectedId = null;      // tracked by id, not index, so it survives re-renders
let toastTimer = null;
let toastHideTimer = null;
let toastAction = null;     // callback for the toast's action button
let menuRowId = null;       // row the context menu belongs to
let listEpoch = 0;          // drops stale list() results when refreshes overlap
let stateSerial = 0;        // onState events that landed during an in-flight status()
let passBusy = false;
let passChangeBusy = false;
let settingsBusy = false;
let restoreBusy = false;
let pauseBusy = false;
let clearBusy = false;
let deleteBusy = false;
let pinBusy = false;
let lockBusy = false;

/* ----------------------------------------------------------------- utils */

/** Toast with an optional action button (used for undo). */
function toast(message, action) {
  ui.toastText.textContent = message;
  ui.toastAction.classList.toggle('hidden', !action);
  if (action) {
    ui.toastAction.textContent = action.label;
    toastAction = action.run;
  } else {
    toastAction = null;
  }
  ui.toast.classList.remove('hidden', 'out');
  // Restart the entrance animation even for back-to-back toasts.
  ui.toast.style.animation = 'none';
  void ui.toast.offsetHeight;
  ui.toast.style.animation = '';
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(dismissToast, action ? 5200 : 1800);
}

function dismissToast() {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  ui.toast.classList.add('out');
  toastHideTimer = setTimeout(() => {
    ui.toast.classList.add('hidden');
    ui.toastAction.classList.add('hidden');
    toastAction = null;
  }, 220);
}

ui.toastAction.addEventListener('click', () => {
  const run = toastAction;
  dismissToast();
  if (!run) return;
  Promise.resolve().then(run).catch(() => toast('Could not undo'));
});

function isTextField(target) {
  if (!target || target.nodeType !== 1) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'image'].includes(type);
}

/** Index of the selected row within the currently visible set. */
function selectedIndex(items = visibleRows()) {
  if (!selectedId) return -1;
  return items.findIndex((r) => r.id === selectedId);
}

function applyDensity() {
  const compact = Boolean(state && state.settings && state.settings.density === 'compact');
  document.body.classList.toggle('density-compact', compact);
}

/* Dismiss the context menu on any outside interaction. */
document.addEventListener('mousedown', (event) => {
  if (!menuRowId || ui.rowMenu.contains(event.target)) return;
  // Keep focus inside the window. Blurring a frameless panel looks like a
  // click in another app and Hide-on-blur closes it.
  closeRowMenu({ restoreFocus: !isTextField(event.target) });
});
window.addEventListener('blur', () => closeRowMenu());
window.addEventListener('resize', () => closeRowMenu());
window.addEventListener('focus', () => {
  if (menuRowId || ui.historyScreen.classList.contains('hidden')) return;
  if (!ui.rowMenu.contains(document.activeElement)) return;
  ui.list.focus({ preventScroll: true });
});

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Escape, then wrap query matches in <mark>. Marks the raw text so a search
    for "amp" cannot light up the letters inside an &amp; entity. */
function highlight(text, query) {
  const raw = String(text || '');
  if (!query) return escapeHtml(raw);
  const lower = raw.toLowerCase();
  const needle = String(query).toLowerCase();
  if (!needle) return escapeHtml(raw);
  let html = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) {
      html += escapeHtml(raw.slice(cursor));
      break;
    }
    html += escapeHtml(raw.slice(cursor, at));
    html += `<mark>${escapeHtml(raw.slice(at, at + needle.length))}</mark>`;
    cursor = at + needle.length;
  }
  return html;
}

const EMPTY_ART = {
  all: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10h8M8 14h5"/></svg>',
  text: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h8"/></svg>',
  image: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3L16 12l3 3"/></svg>',
  pinned: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.8L12 16.9 6.7 19.6l1.1-5.8L3.5 9.7l5.9-.8L12 3.5z"/></svg>',
  search: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
};

const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8L12 3.6z"/></svg>';
const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 18.5h14"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11.2A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/></svg>';

const FILTER_ORDER = ['all', 'text', 'image', 'pinned'];

function relativeTime(ts) {
  const then = Number(ts);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d`;
  return new Date(then).toLocaleDateString();
}

function matchesQuery(row, query) {
  if (!query) return true;
  if (row.type === 'text') return String(row.text || '').toLowerCase().includes(query);
  // No OCR. Matching every pinned image made any search show unrelated clips.
  // The row label uses a times sign and spaces ("1920 × 1080"); fold those
  // into the same "1920x1080" string the dimensions are stored as.
  const dims = `${row.width || ''}x${row.height || ''}`.toLowerCase();
  const needle = String(query).replace(/×/g, 'x').replace(/\s+/g, '');
  return needle.length > 0 && dims.includes(needle);
}

function visibleRows() {
  const query = ui.search.value.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'text' && row.type !== 'text') return false;
    if (filter === 'image' && row.type !== 'image') return false;
    if (filter === 'pinned' && !row.pinned) return false;
    return matchesQuery(row, query);
  });
}

/* Chromium matches :focus-visible on a text field for focus() as well, including
   the call that runs when the panel opens. The finder border is gated on
   .user-focus, which is added for a click or Tab and cleared around script
   focus. The focus event fires synchronously, so this needs no timer. */
let searchFocusedByScript = false;

function focusSearch() {
  ui.search.classList.remove('user-focus');
  searchFocusedByScript = true;
  try {
    ui.search.focus({ preventScroll: true });
  } finally {
    searchFocusedByScript = false;
  }
}

ui.search.addEventListener('pointerdown', () => {
  ui.search.classList.add('user-focus');
});
ui.search.addEventListener('focus', () => {
  if (!searchFocusedByScript) ui.search.classList.add('user-focus');
});
ui.search.addEventListener('blur', () => {
  ui.search.classList.remove('user-focus');
});

/* --------------------------------------------------------------- screens */

function showScreen(name) {
  const next = name === 'lock' ? ui.lockScreen
    : name === 'settings' ? ui.settingsScreen
    : ui.historyScreen;
  const active = document.activeElement;
  const moveFocus = Boolean(active && active !== document.body && [ui.lockScreen, ui.historyScreen, ui.settingsScreen].some((screen) => (
    screen !== next && !screen.classList.contains('hidden') && screen.contains(active)
  )));
  // Park focus on the title bar before hiding the outgoing screen. The
  // destination input may still be display:none, and focusing that fails,
  // which drops focus and makes Hide-on-blur close the panel.
  if (moveFocus && ui.btnClose) ui.btnClose.focus({ preventScroll: true });
  ui.lockScreen.classList.toggle('hidden', name !== 'lock');
  ui.historyScreen.classList.toggle('hidden', name !== 'history');
  ui.settingsScreen.classList.toggle('hidden', name !== 'settings');
  ui.btnSettings.classList.toggle('is-on', name === 'settings');
  if (!moveFocus) return;
  const target = name === 'lock' ? ui.passInput
    : name === 'settings' ? el('setHotkey')
    : ui.search;
  if (target === ui.search) focusSearch();
  else if (target) target.focus({ preventScroll: true });
}

function showUnreachable() {
  wipeUnlockedView();
  showScreen('lock');
  ui.lockTitle.textContent = 'NextClip';
  ui.lockHint.replaceChildren('Could not reach the vault.');
  ui.lockFootnote.textContent = '';
  ui.lockError.textContent = 'Could not reach the vault.';
  ui.lockError.classList.remove('hidden');
}

function renderLockScreen() {
  if (!state) return;
  const fresh = !state.hasVault;
  ui.lockTitle.textContent = fresh ? 'Create your vault' : 'Unlock your vault';
  // Forced breaks keep each sentence intact. The words are unchanged.
  ui.lockHint.replaceChildren();
  if (fresh) {
    ui.lockHint.append(
      'Encrypts every clip on this device.',
      document.createElement('br'),
      'At least 6 characters.',
    );
  } else {
    ui.lockHint.append(
      'Your clipboard history is',
      document.createElement('br'),
      'encrypted with AES\u2011256\u2011GCM.',
    );
  }
  ui.passSubmit.textContent = fresh ? 'Create vault' : 'Unlock';
  ui.passConfirm.classList.toggle('hidden', !fresh);
  ui.passInput.placeholder = fresh ? 'New passphrase' : 'Passphrase';
  ui.passInput.setAttribute('autocomplete', fresh ? 'new-password' : 'current-password');
  ui.lockFootnote.textContent = fresh
    ? 'If you forget it, this history cannot be recovered.'
    : 'Capture stays paused until you unlock.';
  ui.lockError.classList.add('hidden');
  applyRememberView();
}

function applyRememberView() {
  const remember = (state && state.rememberLogin) || { active: false, days: 1 };
  if (!ui.rememberMe || !ui.rememberDays) return;
  // A refresh while the lock form is focused must not wipe a days value or a
  // checkbox the user has already set.
  if (ui.passForm && ui.passForm.contains(document.activeElement)) return;
  ui.rememberMe.checked = Boolean(remember.active);
  const days = Math.floor(Number(remember.days));
  ui.rememberDays.value = String(Number.isFinite(days) && days >= 1 ? Math.min(90, days) : 1);
}

function rememberPayload() {
  const raw = Math.floor(Number(ui.rememberDays && ui.rememberDays.value));
  return {
    enabled: Boolean(ui.rememberMe && ui.rememberMe.checked),
    days: Number.isFinite(raw) ? Math.min(90, Math.max(1, raw)) : 1,
  };
}

function renderStatus() {
  if (!state) return;
  const unlocked = !state.locked;
  const stats = state.stats || { entries: 0, images: 0, pinned: 0 };
  ui.statusDot.className = `dot ${unlocked ? (state.paused ? 'paused' : 'unlocked') : ''}`;
  ui.statusText.textContent = !state.hasVault ? 'No vault'
    : state.locked ? 'Locked'
    : state.paused ? 'Paused'
    : `${stats.entries} ${stats.entries === 1 ? 'item' : 'items'}`;
  ui.btnLock.classList.toggle('hidden', !unlocked);
  ui.pauseBanner.classList.toggle('hidden', !(unlocked && state.paused));
  ui.btnPause.textContent = state.paused ? 'Resume capture' : 'Pause capture';
  ui.btnPause.classList.toggle('active', Boolean(state.paused));
  if (unlocked) {
    const parts = [`${stats.entries} ${stats.entries === 1 ? 'item' : 'items'}`];
    if (stats.images) parts.push(`${stats.images} ${stats.images === 1 ? 'image' : 'images'}`);
    if (stats.pinned) parts.push(`${stats.pinned} pinned`);
    ui.counts.textContent = parts.join(' · ');
    const hours = Number(state.settings && state.settings.retentionHours);
    const note = el('retentionNote');
    note.textContent = hours > 0 ? `${hours}h retention` : '';
    note.title = hours > 0
      ? `Unpinned items are deleted automatically after ${hours} hours`
      : '';
  } else {
    ui.counts.textContent = '';
    el('retentionNote').textContent = '';
  }
}

/* ------------------------------------------------------------------ list */

function revealSelected() {
  if (!selectedId || ui.historyScreen.classList.contains('hidden')) return;
  const node = document.getElementById(`row-${selectedId}`);
  if (!node) return;
  const listRect = ui.list.getBoundingClientRect();
  const rowRect = node.getBoundingClientRect();
  if (listRect.height === 0 || rowRect.height === 0) return;
  if (rowRect.top < listRect.top) ui.list.scrollTop -= listRect.top - rowRect.top;
  else if (rowRect.bottom > listRect.bottom) ui.list.scrollTop += rowRect.bottom - listRect.bottom;
}

/** Move the highlight without rebuilding rows. A full render restarts the
    entrance animation, so arrow keys and the context menu were jumping the
    list under the pointer. */
function paintSelection() {
  if (!selectedId) return false;
  const node = document.getElementById(`row-${selectedId}`);
  if (!node || node.parentElement !== ui.list) return false;
  for (const other of ui.list.querySelectorAll('.row.selected')) {
    if (other === node) continue;
    other.classList.remove('selected');
    other.setAttribute('aria-selected', 'false');
  }
  node.classList.add('selected');
  node.setAttribute('aria-selected', 'true');
  ui.list.setAttribute('aria-activedescendant', node.id);
  return true;
}

function renderList() {
  if (menuRowId && !rows.some((row) => row.id === menuRowId)) closeRowMenu({ restoreFocus: true });
  const items = visibleRows();
  const query = ui.search.value.trim().toLowerCase();
  const scrollTop = ui.list.scrollTop;   // keep the user's place on re-render
  const selectionBefore = selectedId;
  // Move focus up to the list before its rows are destroyed. A focused action
  // button removed by innerHTML drops focus, and the frameless window then
  // emits blur — Hide-on-blur treats that as a click in another app.
  if (ui.list.contains(document.activeElement) && !ui.historyScreen.classList.contains('hidden')) {
    ui.list.focus({ preventScroll: true });
  }
  ui.list.innerHTML = '';

  // Chip counts always reflect the whole history, not the current view.
  const counts = {
    all: rows.length,
    text: rows.filter((r) => r.type === 'text').length,
    image: rows.filter((r) => r.type === 'image').length,
    pinned: rows.filter((r) => r.pinned).length,
  };
  for (const node of document.querySelectorAll('.chip .count')) {
    node.textContent = counts[node.dataset.count] || '';
  }

  // Result line: only worth the space while it carries information.
  ui.resultCount.textContent = query
    ? `${items.length} match${items.length === 1 ? '' : 'es'}`
    : '';

  ui.searchClear.classList.toggle('show', Boolean(query));
  ui.searchClear.tabIndex = query ? 0 : -1;

  const searching = Boolean(query);
  const artKey = searching ? 'search' : filter;
  const title = searching
    ? 'No matches'
    : { all: 'Nothing copied yet', text: 'No text yet', image: 'No images yet', pinned: 'Nothing pinned' }[filter];
  const hint = searching
    ? ''
    : {
        all: 'Encrypted on this device.',
        text: 'Text you copy shows up here.',
        image: 'Images you copy show up here.',
        pinned: 'Pinned copies stay here.',
      }[filter];

  ui.empty.classList.toggle('hidden', items.length > 0);
  ui.emptyText.textContent = title;
  ui.emptyHint.textContent = hint;
  ui.emptyArt.innerHTML = EMPTY_ART[artKey] || EMPTY_ART.all;

  if (items.length === 0) {
    selectedId = null;
    ui.list.removeAttribute('aria-activedescendant');
    return;
  }
  if (selectedIndex(items) === -1) selectedId = items[0].id;

  const fragment = document.createDocumentFragment();
  items.forEach((row, index) => {
    const isSelected = row.id === selectedId;
    const node = document.createElement('div');
    node.className = `row${row.type === 'image' ? ' row-image' : ''}${isSelected ? ' selected' : ''}${row.pinned ? ' is-pinned' : ''}`;
    // Stagger only the first handful; past that it just looks slow.
    node.style.animationDelay = `${Math.min(index, 8) * 18}ms`;
    node.dataset.id = row.id;
    node.id = `row-${row.id}`;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(isSelected));

    if (row.type === 'image' && row.thumb) {
      const img = document.createElement('img');
      img.className = 'row-thumb';
      img.draggable = false;
      img.src = row.thumb;
      img.alt = `Copied image ${row.width}×${row.height}`;
      node.appendChild(img);
    }

    const main = document.createElement('div');
    main.className = 'row-main';

    const text = document.createElement('div');
    text.className = 'row-text';
    if (row.type === 'image') {
      text.textContent = `${row.width} × ${row.height}`;
    } else {
      // Highlighting builds markup from escaped text only.
      text.innerHTML = highlight(row.text, query);
    }
    main.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const time = document.createElement('span');
    time.textContent = relativeTime(row.ts);
    meta.appendChild(time);
    if (row.pinned) {
      const star = document.createElement('span');
      star.className = 'pin-mark';
      star.setAttribute('aria-label', 'Pinned');
      star.innerHTML = ICON_PIN.replace('<path', '<path fill="currentColor"');
      meta.appendChild(star);
    }
    main.appendChild(meta);
    node.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.innerHTML = row.pinned
      ? ICON_PIN.replace('<path', '<path fill="currentColor"')
      : ICON_PIN;
    pinBtn.dataset.tip = row.pinned ? 'Unpin (P)' : 'Pin (P)';
    pinBtn.className = row.pinned ? 'pin-btn is-pinned' : 'pin-btn';
    pinBtn.setAttribute('aria-label', row.pinned ? 'Unpin' : 'Pin');
    pinBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await togglePin(row.id);
    });
    actions.appendChild(pinBtn);

    if (row.type === 'image') {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.innerHTML = ICON_SAVE;
      saveBtn.dataset.tip = 'Save (S)';
      saveBtn.setAttribute('aria-label', 'Save image');
      saveBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await saveImage(row.id);
      });
      actions.appendChild(saveBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.innerHTML = ICON_DELETE;
    delBtn.dataset.tip = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete entry');
    delBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deleteEntry(row.id);
    });
    actions.appendChild(delBtn);

    node.appendChild(actions);
    node.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target && target.closest && target.closest('button, a, input, textarea, select')) return;
      // Leave focus where it is. Shifting it on mousedown blurs this frameless
      // window, and Hide-on-blur would close the panel before the click copies.
      event.preventDefault();
    });
    node.addEventListener('click', () => {
      selectedId = row.id;
      for (const other of ui.list.querySelectorAll('.row.selected')) {
        if (other === node) continue;
        other.classList.remove('selected');
        other.setAttribute('aria-selected', 'false');
      }
      node.classList.add('selected');
      node.setAttribute('aria-selected', 'true');
      ui.list.setAttribute('aria-activedescendant', node.id);
      restore(row.id);
    });
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      selectedId = row.id;
      openRowMenu(row, event.clientX, event.clientY);
    });
    fragment.appendChild(node);
  });

  ui.list.appendChild(fragment);
  ui.list.scrollTop = scrollTop;
  ui.list.setAttribute('aria-activedescendant', `row-${selectedId}`);
  // Selecting a row that is no longer in the visible set used to leave the
  // highlight on the first item, above the current scroll position.
  if (selectedId !== selectionBefore) revealSelected();
}

async function restore(id) {
  if (restoreBusy) return;
  restoreBusy = true;
  try {
    const result = await api.restore(id);
    if (!result || !result.ok) {
      toast((result && result.error) || 'Could not restore that entry');
      return;
    }
    const copied = document.getElementById(`row-${id}`);
    if (copied) {
      copied.classList.add('just-copied');
      setTimeout(() => copied.classList.remove('just-copied'), 650);
    }
    const isImage = rows.find((r) => r.id === id)?.type === 'image';
    toast(isImage ? 'Image copied to clipboard' : 'Copied to clipboard');
    // Apply the same preference for mouse, keyboard, and context-menu restores.
    if (state && state.settings && state.settings.hideOnRestore) api.hide();
  } catch (err) {
    toast('Could not restore that entry');
  } finally {
    restoreBusy = false;
  }
}

/** Drop decrypted rows when the vault locks. The history section is only hidden otherwise. */
function wipeUnlockedView() {
  rows = [];
  selectedId = null;
  ui.search.value = '';
  ui.list.innerHTML = '';
  // A lock must also remove any credentials left in hidden settings fields.
  ui.passInput.value = '';
  ui.passConfirm.value = '';
  el('passCurrent').value = '';
  el('passNew').value = '';
  el('passNew2').value = '';
  closeRowMenu();
}

async function undoLast() {
  try {
    const result = await api.undo();
    if (!result || !result.ok) {
      if (result && result.error) toast(result.error, { label: 'Undo', run: undoLast });
      else toast('Nothing to restore');
      return;
    }
    await refresh();
    const count = Number(result.count) || 0;
    toast(count ? `Restored ${count} item${count === 1 ? '' : 's'}` : 'Restored');
  } catch (err) {
    toast('Could not undo');
  }
}

/** Destructive actions stage an undo instead of asking for confirmation. */
async function deleteEntry(id) {
  if (deleteBusy) return;
  deleteBusy = true;
  const items = visibleRows();
  const index = items.findIndex((row) => row.id === id);
  try {
    const result = await api.remove(id);
    if (!result || !result.ok) {
      toast((result && result.error) || 'Could not delete that entry');
      return;
    }
    if (selectedId === id) {
      const neighbor = items[index + 1] || items[index - 1] || null;
      selectedId = neighbor ? neighbor.id : null;
    }
    await refresh();
    revealSelected();
    toast('Deleted', result.undo ? { label: 'Undo', run: undoLast } : null);
  } catch (err) {
    toast('Could not delete that entry');
  } finally {
    deleteBusy = false;
  }
}

async function togglePin(id) {
  if (pinBusy) return;
  pinBusy = true;
  try {
    const pinned = await api.pin(id);
    await refresh();
    const after = rows.find((row) => row.id === id);
    // pin() returns false both for a failed toggle and for a successful unpin,
    // so the row that came back is what the toast reports.
    if (typeof pinned !== 'boolean' || !after) {
      toast('Could not update that pin');
      return;
    }
    toast(after.pinned ? 'Pinned — will never auto-delete' : 'Unpinned');
  } catch (err) {
    toast('Could not update that pin');
  } finally {
    pinBusy = false;
  }
}

async function clearAll() {
  if (clearBusy || !rows.length) return;
  clearBusy = true;
  const removed = rows.length;
  try {
    const result = await api.clear();
    if (!result || result.ok === false) {
      toast((result && result.error) || 'Could not clear history');
      return;
    }
    selectedId = null;
    await refresh();
    const count = result.removed ?? removed;
    toast(`Cleared ${count} item${count === 1 ? '' : 's'}`, result.undo ? { label: 'Undo', run: undoLast } : null);
  } catch (err) {
    toast('Could not clear history');
  } finally {
    clearBusy = false;
  }
}

/* --------------------------------------------------------- context menu */

function closeRowMenu({ restoreFocus = false } = {}) {
  const focusInside = ui.rowMenu.contains(document.activeElement);
  const shouldFocus = restoreFocus && focusInside && !ui.historyScreen.classList.contains('hidden');
  // Drop the flag before moving focus so the menu's focusout handler does not
  // close it a second time. Move focus before hiding: display:none on the
  // focused item blurs the frameless window.
  menuRowId = null;
  if (shouldFocus) ui.list.focus({ preventScroll: true });
  ui.rowMenu.classList.add('hidden');
}

function openRowMenu(row, x, y) {
  const menu = ui.rowMenu;
  menu.innerHTML = '';
  menuRowId = row.id;

  const item = (label, hint, onClick, danger) => {
    const button = document.createElement('button');
    button.type = 'button';
    if (danger) button.className = 'danger';
    button.setAttribute('role', 'menuitem');
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    button.appendChild(labelNode);
    if (hint) {
      const hintNode = document.createElement('span');
      hintNode.className = 'menu-hint';
      hintNode.textContent = hint;
      button.appendChild(hintNode);
    }
    button.addEventListener('click', () => {
      closeRowMenu({ restoreFocus: true });
      onClick();
    });
    menu.appendChild(button);
    return button;
  };

  const sep = () => {
    const line = document.createElement('div');
    line.className = 'menu-sep';
    menu.appendChild(line);
  };

  item('Copy back', 'Enter', () => restore(row.id));
  item(row.pinned ? 'Unpin' : 'Pin', 'P', () => togglePin(row.id));
  if (row.type === 'image') item('Save to file…', 'S', () => saveImage(row.id));
  sep();
  item('Delete', '', () => deleteEntry(row.id), true);

  menu.classList.remove('hidden');
  // Flip the menu back inside the panel if it would overflow.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
  if (!paintSelection()) renderList();
  menu.querySelector('button')?.focus({ preventScroll: true });
}

ui.rowMenu.addEventListener('keydown', (event) => {
  // Stop the key from reaching the panel handler. Escape would otherwise
  // close the menu and then hide the window, and Enter would copy the row
  // instead of activating the focused menu item.
  const items = [...ui.rowMenu.querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeRowMenu({ restoreFocus: true });
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    if (!items.length) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    return;
  }
  // Enter keeps the button's default click. stopPropagation is what stops
  // the row-restore shortcut.
  event.stopPropagation();
});

ui.rowMenu.addEventListener('focusout', (event) => {
  if (!menuRowId) return;
  const next = event.relatedTarget;
  if (next && ui.rowMenu.contains(next)) return;
  setTimeout(() => {
    if (!menuRowId) return;
    if (ui.rowMenu.contains(document.activeElement)) return;
    closeRowMenu({ restoreFocus: true });
  }, 0);
});

async function saveImage(id) {
  try {
    const result = await api.saveImage(id);
    if (!result || result.canceled) return;
    if (result.ok) toast(`Saved to ${String(result.path || '').split(/[\\/]/).pop()}`);
    else toast(result.error || 'Could not save that image');
  } catch (err) {
    toast('Could not save that image');
  }
}

/* -------------------------------------------------------------- data flow */

async function refresh() {
  const epoch = ++listEpoch;
  const serialAtStart = stateSerial;
  let snapshot;
  try {
    snapshot = await api.status();
  } catch (err) {
    if (epoch !== listEpoch) return;
    if (!state) showUnreachable();
    else toast('Could not refresh the vault');
    return;
  }
  // A newer list() or refresh started. Do not apply this snapshot: assigning
  // it used to put a stale lock flag back after a newer unlock.
  if (epoch !== listEpoch) return;
  // vault:state can land while status() is still open. Keep that newer
  // snapshot; applying this one would undo a lock or a pause.
  if (stateSerial !== serialAtStart) {
    if (!state || state.locked) return;
  } else {
    if (!snapshot) {
      showUnreachable();
      return;
    }
    state = snapshot;
    renderStatus();
    applyDensity();
    if (state.locked) {
      const showLock = ui.lockScreen.classList.contains('hidden');
      wipeUnlockedView();
      renderLockScreen();
      showScreen('lock');
      if (showLock && document.hasFocus() && document.activeElement !== ui.passInput) {
        ui.passInput.focus({ preventScroll: true });
      }
      return;
    }
  }
  try {
    const next = await api.list();
    if (epoch !== listEpoch || !state || state.locked) return;
    rows = Array.isArray(next) ? next : [];
    renderList();
    if (!ui.settingsScreen.classList.contains('hidden')) return;
    showScreen('history');
  } catch (err) {
    if (epoch !== listEpoch || !state || state.locked) return;
    toast('Could not load history');
    if (ui.settingsScreen.classList.contains('hidden')) showScreen('history');
  }
}

/* ------------------------------------------------------------ interactions */

ui.passForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (passBusy) return;
  if (!state) {
    ui.lockError.textContent = 'Vault is still starting. Try again in a moment.';
    ui.lockError.classList.remove('hidden');
    return;
  }
  const passphrase = ui.passInput.value;
  const fresh = !state.hasVault;

  if (fresh && passphrase !== ui.passConfirm.value) {
    ui.lockError.textContent = 'The two passphrases do not match.';
    ui.lockError.classList.remove('hidden');
    return;
  }

  // The flag is set before any await so a second Enter cannot start another
  // create/unlock. Disabling the focused control would drop window focus.
  passBusy = true;
  if (document.activeElement !== ui.passSubmit) ui.passSubmit.disabled = true;
  ui.lockError.classList.add('hidden');
  let failedSelect = false;
  try {
    const result = fresh
      ? await api.create(passphrase, rememberPayload())
      : await api.unlock(passphrase, rememberPayload());
    if (!result || !result.ok) {
      ui.lockError.textContent = {
        weak: 'Passphrase must be at least 6 characters.',
        badpass: 'Incorrect passphrase.',
        corrupt: 'The vault file looks damaged.',
        missing: 'No vault file found yet.',
      }[result && result.code] || (result && result.message) || 'Could not unlock the vault.';
      ui.lockError.classList.remove('hidden');
      failedSelect = true;
      return;
    }

    state = result.state;
    ui.passInput.value = '';
    ui.passConfirm.value = '';
    renderStatus();
    applyDensity();
    showScreen('history');
    const epoch = ++listEpoch;
    try {
      const next = await api.list();
      if (epoch === listEpoch && state && !state.locked) {
        rows = Array.isArray(next) ? next : [];
        renderList();
      }
    } catch (err) {
      if (epoch === listEpoch) toast('Could not load history');
    }
    if (document.activeElement !== ui.search) focusSearch();
  } catch (err) {
    ui.lockError.textContent = 'Could not unlock the vault.';
    ui.lockError.classList.remove('hidden');
    failedSelect = true;
  } finally {
    passBusy = false;
    ui.passSubmit.disabled = false;
    if (failedSelect) ui.passInput.select();
  }
});

ui.search.addEventListener('input', () => {
  selectedId = null;
  renderList();
});

ui.searchClear.addEventListener('click', () => {
  ui.search.value = '';
  selectedId = null;
  renderList();
  focusSearch();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.chip')) {
      other.classList.remove('active');
      other.setAttribute('aria-pressed', 'false');
    }
    chip.classList.add('active');
    chip.setAttribute('aria-pressed', 'true');
    filter = chip.dataset.filter;
    // Slide the segmented indicator to the active tab.
    const index = FILTER_ORDER.indexOf(filter);
    el('seg').style.setProperty('--seg-index', String(index < 0 ? 0 : index));
    selectedId = null;
    renderList();
  });
}

async function togglePause() {
  if (pauseBusy || !state) return;
  pauseBusy = true;
  try {
    await api.setPaused(!state.paused);
    await refresh();
  } catch (err) {
    toast('Could not change capture');
  } finally {
    pauseBusy = false;
  }
}

ui.btnPause.addEventListener('click', togglePause);
el('btnResume').addEventListener('click', togglePause);

ui.btnClear.addEventListener('click', () => clearAll());

ui.btnClose.addEventListener('click', () => {
  Promise.resolve(api.hide()).catch(() => toast('Could not hide the panel'));
});

ui.btnLock.addEventListener('click', async () => {
  if (lockBusy) return;
  lockBusy = true;
  try {
    await api.lock();
    await refresh();
    if (state && state.locked) ui.passInput.focus({ preventScroll: true });
  } catch (err) {
    toast('Could not lock the vault');
  } finally {
    lockBusy = false;
  }
});

/* --------------------------------------------------------------- settings */

function readBoundedNumber(id, min, max, fallback) {
  const raw = String(el(id).value).trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function fillSettings() {
  if (!state || !state.settings) return false;
  const s = state.settings;
  el('setHotkey').value = s.hotkey;
  el('setShotHotkey').value = s.screenshotHotkey;
  el('setMax').value = s.maxEntries;
  el('setAutoLock').value = s.autoLockMinutes;
  el('setRetention').value = s.retentionHours;
  el('setDensity').value = s.density === 'compact' ? 'compact' : 'comfortable';
  el('setHideOnBlur').checked = s.hideOnBlur;
  el('setHideOnRestore').checked = s.hideOnRestore;
  el('setBubblePinned').checked = s.bubblePinned !== false;
  el('setCaptureImages').checked = s.captureImages;
  el('setAutoSaveShots').checked = s.autoSaveScreenshots;
  // Reflect what the OS actually reports, not just what we asked for.
  el('setAutoStart').checked = Boolean(state.autoStartActive);
  el('autoStartNote').textContent = !state.packaged
    ? 'Dev build starts from this project path.'
    : '';
  const hotkeyStatus = el('hotkeyStatus');
  hotkeyStatus.textContent = state.hotkeyBound
    ? ''
    : 'Already used by another app.';
  hotkeyStatus.classList.toggle('bad', !state.hotkeyBound);
  const shotStatus = el('shotHotkeyStatus');
  shotStatus.textContent = state.screenshotHotkeyBound
    ? ''
    : 'Already used by another app.';
  shotStatus.classList.toggle('bad', !state.screenshotHotkeyBound);
  return true;
}

function settingsPatch() {
  return {
    hotkey: el('setHotkey').value.replace(/\s+/g, '') || 'Control+Shift+V',
    screenshotHotkey: el('setShotHotkey').value.replace(/\s+/g, '') || 'Control+Shift+S',
    maxEntries: readBoundedNumber('setMax', 20, 2000, 300),
    autoLockMinutes: readBoundedNumber('setAutoLock', 0, 240, 0),
    retentionHours: readBoundedNumber('setRetention', 0, 8760, 0),
    density: el('setDensity').value === 'compact' ? 'compact' : 'comfortable',
    hideOnBlur: el('setHideOnBlur').checked,
    hideOnRestore: el('setHideOnRestore').checked,
    bubblePinned: el('setBubblePinned').checked,
    autoStart: el('setAutoStart').checked,
    captureImages: el('setCaptureImages').checked,
    autoSaveScreenshots: el('setAutoSaveShots').checked,
  };
}

ui.btnSettings.addEventListener('click', () => {
  if (!ui.settingsScreen.classList.contains('hidden')) {
    showScreen(state && state.locked ? 'lock' : 'history');
    return;
  }
  if (!fillSettings()) return;
  showScreen('settings');
});

el('btnDone').addEventListener('click', async () => {
  if (settingsBusy) return;
  settingsBusy = true;
  const done = el('btnDone');
  if (document.activeElement !== done) done.disabled = true;
  const message = el('settingsMessage');
  try {
    await api.saveSettings(settingsPatch());
    await refresh();
    if (!state || state.locked) {
      showScreen('lock');
      if (state && state.locked) ui.passInput.focus({ preventScroll: true });
      return;
    }
    showScreen('history');
  } catch (err) {
    message.textContent = 'Could not save settings.';
    message.className = 'field-note bad';
  } finally {
    settingsBusy = false;
    done.disabled = false;
  }
});

async function scheduleScreenshot() {
  try {
    await api.hide();
  } catch (err) {
    toast('Could not start a screenshot');
    return;
  }
  setTimeout(() => {
    Promise.resolve(api.screenshot()).catch(() => toast('Could not start a screenshot'));
  }, 180);
}

el('btnShotNow').addEventListener('click', scheduleScreenshot);

el('btnOpenShotDir').addEventListener('click', () => {
  Promise.resolve(api.openScreenshotDir()).then((dir) => {
    if (!dir) toast('Could not open the screenshots folder');
  }).catch(() => toast('Could not open the screenshots folder'));
});

el('btnShot').addEventListener('click', scheduleScreenshot);

el('btnChangePass').addEventListener('click', async () => {
  if (passChangeBusy) return;
  const current = el('passCurrent').value;
  const next = el('passNew').value;
  const message = el('settingsMessage');
  const note = (text, kind) => {
    message.textContent = text;
    message.className = `field-note${kind ? ` ${kind}` : ''}`;
  };
  if (next !== el('passNew2').value) {
    note('The new passphrases do not match.', 'bad');
    return;
  }
  passChangeBusy = true;
  try {
    const result = await api.changePassphrase(current, next);
    if (!result || !result.ok) {
      note({
        weak: 'New passphrase must be at least 6 characters.',
        badpass: 'Current passphrase is incorrect.',
        corrupt: 'The vault file looks damaged.',
        locked: 'Unlock the vault before changing the passphrase.',
      }[result && result.code] || (result && result.message) || 'Could not update the passphrase.', 'bad');
      return;
    }
    note('Passphrase updated. Every entry was re-encrypted.', 'ok');
    el('passCurrent').value = '';
    el('passNew').value = '';
    el('passNew2').value = '';
  } catch (err) {
    note('Could not update the passphrase.', 'bad');
  } finally {
    passChangeBusy = false;
  }
});

el('btnReveal').addEventListener('click', () => {
  Promise.resolve(api.revealVaultFile()).catch(() => toast('Could not show the vault file'));
});

/* -------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', async (event) => {
  if (event.isComposing || event.key === 'Process') return;

  if (menuRowId) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRowMenu({ restoreFocus: true });
    }
    return;
  }

  const field = isTextField(event.target) ? event.target : null;
  const inSearch = field === ui.search;

  if (event.key === 'Escape') {
    if (!ui.settingsScreen.classList.contains('hidden')) {
      showScreen(state && state.locked ? 'lock' : 'history');
      return;
    }
    if (inSearch && ui.search.value) {
      event.preventDefault();
      ui.search.value = '';
      selectedId = null;
      renderList();
      return;
    }
    api.hide();
    return;
  }

  // Ctrl+L is the lock shortcut, including from the search box (the panel
  // opens with search focused). It must not fire while a passphrase or a
  // settings field is being edited.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l') {
    if (field && !inSearch) return;
    event.preventDefault();
    if (lockBusy) return;
    lockBusy = true;
    try {
      await api.lock();
      await refresh();
      if (state && state.locked) ui.passInput.focus({ preventScroll: true });
    } catch (err) {
      toast('Could not lock the vault');
    } finally {
      lockBusy = false;
    }
    return;
  }

  const onHistory = !ui.historyScreen.classList.contains('hidden');
  if (!onHistory) return;
  if (field && !inSearch) return;

  if (event.key === '/' && !inSearch && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusSearch();
    return;
  }

  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const items = visibleRows();
    if (!items.length) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const current = selectedIndex(items);
    const next = Math.max(0, Math.min(items.length - 1, (current === -1 ? -1 : current) + delta));
    selectedId = items[next].id;
    if (!paintSelection()) renderList();
    revealSelected();
    return;
  }

  // Letters, Backspace, and Delete edit the search box. Enter still copies
  // the highlighted row: the panel opens with search focused.
  if (inSearch && event.key !== 'Enter') return;

  if (event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Enter' && event.target.closest && event.target.closest('button, a')) return;

  const items = visibleRows();
  const current = selectedIndex(items);
  const currentRow = current >= 0 ? items[current] : null;

  if (event.key === 'Enter' && currentRow) {
    event.preventDefault();
    await restore(currentRow.id);
    return;
  }

  if ((event.key === 'p' || event.key === 'P') && currentRow) {
    event.preventDefault();
    await togglePin(currentRow.id);
    return;
  }

  if ((event.key === 's' || event.key === 'S') && currentRow) {
    if (currentRow.type !== 'image') {
      toast('Only images can be saved to a file');
      return;
    }
    event.preventDefault();
    await saveImage(currentRow.id);
    return;
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && currentRow) {
    event.preventDefault();
    await deleteEntry(currentRow.id);
  }
});

// Any keystroke counts as activity for the auto-lock timer.
// Wheel is throttled: a scroll gesture would otherwise flood IPC.
let nextActivity = 0;
function pokeActivity() {
  const now = Date.now();
  if (now < nextActivity) return;
  nextActivity = now + 4000;
  Promise.resolve(api.activity()).catch(() => {});
}
document.addEventListener('keydown', () => pokeActivity(), true);
document.addEventListener('mousedown', () => pokeActivity(), true);
document.addEventListener('wheel', () => pokeActivity(), { capture: true, passive: true });
// A focused number input treats wheel as a spinner. That silently changes
// retention, auto-lock, max entries, or remember-me days while scrolling.
document.addEventListener('wheel', (event) => {
  const target = document.activeElement;
  if (!target || target.tagName !== 'INPUT' || target.type !== 'number') return;
  event.preventDefault();
}, { capture: true, passive: false });

/* ------------------------------------------------------------------ boot */

api.onState((next) => {
  if (!next) return;
  stateSerial += 1;
  const wasLocked = !state || state.locked;
  const bubblePinChanged = Boolean(state && state.settings
    && next.settings && state.settings.bubblePinned !== next.settings.bubblePinned);
  const showLock = Boolean(next.locked) && ui.lockScreen.classList.contains('hidden');
  state = next;
  // A tray change should also update an already-open Settings panel. Other
  // state events leave an unsaved switch alone until the user presses Done.
  if (bubblePinChanged) el('setBubblePinned').checked = state.settings.bubblePinned !== false;
  renderStatus();
  applyDensity();
  if (state.locked) {
    wipeUnlockedView();
    renderLockScreen();
    showScreen('lock');
    if (showLock && document.hasFocus() && document.activeElement !== ui.passInput) {
      ui.passInput.focus({ preventScroll: true });
    }
  } else if (wasLocked) {
    refresh().catch(() => {});
  }
});

api.onChanged(() => {
  if (!state || state.locked) return;
  const epoch = ++listEpoch;
  api.list().then((next) => {
    if (epoch !== listEpoch || !state || state.locked) return;
    rows = Array.isArray(next) ? next : [];
    renderList();
  }).catch(() => {
    toast('Could not load history');
  });
});

api.onShown(() => {
  refresh().then(() => {
    if (!ui.settingsScreen.classList.contains('hidden') && state && !state.locked) return;
    if (!state || state.locked) ui.passInput.focus({ preventScroll: true });
    else focusSearch();
  }).catch(() => {
    if (!state) showUnreachable();
  });
});

api.onOpenSettings(() => {
  refresh().then(() => {
    if (!state || state.locked || !fillSettings()) return;
    showScreen('settings');
  }).catch(() => toast('Could not open settings'));
});

api.onToast((message) => toast(message));

refresh().then(() => {
  applyDensity();
  if (state && state.locked) ui.passInput.focus({ preventScroll: true });
}).catch(() => {
  if (!state) showUnreachable();
});
