/* pins.js       — pinned files: the quiet rail down the right edge of the chat
   Part of the chat frontend; shares one global scope (see core.js).

   A pin is a quick context check, not a file manager. The rail rests almost
   invisible so it never competes with the conversation, opens when the pointer
   comes near, and a click reads the file *fresh* into a light panel — the point
   being to see what a task list or brief says right now, mid-chat, without
   leaving the chat or asking Claude to read it back to you.

   Pins belong to the project, not the chat: the same files are there whichever
   conversation you're in. */

/* ------------------------------ rail state ------------------------------- */

let pins = [];
/* The pin whose file is on screen, so the viewer can refresh in place. */
let openPin = null;

/* File types worth pinning. Markdown is the point of the feature; the rest are
 * the plain-text neighbours you'd want to glance at the same way. */
const PIN_FILTERS = [
  { name: 'Text & markdown', extensions: ['md', 'markdown', 'txt', 'json', 'yml', 'yaml', 'toml', 'csv'] },
];

/* An icon per file kind — enough to tell pins apart at a glance while the rail
 * is closed and only the icons show. */
function pinIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return '📄';
  if (ext === 'json' || ext === 'yml' || ext === 'yaml' || ext === 'toml') return '⚙️';
  if (ext === 'csv') return '▦';
  return '📄';
}

/* ------------------------------- the rail -------------------------------- */

/* Rebuild the rail from `pins`. Hidden entirely when there's no project open;
 * with a project but no pins it stays mounted so the + is reachable. */
function renderPins() {
  const rail = els.pinRail;
  if (!rail) return;
  if (!state.project) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  rail.classList.toggle('empty', pins.length === 0);

  els.pinList.innerHTML = pins.map((p) => {
    const label = p.label || basename(p.path);
    return (
      `<li class="pin" data-id="${p.id}">` +
        `<button type="button" class="pin-open" title="${escapeHtml(p.path)}">` +
          `<span class="pin-ico">${pinIcon(label)}</span>` +
          `<span class="pin-name">${escapeHtml(label)}</span>` +
        `</button>` +
        `<button type="button" class="pin-x" data-i18n-title="pins.unpin" title="${escapeHtml(tr('pins.unpin'))}" aria-label="${escapeHtml(tr('pins.unpin'))}">×</button>` +
      `</li>`
    );
  }).join('');

  for (const li of els.pinList.querySelectorAll('.pin')) {
    const id = Number(li.dataset.id);
    const pin = pins.find((p) => p.id === id);
    if (!pin) continue;
    li.querySelector('.pin-open').onclick = () => openPinnedFile(pin);
    li.querySelector('.pin-x').onclick = (e) => { e.stopPropagation(); unpinFile(pin); };
  }
}

/* Load this project's pins. Called when a project is opened and after any change. */
async function refreshPins() {
  if (!state.project) { pins = []; renderPins(); return; }
  try {
    const r = await api.listPins(state.project.path);
    pins = (r && r.pins) || [];
  } catch { pins = []; }
  renderPins();
}

/* Pick one or more files and pin them. */
async function addPins() {
  if (!state.project) return;
  let picked;
  try {
    picked = await dialog.open({
      multiple: true,
      defaultPath: state.project.path || undefined,
      filters: PIN_FILTERS,
      title: tr('pins.dialogTitle'),
    });
  } catch (e) {
    return alert(tr('dialog.pickerError', { err: (e && e.message) || e }));
  }
  if (!picked) return;                                  // cancelled
  const paths = Array.isArray(picked) ? picked : [picked];
  for (const path of paths) {
    try {
      const r = await api.addPin(state.project.path, path);
      if (r && r.pins) pins = r.pins;
    } catch (e) {
      showTip({
        key: 'status',
        icon: '📌',
        label: tr('pins.addFailed'),
        body: String(basename(path)),
      });
    }
  }
  renderPins();
  // Draw the eye to the pin that just landed, then let the rail settle back.
  replayClass(els.pinRail, 'just-pinned', 1200);
}

async function unpinFile(pin) {
  if (!state.project) return;
  try {
    const r = await api.removePin(state.project.path, pin.id);
    if (r && r.pins) pins = r.pins;
  } catch {}
  if (openPin && openPin.id === pin.id) closePinView();
  renderPins();
}

/* ------------------------------ the viewer ------------------------------- */

/* Open (or refresh) the light panel showing a pinned file. Always re-reads from
 * disk: a pin is for checking what a file says *now*. */
async function openPinnedFile(pin) {
  openPin = pin;
  const label = pin.label || basename(pin.path);
  els.pinViewTitle.textContent = label;
  els.pinViewPath.textContent = pin.path;
  els.pinViewBody.innerHTML = `<div class="pin-view-loading">${escapeHtml(tr('pins.loading'))}</div>`;
  openOverlay(els.pinViewOverlay);

  let file;
  try {
    file = await api.readPinnedFile(pin.path);
  } catch (e) {
    els.pinViewBody.innerHTML = `<div class="pin-view-msg">${escapeHtml(String((e && e.message) || e))}</div>`;
    return;
  }
  // The user may have closed the panel (or opened another pin) while we read.
  if (!openPin || openPin.id !== pin.id) return;

  if (!file.exists) {
    els.pinViewBody.innerHTML =
      `<div class="pin-view-msg">${escapeHtml(tr('pins.missing'))}</div>`;
    return;
  }
  if (file.unreadable) {
    els.pinViewBody.innerHTML =
      `<div class="pin-view-msg">${escapeHtml(tr('pins.unreadable', { err: file.unreadable }))}</div>`;
    return;
  }
  const body = file.markdown
    ? `<div class="pin-md">${renderMarkdown(file.text || '')}</div>`
    : `<pre class="pin-raw">${escapeHtml(file.text || '')}</pre>`;
  const note = file.truncated
    ? `<div class="pin-view-note">${escapeHtml(tr('pins.truncated'))}</div>`
    : '';
  els.pinViewBody.innerHTML = body + note;
  els.pinViewBody.scrollTop = 0;
  if (typeof decorateCode === 'function') decorateCode(els.pinViewBody);
}

function closePinView() {
  openPin = null;
  closeOverlay(els.pinViewOverlay, () => { els.pinViewBody.innerHTML = ''; });
}

/* --------------------------------- wiring -------------------------------- */

if (els.pinAdd) els.pinAdd.onclick = addPins;
if (els.pinViewClose) els.pinViewClose.onclick = closePinView;
if (els.pinViewOverlay) {
  // Click the backdrop (not the panel) to dismiss.
  els.pinViewOverlay.addEventListener('mousedown', (e) => {
    if (e.target === els.pinViewOverlay) closePinView();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.pinViewOverlay && !els.pinViewOverlay.hidden) closePinView();
});

// Pin labels/titles are localized, so re-render them on a language switch.
window.addEventListener('i18n:changed', () => renderPins());
