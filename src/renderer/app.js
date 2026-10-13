'use strict';

/* ClipVault panel logic. Talks to the main process only through window.clipvault. */

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
};

let state = null;
let rows = [];
let filter = 'all';
let selectedId = null;      // tracked by id, not index, so it survives re-renders
let toastTimer = null;
let toastAction = null;     // callback for the toast's action button
let menuRowId = null;       // row the context menu belongs to

/* ----------------------------------------------------------------- utils */

/** Toast with an optional action button (used for undo). */
function toast(message, action) {
  ui.toastText.textContent = message;
  ui.toastAction.classList.toggle('hidden', !action);
  if (action) {
    ui.toastAction.textContent = action.label;
    toastAction = action.run;
  }
  ui.toast.classList.remove('hidden', 'out');
  // Restart the entrance animation even for back-to-back toasts.
  ui.toast.style.animation = 'none';
  void ui.toast.offsetHeight;
  ui.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, action ? 5200 : 1800);
}

function dismissToast() {
  clearTimeout(toastTimer);
  ui.toast.classList.add('out');
  setTimeout(() => {
    ui.toast.classList.add('hidden');
    ui.toastAction.classList.add('hidden');
    toastAction = null;
  }, 220);
}

ui.toastAction.addEventListener('click', () => {
  const run = toastAction;
  dismissToast();
  if (run) run();
});

/** Index of the selected row within the currently visible set. */
function selectedIndex(items = visibleRows()) {
  if (!selectedId) return -1;
  return items.findIndex((r) => r.id === selectedId);
}

function applyDensity() {
  const compact = state && state.settings.density === 'compact';
  document.body.classList.toggle('density-compact', Boolean(compact));
}

/* Dismiss the context menu on any outside interaction. */
document.addEventListener('mousedown', (event) => {
  if (menuRowId && !ui.rowMenu.contains(event.target)) closeRowMenu();
});
window.addEventListener('blur', closeRowMenu);
window.addEventListener('resize', closeRowMenu);

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Escape, then wrap query matches in <mark>. Never injects raw HTML. */
function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const needle = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(needle, 'gi'), (hit) => `<mark>${hit}</mark>`);
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
  const diff = Date.now() - ts;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function matchesQuery(row, query) {
  if (!query) return true;
  if (row.type === 'text') return row.text.toLowerCase().includes(query);
  // Images are searched by being recent/pinned rather than by OCR-free content.
  return row.pinned;
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

/* --------------------------------------------------------------- screens */

function showScreen(name) {
  ui.lockScreen.classList.toggle('hidden', name !== 'lock');
  ui.historyScreen.classList.toggle('hidden', name !== 'history');
  ui.settingsScreen.classList.toggle('hidden', name !== 'settings');
}

function renderLockScreen() {
  const fresh = !state.hasVault;
  ui.lockTitle.textContent = fresh ? 'Create your vault' : 'Unlock your vault';
  ui.lockHint.textContent = fresh
    ? 'Pick a passphrase. It encrypts every clipboard entry with AES-256-GCM and is never stored anywhere but your head.'
    : 'Your clipboard history is encrypted with AES-256-GCM.';
  ui.passSubmit.textContent = fresh ? 'Create vault' : 'Unlock';
  ui.passConfirm.classList.toggle('hidden', !fresh);
  ui.passInput.placeholder = fresh ? 'Choose a passphrase (min 6)' : 'Passphrase';
  ui.passInput.setAttribute('autocomplete', fresh ? 'new-password' : 'current-password');
  ui.lockFootnote.textContent = fresh
    ? 'There is no recovery: a lost passphrase means a lost history.'
    : 'Capture is paused while the vault is locked.';
  ui.lockError.classList.add('hidden');
}

function renderStatus() {
  const unlocked = state && !state.locked;
  ui.statusDot.className = `dot ${unlocked ? (state.paused ? 'paused' : 'unlocked') : ''}`;
  ui.statusText.textContent = !state.hasVault ? 'no vault'
    : state.paused ? 'capture paused'
    : unlocked ? `${state.stats.entries} item${state.stats.entries === 1 ? '' : 's'}`
    : 'locked';
  ui.btnLock.classList.toggle('hidden', !unlocked);
  ui.btnPause.textContent = state.paused ? 'Resume capture' : 'Pause capture';
  ui.btnPause.classList.toggle('active', state.paused);
  if (unlocked) {
    const s = state.stats;
    ui.counts.textContent = `${s.entries} item${s.entries === 1 ? '' : 's'} · ${s.images} img · ${s.pinned} pinned`;
    const hours = Number(state.settings.retentionHours);
    const note = el('retentionNote');
    note.textContent = hours > 0 ? `${hours}h` : '';
    note.title = hours > 0
      ? `Unpinned items are deleted automatically after ${hours} hours`
      : '';
  } else {
    ui.counts.textContent = '';
    el('retentionNote').textContent = '';
  }
}

/* ------------------------------------------------------------------ list */

function renderList() {
  const items = visibleRows();
  const query = ui.search.value.trim().toLowerCase();
  const scrollTop = ui.list.scrollTop;   // keep the user's place on re-render
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

  const searching = Boolean(query);
  const artKey = searching ? 'search' : filter;
  const title = searching
    ? `Nothing matches “${ui.search.value.trim()}”`
    : { all: 'Nothing copied yet', text: 'No text entries yet', image: 'No images yet', pinned: 'Nothing pinned yet' }[filter];
  const hint = searching
    ? 'Try a different search, or clear it with the × button.'
    : {
        all: 'Copy some text or an image and it lands here, encrypted.',
        text: 'Copy text anywhere and it shows up here.',
        image: 'Copy an image, or press Ctrl+Shift+S to grab a region.',
        pinned: 'Press P on a row to keep it forever.',
      }[filter];

  ui.empty.classList.toggle('hidden', items.length > 0);
  ui.emptyText.textContent = title;
  ui.emptyHint.textContent = hint;
  ui.emptyArt.innerHTML = EMPTY_ART[artKey] || EMPTY_ART.all;

  if (items.length === 0) {
    selectedId = null;
    return;
  }
  if (selectedIndex(items) === -1) selectedId = items[0].id;

  const fragment = document.createDocumentFragment();
  items.forEach((row, index) => {
    const isSelected = row.id === selectedId;
    const node = document.createElement('div');
    node.className = `row${isSelected ? ' selected' : ''}`;
    // Stagger only the first handful; past that it just looks slow.
    node.style.animationDelay = `${Math.min(index, 8) * 18}ms`;
    node.dataset.id = row.id;
    node.id = `row-${row.id}`;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(isSelected));

    if (row.type === 'image') {
      const img = document.createElement('img');
      img.className = 'row-thumb';
      img.src = row.thumb;
      img.alt = `Copied image ${row.width}×${row.height}`;
      node.appendChild(img);
    }

    const main = document.createElement('div');
    main.className = 'row-main';

    const text = document.createElement('div');
    text.className = 'row-text';
    if (row.type === 'image') {
      text.textContent = `Image ${row.width}×${row.height}`;
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
    const kind = document.createElement('span');
    kind.className = 'badge';
    kind.textContent = row.type;
    meta.appendChild(kind);
    if (row.pinned) {
      const badge = document.createElement('span');
      badge.className = 'badge pinned';
      badge.textContent = 'pinned';
      meta.appendChild(badge);
    }
    main.appendChild(meta);
    node.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const pinBtn = document.createElement('button');
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
    node.addEventListener('click', () => restore(row.id));
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
}

async function restore(id) {
  const result = await api.restore(id);
  if (!result.ok) {
    toast(result.error || 'Could not restore that entry');
    return;
  }
  const isImage = rows.find((r) => r.id === id)?.type === 'image';
  toast(isImage ? 'Image copied to clipboard' : 'Copied to clipboard');
  if (state && state.settings.hideOnRestore) {
    ui.list.blur();
    api.hide();
  }
}

/** Destructive actions stage an undo instead of asking for confirmation. */
async function deleteEntry(id) {
  const result = await api.remove(id);
  if (!result.ok) return;
  if (selectedId === id) selectedId = null;
  await refresh();
  toast('Deleted', {
    label: 'Undo',
    run: async () => {
      await api.undo();
      await refresh();
      toast('Restored');
    },
  });
}

async function togglePin(id) {
  const pinned = await api.pin(id);
  await refresh();
  toast(pinned ? 'Pinned — will never auto-delete' : 'Unpinned');
}

async function clearAll() {
  if (!rows.length) return;
  const removed = rows.length;
  await api.clear();
  selectedId = null;
  await refresh();
  toast(`Cleared ${removed} item${removed === 1 ? '' : 's'}`, {
    label: 'Undo',
    run: async () => {
      const result = await api.undo();
      await refresh();
      toast(result.ok ? `Restored ${result.count} items` : 'Nothing to restore');
    },
  });
}

/* --------------------------------------------------------- context menu */

function closeRowMenu() {
  ui.rowMenu.classList.add('hidden');
  menuRowId = null;
}

function openRowMenu(row, x, y) {
  const menu = ui.rowMenu;
  menu.innerHTML = '';
  menuRowId = row.id;

  const item = (label, hint, onClick, danger) => {
    const button = document.createElement('button');
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
      closeRowMenu();
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
  renderList();
  menu.querySelector('button')?.focus();
}

ui.rowMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeRowMenu();
  }
});

async function saveImage(id) {
  const result = await api.saveImage(id);
  if (result.canceled) return;
  if (result.ok) toast(`Saved to ${result.path.split(/[\\/]/).pop()}`);
  else toast(result.error || 'Could not save that image');
}

/* -------------------------------------------------------------- data flow */

async function refresh() {
  state = await api.status();
  renderStatus();
  if (state.locked) {
    showScreen('lock');
    renderLockScreen();
    return;
  }
  rows = await api.list();
  renderList();
  if (ui.settingsScreen.classList.contains('hidden') === false) return;
  showScreen('history');
}

/* ------------------------------------------------------------ interactions */

ui.passForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const passphrase = ui.passInput.value;
  const fresh = !state.hasVault;

  if (fresh && passphrase !== ui.passConfirm.value) {
    ui.lockError.textContent = 'The two passphrases do not match.';
    ui.lockError.classList.remove('hidden');
    return;
  }

  ui.passSubmit.disabled = true;
  ui.lockError.classList.add('hidden');
  try {
    const result = fresh ? await api.create(passphrase) : await api.unlock(passphrase);
    if (!result.ok) {
      ui.lockError.textContent = {
        weak: 'Passphrase must be at least 6 characters.',
        badpass: 'Incorrect passphrase.',
        corrupt: 'The vault file looks damaged.',
        missing: 'No vault file found yet.',
      }[result.code] || result.message || 'Could not unlock the vault.';
      ui.lockError.classList.remove('hidden');
      ui.passInput.select();
      return;
    }

    state = result.state;
    ui.passInput.value = '';
    ui.passConfirm.value = '';
    rows = await api.list();
    renderStatus();
    renderList();
    showScreen('history');
    ui.search.focus();
  } finally {
    ui.passSubmit.disabled = false;
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
  ui.search.focus();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.chip')) other.classList.remove('active');
    chip.classList.add('active');
    filter = chip.dataset.filter;
    // Slide the segmented indicator to the active tab.
    const index = FILTER_ORDER.indexOf(filter);
    el('seg').style.setProperty('--seg-index', String(index < 0 ? 0 : index));
    selectedId = null;
    renderList();
  });
}

ui.btnPause.addEventListener('click', async () => {
  await api.setPaused(!state.paused);
  await refresh();
});

ui.btnClear.addEventListener('click', () => clearAll());

ui.btnClose.addEventListener('click', () => api.hide());

ui.btnLock.addEventListener('click', async () => {
  await api.lock();
  await refresh();
  ui.passInput.focus();
});

/* --------------------------------------------------------------- settings */

function fillSettings() {
  const s = state.settings;
  el('setHotkey').value = s.hotkey;
  el('setShotHotkey').value = s.screenshotHotkey;
  el('setMax').value = s.maxEntries;
  el('setAutoLock').value = s.autoLockMinutes;
  el('setRetention').value = s.retentionHours;
  el('setDensity').value = s.density === 'compact' ? 'compact' : 'comfortable';
  el('setHideOnBlur').checked = s.hideOnBlur;
  el('setHideOnRestore').checked = s.hideOnRestore;
  el('setCaptureImages').checked = s.captureImages;
  el('setAutoSaveShots').checked = s.autoSaveScreenshots;
  // Reflect what the OS actually reports, not just what we asked for.
  el('setAutoStart').checked = Boolean(state.autoStartActive);
  el('autoStartNote').textContent = !state.packaged
    ? 'Dev build: the login entry points at the Electron binary with this project path, so it only works from this machine.'
    : 'ClipVault starts quietly in the tray when you sign in.';
  el('hotkeyStatus').textContent = state.hotkeyBound
    ? `Press ${s.hotkey} anywhere to toggle this panel.`
    : `⚠ ${s.hotkey} could not be registered - another app owns it.`;
  el('shotHotkeyStatus').textContent = state.screenshotHotkeyBound
    ? `Press ${s.screenshotHotkey} to freeze the screen and drag out a region.`
    : `⚠ ${s.screenshotHotkey} could not be registered - another app owns it.`;
}

ui.btnSettings.addEventListener('click', () => {
  fillSettings();
  showScreen('settings');
});

el('btnDone').addEventListener('click', async () => {
  await api.saveSettings({
    hotkey: el('setHotkey').value.trim() || 'Control+Shift+V',
    screenshotHotkey: el('setShotHotkey').value.trim() || 'Control+Shift+S',
    maxEntries: Math.max(20, Math.min(2000, Number(el('setMax').value) || 300)),
    autoLockMinutes: Math.max(0, Math.min(240, Number(el('setAutoLock').value) || 0)),
    retentionHours: Math.max(0, Math.min(8760, Number(el('setRetention').value) || 0)),
    density: el('setDensity').value === 'compact' ? 'compact' : 'comfortable',
    hideOnBlur: el('setHideOnBlur').checked,
    hideOnRestore: el('setHideOnRestore').checked,
    autoStart: el('setAutoStart').checked,
    captureImages: el('setCaptureImages').checked,
    autoSaveScreenshots: el('setAutoSaveShots').checked,
  });
  state = await api.status();
  applyDensity();
  showScreen('history');
  renderStatus();
  renderList();
});

el('btnShotNow').addEventListener('click', async () => {
  await api.hide();
  setTimeout(() => api.screenshot(), 180);
});

el('btnOpenShotDir').addEventListener('click', () => api.openScreenshotDir());

el('btnShot').addEventListener('click', async () => {
  await api.hide();
  setTimeout(() => api.screenshot(), 180);
});

el('btnChangePass').addEventListener('click', async () => {
  const current = el('passCurrent').value;
  const next = el('passNew').value;
  const message = el('settingsMessage');
  if (next !== el('passNew2').value) {
    message.textContent = 'The new passphrases do not match.';
    return;
  }
  try {
    const result = await api.changePassphrase(current, next);
    if (!result.ok) {
      message.textContent = {
        weak: 'New passphrase must be at least 6 characters.',
        badpass: 'Current passphrase is incorrect.',
        corrupt: 'The vault file looks damaged.',
      }[result.code] || result.message || 'Could not update the passphrase.';
      return;
    }
    message.textContent = '✓ Passphrase updated. Every entry was re-encrypted.';
    el('passCurrent').value = '';
    el('passNew').value = '';
    el('passNew2').value = '';
  } catch (err) {
    message.textContent = 'Could not update the passphrase.';
  }
});

el('btnReveal').addEventListener('click', () => api.revealVaultFile());

/* -------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    if (!ui.settingsScreen.classList.contains('hidden')) {
      showScreen('history');
      return;
    }
    api.hide();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    await api.lock();
    await refresh();
    return;
  }

  const onHistory = !ui.historyScreen.classList.contains('hidden');
  if (!onHistory) return;

  // While the search field has focus, typing must stay plain typing.
  const typing = document.activeElement === ui.search;

  const items = visibleRows();

  if (event.key === '/' && !typing) {
    event.preventDefault();
    ui.search.focus();
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!items.length) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const current = selectedIndex(items);
    const next = Math.max(0, Math.min(items.length - 1, (current === -1 ? -1 : current) + delta));
    selectedId = items[next].id;
    renderList();
    const node = ui.list.querySelector('.row.selected');
    if (node) node.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (typing) return;

  const currentRow = selectedIndex(items) >= 0 ? items[selectedIndex(items)] : null;

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
document.addEventListener('keydown', () => api.activity(), true);
document.addEventListener('mousedown', () => api.activity(), true);

/* ------------------------------------------------------------------ boot */

api.onState((next) => {
  state = next;
  renderStatus();
  applyDensity();
  if (state.locked) {
    showScreen('lock');
    renderLockScreen();
  }
});

api.onChanged(() => {
  if (state && !state.locked) {
    api.list().then((next) => {
      rows = next;
      renderList();
    });
  }
});

api.onShown(() => {
  refresh();
  if (state && !state.locked) ui.search.focus();
});

api.onToast((message) => toast(message));

refresh().then(() => {
  applyDensity();
  if (state && state.locked) ui.passInput.focus();
});