/* phone.js      — phone access: run Krystal on the local network
   Part of the chat frontend; shares one global scope (see core.js).

   Krystal already has a whole backend; this feature just opens a door to it from
   the same Wi-Fi. The Rust side (src-tauri/src/server.rs) serves a compact touch
   UI and fronts the same commands this window calls, so a chat answered on the
   phone lands in the same database, on the same warm `claude` session, as one
   answered here.

   This file is only the switch and the pairing card: the address to type and the
   six-digit code to enter, plus Start/Stop. It lives in Settings → Phone, and the
   sidebar's Phone button is a shortcut straight to that tab. */

/* Last status we heard from the backend: { running, port, pin, host, url }.
 * Cached so re-rendering the panel (Settings measures every tab on open) paints
 * instantly instead of flashing empty while the round trip lands. */
let phoneStatus = { running: false };

const PHONE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="6" y="2" width="12" height="20" rx="3"/><line x1="10.5" y1="18" x2="13.5" y2="18"/></svg>';

/* Ask the backend where things stand and reflect it on the sidebar button. */
async function refreshPhoneStatus() {
  try { phoneStatus = await api.webStatus(); } catch (_) { /* keep the last known */ }
  syncPhoneBtn();
  return phoneStatus;
}

function showPhoneBtn(show) {
  if (!els.phoneBtn) return;
  els.phoneBtn.hidden = !show;
  if (show) refreshPhoneStatus();
}

/* The button wears a live dot while the server is up, so you can tell at a glance
 * that your machine is reachable without opening the panel. */
function syncPhoneBtn() {
  const btn = els.phoneBtn;
  if (!btn) return;
  btn.classList.toggle('live', !!phoneStatus.running);
  btn.title = tr(phoneStatus.running ? 'phone.btnTitleOn' : 'phone.btnTitle');
}

/* -------------------------------- panel ---------------------------------- */

/* Settings → Phone. Two states in one row: an explanation + Start, or the
 * pairing card (address, code) + Stop. */
function renderPhonePanel(panel) {
  panel.innerHTML =
    `<div class="settings-row col phone-row">` +
      `<div class="settings-text">` +
        `<div class="settings-name">${escapeHtml(tr('settings.phone.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('settings.phone.desc'))}</div>` +
      `</div>` +
      `<div class="phone-state" aria-live="polite"></div>` +
      `<div class="phone-actions">` +
        `<button class="phone-toggle" type="button"></button>` +
      `</div>` +
    `</div>`;

  const stateEl = panel.querySelector('.phone-state');
  const toggle = panel.querySelector('.phone-toggle');

  function paint() {
    fillPhoneState(stateEl);
    toggle.textContent = tr(phoneStatus.running ? 'phone.stop' : 'phone.start');
    toggle.classList.toggle('on', !!phoneStatus.running);
    toggle.disabled = false;
    syncPhoneBtn();
  }

  toggle.onclick = async () => {
    toggle.disabled = true;
    toggle.textContent = tr(phoneStatus.running ? 'phone.stopping' : 'phone.starting');
    try {
      phoneStatus = phoneStatus.running ? await api.webStop() : await api.webStart(null);
    } catch (err) {
      stateEl.innerHTML = `<div class="phone-err">${escapeHtml(String((err && err.message) || err))}</div>`;
      replayClass(stateEl, 'list-swap');
      toggle.disabled = false;
      toggle.textContent = tr('phone.start');
      return;
    }
    paint();
    replayClass(stateEl, 'list-swap');
  };

  paint();
  // The cached status may be stale (the panel can outlive a start/stop); confirm.
  // Settings builds every tab once to measure its height, so by the time this
  // lands the panel it was built for may already have been thrown away.
  refreshPhoneStatus().then(() => { if (panel.isConnected) paint(); });
}

/* The body of the panel — either the "what this does" blurb or the pairing card. */
function fillPhoneState(el) {
  if (!phoneStatus.running) {
    el.innerHTML = `<div class="phone-idle">${escapeHtml(tr('phone.idle'))}</div>`;
    return;
  }
  const url = phoneStatus.url || '';
  const address = url || tr('phone.noAddress');
  const digits = String(phoneStatus.pin || '').split('')
    .map((d) => `<span class="phone-digit">${escapeHtml(d)}</span>`).join('');

  el.innerHTML =
    `<div class="phone-card">` +
      `<div class="phone-step">` +
        `<div class="phone-step-n">1</div>` +
        `<div class="phone-step-body">` +
          `<div class="phone-step-label">${escapeHtml(tr('phone.step1'))}</div>` +
          `<div class="phone-url-row">` +
            `<code class="phone-url">${escapeHtml(address)}</code>` +
            (url ? `<button class="phone-copy" type="button" title="${escapeHtml(tr('phone.copy'))}">${escapeHtml(tr('phone.copy'))}</button>` : '') +
          `</div>` +
        `</div>` +
      `</div>` +
      `<div class="phone-step">` +
        `<div class="phone-step-n">2</div>` +
        `<div class="phone-step-body">` +
          `<div class="phone-step-label">${escapeHtml(tr('phone.step2'))}</div>` +
          `<div class="phone-pin">${digits}</div>` +
        `</div>` +
      `</div>` +
      `<div class="phone-note">${escapeHtml(tr('phone.note'))}</div>` +
    `</div>`;

  const copy = el.querySelector('.phone-copy');
  if (copy) {
    copy.onclick = async () => {
      if (!(await copyText(url))) return;
      copy.classList.add('copied');
      copy.textContent = tr('phone.copied');
      setTimeout(() => { copy.classList.remove('copied'); copy.textContent = tr('phone.copy'); }, 1400);
    };
  }
}

/* --------------------------- mirroring a turn ---------------------------- */
/* The phone and this window are two views of one app, so a turn started over
 * there has to show up here as it happens — not on the next time the chat is
 * reopened. The backend forwards the turn's events (see EV_TURN in server.rs),
 * and we replay them through the SAME live-turn machinery a message typed into
 * this window goes through: build the liveTurn `send()` would have built, then
 * hand every event to `handleLiveEvent`. Nothing downstream — the typewriter,
 * the Activity panel, the sidebar's live mark, the agent inspector — needs to
 * know the turn came from somewhere else. */

function remoteTurnStarted(threadId, text) {
  if (!threadId || state.live.has(threadId)) return;   // already streaming here
  const onScreen = threadId === state.activeId;
  const live = {
    threadId, userText: text || '', userFiles: [],
    events: [], outputs: {},
    // While the chat is on screen its activity list IS the panel's list (same
    // ref, as in `send()`); otherwise the turn collects into its own, which
    // `openThread` adopts if you switch to it mid-turn.
    activity: onScreen ? state.activity : [],
    typer: null, bubble: null, finalText: null, finalized: false,
    remote: true,
  };
  state.live.set(threadId, live);
  if (onScreen) {
    stickToBottom = true;              // watch it arrive, as if it were typed here
    appendMessage('user', live.userText, [], null);
    attachLiveTyper(live);
    scrollFeed();
  }
  syncComposer();                      // the send button becomes Stop
  if (state.view === 'threads') renderSidebar();
}

function remoteTurnEvent(threadId, raw) {
  const live = state.live.get(threadId);
  if (!live) return;                   // not a turn we're tracking
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  handleLiveEvent(live, msg);
}

listen('remote-turn-start', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnStarted(p.threadId, p.text);
});
listen('remote-turn', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnEvent(p.threadId, p.raw);
});
// A chat created on the phone should appear in the sidebar straight away.
listen('remote-threads-changed', (e) => {
  const p = e && e.payload;
  if (!p || !state.project || p.project !== state.project.path) return;
  if (state.view === 'threads') loadThreads();
});

/* ------------------------------- the button ------------------------------ */

if (els.phoneBtn) {
  els.phoneBtn.innerHTML =
    PHONE_ICON + `<span class="phone-label">${escapeHtml(tr('phone.label'))}</span>` +
    '<span class="phone-dot" aria-hidden="true"></span>';
  els.phoneBtn.onclick = () => openSettings('phone');
}

// Re-label on a language flip (the icon and the dot stay put).
window.addEventListener('i18n:changed', () => {
  const label = els.phoneBtn && els.phoneBtn.querySelector('.phone-label');
  if (label) label.textContent = tr('phone.label');
  syncPhoneBtn();
});
