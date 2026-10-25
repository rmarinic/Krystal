/* account.js — Settings → Remote → Account: this computer and app.krystal.rip
   Part of the chat frontend; shares one global scope (see core.js).

   Linking puts this computer on your Krystal Cloud account, so you can see it
   at app.krystal.rip and, once the relay lands, reach it from anywhere. The
   whole flow runs in the backend (src-tauri/src/cloud/): it asks the cloud for a
   short code, opens the confirm page in the browser and waits for you there.
   This window only ever sees the link's status —
     { state: 'notLinked' | 'linking' | 'linked', linked, email, deviceName,
       code, problem }
   — never the device token, which stays in Windows Credential Manager.

   Once linked, "Reachable from krystal.rip" keeps one connection open from the
   backend (cloud/presence.rs) so the computer shows as online there. Its state
   arrives as { reachable, conn } on `cloud-presence`; conn is one of off,
   connecting, online, offline, elsewhere, update, failed.

   Feel: waiting on you is amber and still, like a permission prompt (nothing
   pulses while the code waits to be confirmed). Linking landing is felt like a
   reply landing: the face is happy and KRYSTAL glows once. The connection is a
   state, not an event, so its dot holds still: no heartbeat on a timer, though
   the socket pings every 30 s. It lights once when the cloud welcomes it (the
   connection landing), cools slowly when it drops, and is amber only when
   staying reachable needs you (another Krystal took over, an update). */

/* Last status we heard. Cached so the panel paints instantly when Settings
 * rebuilds it (it builds every tab on open to measure them). */
let accountStatus = { state: 'notLinked', linked: false, email: null, deviceName: null, code: null, problem: null };
let accountAsking = false;      // Unlink has been pressed once: "sure?"
let accountBusy = null;         // the action whose answer we're waiting on
let accountPanel = null;        // the panel on screen, if any
let accountChecking = null;     // the quiet check in flight, so re-renders don't re-ask
let accountPresence = { reachable: true, conn: 'off' };   // the live connection, last heard

/* Problems that came from the user's own choice (or happened elsewhere) say so,
 * and offer to link again rather than to "try again". */
const ACCOUNT_SAID_DONE = ['unlinkedRemotely', 'unlinkedHereOnly'];

/* What the panel shows for a status. Pure, tested in tests/account.test.js.
 * `asking`: the Unlink button was pressed once and wants a yes. */
function accountView(s, asking) {
  const st = s || {};
  if (st.state === 'linking') {
    return {
      kind: 'linking', code: st.code || '', problem: null,
      actions: [{ act: 'open', key: 'account.openAgain' }, { act: 'cancel', key: 'account.cancel' }],
    };
  }
  if (st.state === 'linked') {
    return asking
      ? { kind: 'linked', ask: true, problem: null,
          actions: [{ act: 'unlink', key: 'account.unlinkYes', tone: 'danger' }, { act: 'keep', key: 'account.keep' }] }
      : { kind: 'linked', ask: false, problem: null, actions: [{ act: 'ask', key: 'account.unlink' }] };
  }
  const problem = st.problem || null;
  let key = 'account.link';
  if (problem === 'expired') key = 'account.startAgain';
  else if (problem && !ACCOUNT_SAID_DONE.includes(problem)) key = 'account.retry';
  return {
    kind: 'idle', problem: problem ? 'account.problem.' + problem : null,
    actions: [{ act: 'start', key, tone: 'primary' }],
  };
}

/* What the connection line says, and the dot's tone: `on` (green, online),
 * `idle` (still grey: off, on its way, or out of reach and retrying by itself)
 * or `warn` (amber: staying reachable needs you). Pure, tested. */
const PRESENCE_TONE = {
  online: 'on', connecting: 'idle', offline: 'idle', off: 'idle',
  elsewhere: 'warn', update: 'warn', failed: 'warn',
};
function presenceView(p) {
  const st = p || {};
  if (!st.reachable) return { tone: 'idle', key: 'account.presence.off' };
  // Off while the switch is on is the instant before the first dial.
  const conn = PRESENCE_TONE[st.conn] && st.conn !== 'off' ? st.conn : 'connecting';
  return { tone: PRESENCE_TONE[conn], key: 'account.presence.' + conn };
}

/* ------------------------------- the panel -------------------------------- */

function renderAccountPanel(panel) {
  accountPanel = panel;
  accountAsking = false;
  panel.innerHTML =
    `<div class="settings-row col account-row">` +
      `<div class="settings-text">` +
        `<div class="settings-name">${escapeHtml(tr('account.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('account.desc'))}</div>` +
      `</div>` +
      `<div class="account-state" aria-live="polite"></div>` +
      `<div class="account-actions"></div>` +
    `</div>`;
  accountPaint(false);
  // Only when the Account tab is the one on screen: Settings also builds this
  // panel while measuring every tab, and that is no reason to call the cloud.
  if (settingsTab === 'remote') accountCheck();
}

/* Paint the cached status into the panel on screen. `swap` crossfades the body,
 * for a change of state; a repaint of the same state just redraws. */
function accountPaint(swap) {
  const panel = accountPanel;
  if (!panel || !panel.isConnected) return;
  const body = panel.querySelector('.account-state');
  const acts = panel.querySelector('.account-actions');
  if (!body || !acts) return;
  const v = accountView(accountStatus, accountAsking);
  const s = accountStatus;

  let html = '';
  if (v.kind === 'linking') {
    html =
      `<div class="account-wait">` +
        `<div class="account-code">${escapeHtml(v.code)}</div>` +
        `<div class="account-hint">${escapeHtml(tr('account.confirmThere'))}</div>` +
      `</div>`;
  } else if (v.kind === 'linked') {
    const p = presenceView(accountPresence);
    const on = !!accountPresence.reachable;
    html =
      `<div class="account-linked">` +
        `<span class="account-dot tone-${p.tone}" aria-hidden="true"></span>` +
        `<span>${tr('account.linkedAs', {
          email: `<b>${escapeHtml(s.email || '')}</b>`,
          name: `<b>${escapeHtml(s.deviceName || '')}</b>`,
        })}</span>` +
      `</div>` +
      `<div class="account-conn" data-key="${p.key}">${escapeHtml(tr(p.key))}</div>` +
      `<div class="account-reach">` +
        `<div class="settings-text">` +
          `<div class="settings-name">${escapeHtml(tr('account.reach.name'))}</div>` +
          `<div class="settings-desc">${escapeHtml(tr('account.reach.desc'))}</div>` +
        `</div>` +
        `<button class="settings-switch${on ? ' on' : ''}" type="button" role="switch" aria-checked="${on}" ` +
          `title="${escapeHtml(tr(on ? 'settings.on' : 'settings.off'))}"><span class="switch-knob"></span></button>` +
      `</div>` +
      (v.ask ? `<div class="account-ask">${escapeHtml(tr('account.unlinkAsk'))}</div>` : '');
  } else if (v.problem) {
    html = `<div class="account-problem${ACCOUNT_SAID_DONE.includes(s.problem) ? ' said' : ''}">` +
      `${escapeHtml(tr(v.problem))}</div>`;
  }
  body.innerHTML = html;
  body.dataset.kind = v.kind;
  if (swap) replayClass(body, 'account-swap');
  const sw = body.querySelector && body.querySelector('.settings-switch');
  if (sw) sw.onclick = () => accountReach(sw);

  acts.innerHTML = v.actions.map((a) =>
    `<button class="account-btn${a.tone ? ' ' + a.tone : ''}" type="button" data-act="${a.act}"` +
      `${accountBusy ? ' disabled' : ''}>` +
      `${escapeHtml(tr(accountBusy === a.act ? 'account.working.' + a.act : a.key))}</button>`).join('');
  acts.querySelectorAll('.account-btn').forEach((b) => { b.onclick = () => accountAct(b.dataset.act); });
}

/* Take a status from the backend and show it. Linking that just succeeded
 * lands the way a reply does; a link ended at app.krystal.rip (found by the
 * quiet check, or by the live connection being turned away) says so once. */
function accountApply(next) {
  if (!next || typeof next !== 'object') return;
  const was = accountStatus;
  accountStatus = next;
  if (next.state !== 'linked') accountAsking = false;
  if (was.state === 'linking' && next.state === 'linked') accountLanded();
  if (was.state === 'linked' && next.state === 'notLinked' && next.problem === 'unlinkedRemotely') accountGone();
  accountPaint(was.state !== next.state || was.problem !== next.problem);
}

/* ---------------------------- the live connection ------------------------- */

/* Take the connection's state and show it, in place: the line crossfades and
 * the dot changes tone; nothing else on the panel moves. Online after anything
 * else is the connection landing, so the dot lights once. */
function accountPresenceApply(next) {
  if (!next || typeof next !== 'object') return;
  const was = presenceView(accountPresence);
  accountPresence = next;
  const now = presenceView(next);
  const panel = accountPanel;
  const body = panel && panel.isConnected && panel.querySelector('.account-state');
  const line = body && body.querySelector && body.querySelector('.account-conn');
  if (!line) return;   // not linked, or no panel on screen: the next paint has it
  const dot = body.querySelector('.account-dot');
  if (dot) {
    dot.className = 'account-dot tone-' + now.tone;
    if (now.tone === 'on' && was.tone !== 'on' && motionOK()) replayClass(dot, 'land');
  }
  if (line.dataset.key !== now.key) {
    line.dataset.key = now.key;
    line.textContent = tr(now.key);
    replayClass(line, 'account-swap');
  }
  const sw = body.querySelector('.settings-switch');
  if (sw) accountSwitchShow(sw, !!next.reachable);
}

function accountSwitchShow(sw, on) {
  sw.classList.toggle('on', on);
  sw.setAttribute('aria-checked', String(on));
  sw.title = tr(on ? 'settings.on' : 'settings.off');
}

/* The switch answers at once (the knob slides); the backend remembers it and
 * opens or closes the connection, and its answer settles the line. */
async function accountReach(sw) {
  const next = !accountPresence.reachable;
  accountSwitchShow(sw, next);
  let p = null;
  try { p = await api.cloudSetReachable(next); } catch (_) { p = { ...accountPresence }; }
  accountPresenceApply(p);
}

async function accountAct(act) {
  if (accountBusy) return;
  if (act === 'open') { api.cloudLinkOpen().catch(() => {}); return; }
  if (act === 'ask' || act === 'keep') {
    accountAsking = act === 'ask';
    accountPaint(true);
    return;
  }
  const call = { start: api.cloudLinkStart, cancel: api.cloudLinkCancel, unlink: api.cloudUnlink }[act];
  if (!call) return;
  accountBusy = act;
  accountPaint(false);              // the pressed button says what it's doing, at once
  let next = null;
  try { next = await call(); } catch (_) { next = { ...accountStatus, problem: 'failed' }; }
  accountBusy = null;
  accountAsking = false;
  accountApply(next);               // repaints, buttons included
}

/* The face is happy and KRYSTAL glows once — the same as a reply landing. The
 * sidebar's wordmark is the one mascotTurnEnded lights; on the project screen
 * it's hidden, so light the one that's showing. */
function accountLanded() {
  if (typeof mascotTurnEnded === 'function') mascotTurnEnded(null);
  const side = document.querySelector('aside.sidebar .logo');
  if (side && side.offsetParent) return;
  const shown = [...document.querySelectorAll('.logo')].find((l) => l.offsetParent);
  if (shown && typeof logoWave === 'function' && motionOK() && document.body.classList.contains('fx-on')) {
    logoWave(shown);
  }
}

/* --------------------------- the quiet check ----------------------------- */

/* Ask the cloud whether the link still holds (GET /api/device, in the backend).
 * Says nothing unless it was unlinked from the dashboard. */
function accountCheck() {
  if (accountChecking) return accountChecking;
  accountChecking = api.cloudCheck()
    .then((s) => { accountApply(s); return s; })
    .catch(() => accountStatus)
    .finally(() => { accountChecking = null; });
  return accountChecking;
}

/* On launch: the status first (so the panel is right however soon it opens),
 * then the check, which says so (through accountApply) if the link was ended
 * from app.krystal.rip while Krystal was closed. */
async function accountBootCheck() {
  try { accountApply(await api.cloudStatus()); } catch (_) { return; }
  api.cloudPresence().then(accountPresenceApply).catch(() => {});
  if (!accountStatus.linked) return;
  await accountCheck();
}

/* The link was ended at app.krystal.rip. Raised once, as a notice, unless the
 * Account panel is on screen, where the panel already says it. */
function accountGone() {
  const overlay = typeof els === 'object' && els ? els.settingsOverlay : null;
  const onScreen = accountPanel && accountPanel.isConnected && settingsTab === 'remote' &&
    !(overlay && overlay.hidden);
  if (onScreen) return;
  const text = tr('account.problem.unlinkedRemotely');
  const shown = typeof showNotice === 'function' && showNotice({
    id: 'account-unlinked', tone: 'warn', icon: '!',
    kind: tr('account.name'), html: escapeHtml(text), where: tr('account.open'),
    run: () => openSettings('remote'),
  });
  if (!shown) showTip({ key: 'account', icon: 'plug', label: tr('account.name'), body: escapeHtml(text) });
}

// A poll landing, or a check finding the link gone, while nobody asked.
listen('cloud-link', (e) => accountApply(e && e.payload));
// The live connection changing: dialling, welcomed, dropped, turned away.
listen('cloud-presence', (e) => accountPresenceApply(e && e.payload));

window.addEventListener('i18n:changed', () => accountPaint(false));
