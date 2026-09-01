/* remote.js     — reach this Krystal from elsewhere, and reach elsewhere from here
   Part of the chat frontend; shares one global scope (see core.js).

   Two halves of the same idea, because Krystal is both ends of it:

   HOSTING  — the switch in Settings → Remote (and the sidebar button) starts the
              LAN server in src-tauri/src/server.rs and shows the address and the
              six-digit pairing code. Anything on the network can then connect: a
              phone's browser gets the touch UI, another Krystal gets the command
              bridge. Also here: mirroring, so a turn someone starts over there
              paints in this window live.

   CONNECTING — the Remote button on the project screen pairs this window with
              another Krystal. From then on `core.js`'s `invoke` routes every
              backend call to that machine, so the whole app — projects, chats,
              the composer, tasks, git — is working on its files instead of ours.
              This file owns the pairing and the banner; core.js owns the wire. */

/* Last status we heard from OUR server: { running, port, pin, host, url }.
 * Cached so re-rendering the panel (Settings measures every tab on open) paints
 * instantly instead of flashing empty while the round trip lands. */
let remoteStatus = { running: false };

const REMOTE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

/* Ask our backend where hosting stands and reflect it on the sidebar button. */
async function refreshRemoteStatus() {
  try { remoteStatus = await api.remoteStatus(); } catch (_) { /* keep the last known */ }
  syncRemoteBtn();
  return remoteStatus;
}

function showRemoteBtn(show) {
  if (!els.remoteBtn) return;
  els.remoteBtn.hidden = !show;
  if (show) refreshRemoteStatus();
}

/* The button wears a live dot while our server is up, so you can tell at a
 * glance that this machine is reachable without opening the panel. */
function syncRemoteBtn() {
  const btn = els.remoteBtn;
  if (!btn) return;
  btn.classList.toggle('live', !!remoteStatus.running);
  btn.title = tr(remoteStatus.running ? 'remote.btnTitleOn' : 'remote.btnTitle');
}

/* ============================== hosting ================================== */

/* Settings → Remote. Two states in one row: an explanation + Start, or the
 * pairing card (address, code) + Stop. */
function renderRemotePanel(panel) {
  panel.innerHTML =
    `<div class="settings-row col remote-row">` +
      `<div class="settings-text">` +
        `<div class="settings-name">${escapeHtml(tr('settings.remote.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('settings.remote.desc'))}</div>` +
      `</div>` +
      `<div class="remote-state" aria-live="polite"></div>` +
      `<div class="remote-actions">` +
        `<button class="remote-toggle" type="button"></button>` +
      `</div>` +
    `</div>`;

  const stateEl = panel.querySelector('.remote-state');
  const toggle = panel.querySelector('.remote-toggle');

  function paint() {
    fillRemoteHostState(stateEl);
    toggle.textContent = tr(remoteStatus.running ? 'remote.stop' : 'remote.start');
    toggle.classList.toggle('on', !!remoteStatus.running);
    toggle.disabled = false;
    syncRemoteBtn();
  }

  toggle.onclick = async () => {
    toggle.disabled = true;
    toggle.textContent = tr(remoteStatus.running ? 'remote.stopping' : 'remote.starting');
    try {
      remoteStatus = remoteStatus.running ? await api.remoteStop() : await api.remoteStart(null);
    } catch (err) {
      stateEl.innerHTML = `<div class="remote-err">${escapeHtml(String((err && err.message) || err))}</div>`;
      replayClass(stateEl, 'list-swap');
      toggle.disabled = false;
      toggle.textContent = tr('remote.start');
      return;
    }
    paint();
    replayClass(stateEl, 'list-swap');
  };

  paint();
  // The cached status may be stale (the panel can outlive a start/stop); confirm.
  // Settings builds every tab once to measure its height, so by the time this
  // lands the panel it was built for may already have been thrown away.
  refreshRemoteStatus().then(() => { if (panel.isConnected) paint(); });
}

/* The body of the panel — either the "what this does" blurb or the pairing card. */
function fillRemoteHostState(el) {
  if (!remoteStatus.running) {
    el.innerHTML = `<div class="remote-idle">${escapeHtml(tr('remote.idle'))}</div>`;
    return;
  }
  const url = remoteStatus.url || '';
  const address = url || tr('remote.noAddress');
  const digits = String(remoteStatus.pin || '').split('')
    .map((d) => `<span class="remote-digit">${escapeHtml(d)}</span>`).join('');

  el.innerHTML =
    `<div class="remote-card">` +
      `<div class="remote-step">` +
        `<div class="remote-step-n">1</div>` +
        `<div class="remote-step-body">` +
          `<div class="remote-step-label">${escapeHtml(tr('remote.step1'))}</div>` +
          `<div class="remote-url-row">` +
            `<code class="remote-url">${escapeHtml(address)}</code>` +
            (url ? `<button class="remote-copy" type="button" title="${escapeHtml(tr('remote.copy'))}">${escapeHtml(tr('remote.copy'))}</button>` : '') +
          `</div>` +
        `</div>` +
      `</div>` +
      `<div class="remote-step">` +
        `<div class="remote-step-n">2</div>` +
        `<div class="remote-step-body">` +
          `<div class="remote-step-label">${escapeHtml(tr('remote.step2'))}</div>` +
          `<div class="remote-pin">${digits}</div>` +
        `</div>` +
      `</div>` +
      `<div class="remote-note">${escapeHtml(tr('remote.note'))}</div>` +
    `</div>`;

  const copy = el.querySelector('.remote-copy');
  if (copy) {
    copy.onclick = async () => {
      if (!(await copyText(url))) return;
      copy.classList.add('copied');
      copy.textContent = tr('remote.copied');
      setTimeout(() => { copy.classList.remove('copied'); copy.textContent = tr('remote.copy'); }, 1400);
    };
  }
}

/* --------------------------- mirroring a turn ---------------------------- */
/* A connected client and this window are two views of one app, so a turn started
 * over there has to show up here as it happens — not the next time the chat is
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

// These fire on OUR backend, so they describe someone driving this machine —
// never the machine this window may itself be connected to.
listen('remote-turn-start', (e) => {
  const p = e && e.payload;
  if (p && !remote.active) remoteTurnStarted(p.threadId, p.text);
});
listen('remote-turn', (e) => {
  const p = e && e.payload;
  if (p && !remote.active) remoteTurnEvent(p.threadId, p.raw);
});
// A chat created by a client should appear in the sidebar straight away.
listen('remote-threads-changed', (e) => {
  const p = e && e.payload;
  if (remote.active || !p || !state.project || p.project !== state.project.path) return;
  if (state.view === 'threads') loadThreads();
});

/* ============================= connecting ================================ */
/* The other half: point this whole window at another Krystal. */

const REMOTE_HOSTS_KEY = 'krystal.remote.hosts';

function recentHosts() {
  try { return JSON.parse(localStorage.getItem(REMOTE_HOSTS_KEY)) || []; }
  catch (_) { return []; }
}
function rememberHost(address) {
  const list = [address, ...recentHosts().filter((h) => h !== address)].slice(0, 5);
  try { localStorage.setItem(REMOTE_HOSTS_KEY, JSON.stringify(list)); } catch (_) {}
}
function forgetHost(address) {
  try {
    localStorage.setItem(REMOTE_HOSTS_KEY,
      JSON.stringify(recentHosts().filter((h) => h !== address)));
  } catch (_) {}
}

/* Turn whatever was typed into a base URL. People will paste the whole thing
 * from the host's panel, type a bare address, or forget the port — all three
 * should work. */
function normalizeHost(input) {
  let raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (!url.hostname) return null;
  if (!url.port) url.port = String(REMOTE_DEFAULT_PORT);
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

/* Pair with `base` using `pin`, and if it takes, switch the app over to it. */
async function connectRemote(base, pin) {
  const authRes = await fetch(base + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const auth = await authRes.json().catch(() => ({}));
  if (authRes.status === 429) throw new Error(tr('remote.errLocked'));
  if (!authRes.ok || !auth.token) {
    throw new Error(tr('remote.errBadCode', {
      n: auth.attemptsLeft != null ? auth.attemptsLeft : 0,
    }));
  }

  // Adopt the connection, then confirm it answers as a Krystal. If the greeting
  // fails we must put the transport back, or the app is left pointing at a
  // machine it can't talk to.
  remote.active = true;
  remote.base = base;
  remote.token = auth.token;
  remote.name = null;
  let hello;
  try {
    hello = await (await fetch(base + '/api/hello', {
      headers: { authorization: 'Bearer ' + auth.token },
    })).json();
  } catch (_) {
    clearRemote();
    throw new Error(tr('remote.errUnreachable'));
  }
  remote.name = (hello && hello.name) || base.replace(/^https?:\/\//, '');
  rememberHost(base);
  await enterRemote();
}

/* Drop the connection state without touching the UI. */
function clearRemote() {
  remote.active = false;
  remote.base = null;
  remote.token = null;
  remote.name = null;
}

/* Everything that has to happen when the transport changes: the projects, chats
 * and settings on screen all belong to the machine we were talking to. */
async function enterRemote() {
  syncRemoteBanner();
  closeOverlay(els.remoteOverlay);
  // The backend we're now talking to has never been told which language this
  // window is in, and it's the one that will be answering.
  api.setUiLanguage(window.I18N.getLang()).catch(() => {});
  api.setSuggestions(settingOn('promptSuggestions')).catch(() => {});
  // Leave whatever chat is open — it lives on the other machine now.
  state.project = null;
  state.activeId = null;
  await showProjectPicker();
}

async function disconnectRemote() {
  if (!remote.active) return;
  clearRemote();
  syncRemoteBanner();
  // Same again, the other way: our own backend has been idle through all this.
  api.setUiLanguage(window.I18N.getLang()).catch(() => {});
  state.project = null;
  state.activeId = null;
  await showProjectPicker();
}

/* Called by core.js when the far end stops accepting our token — it restarted,
 * or remote access was switched off over there. Fall back to local rather than
 * leaving every button quietly broken. */
function onRemoteLost() {
  if (!remote.active) return;
  const was = remote.name;
  clearRemote();
  syncRemoteBanner();
  showTip({
    key: 'status', cls: 'high', icon: '🔌', label: tr('remote.lostLabel'),
    body: escapeHtml(tr('remote.lostBody', { name: was || '' })),
  });
  showProjectPicker();
}

/* The bar across the top of the window while we're driving another machine. */
function syncRemoteBanner() {
  document.body.classList.toggle('is-remote', !!remote.active);
  if (els.remoteBarText) {
    els.remoteBarText.textContent = tr('remote.banner', { name: remote.name || '' });
  }
  if (els.remoteDisconnect) els.remoteDisconnect.textContent = tr('remote.disconnect');
  // Creating or moving a project needs a folder picker, which can only browse
  // THIS computer's disks — so those doors are shut while connected.
  if (els.newProjectBtn) els.newProjectBtn.hidden = !!remote.active;
}

/* True (with a tip) when an action can't work against another machine. The few
 * callers are the ones that open a native folder picker. */
function remoteBlocks(what) {
  if (!remote.active) return false;
  showTip({
    key: 'status', icon: '🖥', label: tr('remote.blockedLabel'),
    body: escapeHtml(tr('remote.blockedBody', { what: what || '' })),
  });
  return true;
}

/* ------------------------------ connect UI ------------------------------- */

function openRemoteConnect() {
  openOverlay(els.remoteOverlay);
  renderRemoteConnect();
}

function renderRemoteConnect(error) {
  const hosts = recentHosts();
  els.remoteBody.innerHTML =
    `<p class="remote-intro">${escapeHtml(tr('remote.intro'))}</p>` +
    `<label class="remote-field">` +
      `<span class="remote-label">${escapeHtml(tr('remote.addressLabel'))}</span>` +
      `<input class="remote-input" id="remote-address" type="text" spellcheck="false" ` +
        `placeholder="${escapeHtml(tr('remote.addressPlaceholder'))}" autocomplete="off">` +
    `</label>` +
    `<label class="remote-field">` +
      `<span class="remote-label">${escapeHtml(tr('remote.codeLabel'))}</span>` +
      `<input class="remote-input code" id="remote-code" type="text" inputmode="numeric" ` +
        `maxlength="6" placeholder="000000" autocomplete="off">` +
    `</label>` +
    (hosts.length
      ? `<div class="remote-recent">` +
          `<div class="remote-recent-head">${escapeHtml(tr('remote.recent'))}</div>` +
          hosts.map((h) =>
            `<div class="remote-recent-row">` +
              `<button class="remote-recent-pick" data-host="${escapeHtml(h)}">${escapeHtml(h)}</button>` +
              `<button class="remote-recent-x" data-host="${escapeHtml(h)}" ` +
                `title="${escapeHtml(tr('remote.forget'))}">×</button>` +
            `</div>`).join('') +
        `</div>`
      : '') +
    `<div class="remote-connect-err"${error ? '' : ' hidden'}>${escapeHtml(error || '')}</div>` +
    `<div class="remote-connect-actions">` +
      `<button class="init-act primary" id="remote-go">${escapeHtml(tr('remote.connect'))}</button>` +
    `</div>`;

  const addressEl = els.remoteBody.querySelector('#remote-address');
  const codeEl = els.remoteBody.querySelector('#remote-code');
  const goBtn = els.remoteBody.querySelector('#remote-go');
  if (hosts.length) addressEl.value = hosts[0];

  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.replace(/\D/g, '').slice(0, 6);
  });

  async function go() {
    const base = normalizeHost(addressEl.value);
    const pin = codeEl.value.replace(/\D/g, '');
    if (!base) return renderRemoteConnect(tr('remote.errAddress'));
    if (pin.length !== 6) return renderRemoteConnect(tr('remote.errCode'));
    goBtn.disabled = true;
    goBtn.textContent = tr('remote.connecting');
    try {
      await connectRemote(base, pin);
    } catch (err) {
      renderRemoteConnect(String((err && err.message) || err));
    }
  }

  goBtn.onclick = go;
  for (const el of [addressEl, codeEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  els.remoteBody.querySelectorAll('.remote-recent-pick').forEach((b) => {
    b.onclick = () => { addressEl.value = b.dataset.host; codeEl.focus(); };
  });
  els.remoteBody.querySelectorAll('.remote-recent-x').forEach((b) => {
    b.onclick = () => { forgetHost(b.dataset.host); renderRemoteConnect(); };
  });

  setTimeout(() => (hosts.length ? codeEl : addressEl).focus(), 60);
}

/* ------------------------------ the buttons ------------------------------ */

if (els.remoteBtn) {
  els.remoteBtn.innerHTML =
    REMOTE_ICON + `<span class="remote-label-text">${escapeHtml(tr('remote.label'))}</span>` +
    '<span class="remote-dot" aria-hidden="true"></span>';
  els.remoteBtn.onclick = () => openSettings('remote');
}
if (els.remoteConnectBtn) {
  els.remoteConnectBtn.innerHTML =
    REMOTE_ICON + `<span>${escapeHtml(tr('remote.connectBtn'))}</span>`;
  els.remoteConnectBtn.onclick = openRemoteConnect;
}
if (els.remoteClose) els.remoteClose.onclick = () => closeOverlay(els.remoteOverlay);
syncRemoteBanner();   // label the bar's button and start out plainly local
if (els.remoteDisconnect) els.remoteDisconnect.onclick = disconnectRemote;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.remoteOverlay && !els.remoteOverlay.hidden) {
    closeOverlay(els.remoteOverlay);
  }
});

// Re-label on a language flip (the icons and the dot stay put).
window.addEventListener('i18n:changed', () => {
  const label = els.remoteBtn && els.remoteBtn.querySelector('.remote-label-text');
  if (label) label.textContent = tr('remote.label');
  if (els.remoteConnectBtn) {
    els.remoteConnectBtn.innerHTML =
      REMOTE_ICON + `<span>${escapeHtml(tr('remote.connectBtn'))}</span>`;
    els.remoteConnectBtn.title = tr('remote.connectTitle');
  }
  syncRemoteBtn();
  syncRemoteBanner();
});
