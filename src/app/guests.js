/* guests.js — Settings → Remote: what people you share this computer with may do
   Part of the chat frontend; shares one global scope (see core.js).

   A computer linked to app.krystal.rip can be shared with other accounts there.
   What they can do on it is decided here, by the owner, at the computer itself:
   the backend keeps the choice (remote/guests.rs) and holds every request from
   a guest to it (remote/access.rs). You, signed in as yourself, can always do
   everything; none of this applies to you.

     { modes: ['ask', 'plan'],   the chat modes a guest's turn may run in
       approve: false,           may they answer their own permission prompts
       commands: false,          the $ shell, the RUN button, git's changes
       allFiles: false }         anywhere on this computer, or only projects

   A chat set to a mode they may not use runs their turn in the nearest allowed
   one that does less; with no mode at all they can read chats but not send.

   Feel: a choice answers at once (the chip lights, the knob slides) and the
   backend's answer settles it; nothing else on the panel moves. */

/* The last choice we heard, so the panel paints at once when Settings rebuilds
 * it (it builds every tab on open to measure them). */
let guestAccess = null;
let guestPanel = null;
let guestLoading = null;

/* Most able first, the backend's `models::MODES` order. */
const GUEST_MODES = ['auto', 'guarded', 'edits', 'ask', 'plan'];
const GUEST_SWITCHES = ['approve', 'commands', 'allFiles'];

/* The choice after one change: `{ mode }` turns a mode on or off (kept in
 * GUEST_MODES order), `{ key }` flips a switch. Pure, tested. */
function guestAccessWith(a, change) {
  const cur = a || {};
  const next = { ...cur, modes: Array.isArray(cur.modes) ? [...cur.modes] : [] };
  if (change.mode) {
    const on = next.modes.includes(change.mode);
    const set = new Set(on ? next.modes.filter((m) => m !== change.mode) : [...next.modes, change.mode]);
    next.modes = GUEST_MODES.filter((m) => set.has(m));
  } else if (GUEST_SWITCHES.includes(change.key)) {
    next[change.key] = !cur[change.key];
  }
  return next;
}

/* The line under the modes: what that choice means for a guest's chats. Pure. */
function guestModesNote(modes) {
  const m = Array.isArray(modes) ? modes : [];
  if (!m.length) return 'guests.modes.none';
  return m.includes('auto') ? 'guests.modes.full' : 'guests.modes.capped';
}

/* Below the account row of Settings → Remote (settings.js calls this after
 * renderAccountPanel). */
function renderGuestsPanel(panel) {
  const row = document.createElement('div');
  row.className = 'settings-row col guests-row';
  row.innerHTML =
    `<div class="settings-text">` +
      `<div class="settings-name">${escapeHtml(tr('guests.name'))}</div>` +
      `<div class="settings-desc">${escapeHtml(tr('guests.desc'))}</div>` +
    `</div>` +
    `<div class="guests-body"></div>`;
  panel.appendChild(row);
  guestPanel = row;
  guestPaint();
  if (!guestAccess && !guestLoading) {
    guestLoading = api.getGuestAccess()
      .then((a) => { guestAccess = a; guestPaint(); })
      .catch(() => {})
      .finally(() => { guestLoading = null; });
  }
}

function guestPaint() {
  const body = guestPanel && guestPanel.isConnected && guestPanel.querySelector('.guests-body');
  if (!body) return;
  if (!guestAccess) { body.innerHTML = ''; return; }
  const a = guestAccess;
  const chips = GUEST_MODES.map((m) => {
    const on = a.modes.includes(m);
    return `<button class="guest-mode${on ? ' on' : ''}" type="button" data-mode="${m}" aria-pressed="${on}" ` +
      `title="${escapeHtml(tr('mode.' + m + '.blurb'))}">${escapeHtml(tr('mode.' + m + '.name'))}</button>`;
  }).join('');
  const switches = GUEST_SWITCHES.map((k) =>
    `<div class="guest-switch-row">` +
      `<div class="settings-text">` +
        `<div class="guest-switch-name">${escapeHtml(tr('guests.' + k + '.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('guests.' + k + '.desc'))}</div>` +
      `</div>` +
      `<button class="settings-switch${a[k] ? ' on' : ''}" type="button" role="switch" data-key="${k}" ` +
        `aria-checked="${!!a[k]}" title="${escapeHtml(tr(a[k] ? 'settings.on' : 'settings.off'))}">` +
        `<span class="switch-knob"></span></button>` +
    `</div>`).join('');
  body.innerHTML =
    `<div class="guest-modes">` +
      `<div class="guest-switch-name">${escapeHtml(tr('guests.modes.name'))}</div>` +
      `<div class="guest-chips">${chips}</div>` +
      `<div class="guest-note">${escapeHtml(tr(guestModesNote(a.modes)))}</div>` +
    `</div>` + switches;
  body.querySelectorAll('.guest-mode').forEach((b) => { b.onclick = () => guestChange({ mode: b.dataset.mode }); });
  body.querySelectorAll('.settings-switch').forEach((b) => { b.onclick = () => guestChange({ key: b.dataset.key }); });
}

/* Show the change at once, then keep what the backend kept. A save that fails
 * puts the last saved choice back, so the panel never claims what isn't so. */
async function guestChange(change) {
  if (!guestAccess) return;
  const was = guestAccess;
  guestAccess = guestAccessWith(was, change);
  guestShow(change);
  try {
    guestAccess = await api.setGuestAccess(guestAccess);
  } catch (_) {
    guestAccess = was;
  }
  guestShow(change);
}

/* Update the controls in place: the chip, the switch and the note, nothing
 * rebuilt, so the switch's knob slides instead of jumping. */
function guestShow(change) {
  const body = guestPanel && guestPanel.isConnected && guestPanel.querySelector('.guests-body');
  if (!body || !guestAccess) return;
  const a = guestAccess;
  body.querySelectorAll('.guest-mode').forEach((b) => {
    const on = a.modes.includes(b.dataset.mode);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  body.querySelectorAll('.settings-switch').forEach((b) => {
    const on = !!a[b.dataset.key];
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.title = tr(on ? 'settings.on' : 'settings.off');
  });
  const note = body.querySelector('.guest-note');
  const key = guestModesNote(a.modes);
  if (note && note.dataset.key !== key) {
    note.dataset.key = key;
    note.textContent = tr(key);
    if (change && change.mode) replayClass(note, 'guest-swap');
  }
}
