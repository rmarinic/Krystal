/* titlebar.js   — Krystal's own window frame: minimize / maximize / close, and
                   dragging the window by its headers.
   Part of the chat frontend; shares one global scope (see core.js). Styles live
   in chat.css ("Window controls").

   The window has no Windows title bar (`decorations: false` in tauri.conf.json):
   the app's own headers are the title bar. The three controls sit at the end of
   the chat header's row, built like the header's own buttons, and empty header
   space moves the window — drag to move, double-click to maximize, drag it to a
   screen edge to snap.

   Outside Tauri (the screenshot harness, a plain browser) there is no window to
   drive, so nothing here does anything and the controls stay hidden. */

const tbWin = (() => {
  try {
    const w = window.__TAURI__ && window.__TAURI__.window;
    const cur = w && w.getCurrentWindow && w.getCurrentWindow();
    return cur && typeof cur.startDragging === 'function' ? cur : null;
  } catch (_) { return null; }
})();

/* Where a press on empty space moves the window. Overlays that cover the whole
 * window (the project picker, first-run, update) lend their top band. */
const TB_ZONES = '.chat-header, .sidebar-header, .remote-bar, .link-view-bar';
const TB_SCREENS = '.project-screen, .onb-overlay, .update-overlay';
const TB_SCREEN_BAND = 64;
/* …but never a press meant for something on it. The chat title is excluded
 * because double-clicking it renames the chat. */
const TB_INTERACTIVE = 'button, a, input, textarea, select, label, summary, [contenteditable="true"], ' +
  '[role="button"], [role="menu"], [role="menuitem"], .picker, .head-menu, #chat-title';

function tbDragTarget(e) {
  const t = e.target;
  if (!t || !t.closest || t.closest(TB_INTERACTIVE)) return false;
  if (t.closest(TB_ZONES)) return true;
  const screen = t.closest(TB_SCREENS);
  // A screen is a scroll container: its scrollbar is part of it, and must scroll.
  return !!screen && e.clientY < TB_SCREEN_BAND && e.clientX < screen.getBoundingClientRect().left + screen.clientWidth;
}

function tbSyncMax() {
  if (!tbWin || typeof tbWin.isMaximized !== 'function') return;
  tbWin.isMaximized().then((max) => {
    document.body.classList.toggle('win-max', !!max);
    const b = document.getElementById('wc-max');
    if (b) b.title = tr(max ? 'window.restore' : 'window.maximize');
  }).catch(() => {});
}

function tbLabel() {
  const set = (id, key) => {
    const b = document.getElementById(id);
    if (b) { b.title = tr(key); b.setAttribute('aria-label', tr(key)); }
  };
  set('wc-min', 'window.minimize');
  set('wc-close', 'window.close');
  tbSyncMax();
}

if (tbWin) {
  document.body.classList.add('framed');
  const bar = document.getElementById('win-controls');
  if (bar) bar.hidden = false;

  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  on('wc-min', () => tbWin.minimize());
  on('wc-max', () => tbWin.toggleMaximize());
  on('wc-close', () => tbWin.close());

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !tbDragTarget(e)) return;
    e.preventDefault();   // no text selection starting under a drag
    if (e.detail === 2) tbWin.toggleMaximize();
    else tbWin.startDragging();
  });

  // Maximized ↔ restored swaps the middle icon. Snapping, Win+↑ and the
  // double-click all end in a resize, so that is the one thing to watch.
  let maxT = 0;
  window.addEventListener('resize', () => { clearTimeout(maxT); maxT = setTimeout(tbSyncMax, 80); });
  // A window in the background lets its controls recede, as Windows' own do.
  window.addEventListener('blur', () => document.body.classList.add('win-inactive'));
  window.addEventListener('focus', () => document.body.classList.remove('win-inactive'));
  document.addEventListener('i18n:changed', tbLabel);
  tbLabel();
}

/* ---------------------------- taskbar progress ---------------------------- *
 * The taskbar button says what Krystal is doing while you're in another
 * window, in the app's own colours: a running turn (in any chat) shows Windows'
 * moving green bar; a turn stopped on a permission prompt turns it amber (a
 * paused bar) and holds it still; a turn that failed while you were away turns
 * it red until you come back. Nothing running, nothing shown — the button rests
 * like every other. Called whenever a turn starts, ends, or starts/stops
 * waiting on you. */
let taskbarShown = 'none';
let taskbarFailed = false;

function taskbarStatus() {
  let running = false, waiting = false;
  for (const live of state.live.values()) {
    running = true;
    if (live.permissions && live.permissions.length) waiting = true;
  }
  if (waiting) return 'paused';
  if (running) return 'indeterminate';
  return taskbarFailed ? 'error' : 'none';
}

function taskbarSync() {
  if (!tbWin || typeof tbWin.setProgressBar !== 'function') return;
  const status = taskbarStatus();
  if (status === taskbarShown) return;
  taskbarShown = status;
  // paused/error only draw with a value; a full bar reads as a state, not a percentage.
  const bar = status === 'paused' || status === 'error' ? { status, progress: 100 } : { status };
  tbWin.setProgressBar(bar).catch(() => {});
}

/* A turn failed. Worth a red button only if you weren't looking. */
function taskbarFailedTurn() {
  if (document.hasFocus()) return;
  taskbarFailed = true;
  taskbarSync();
}

if (tbWin) {
  window.addEventListener('focus', () => { if (taskbarFailed) { taskbarFailed = false; taskbarSync(); } });
}
