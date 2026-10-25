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

   Feel: waiting on you is amber and still, like a permission prompt (nothing
   pulses while the code waits to be confirmed). Linking landing is felt like a
   reply landing: the face is happy and KRYSTAL glows once. */

/* Last status we heard. Cached so the panel paints instantly when Settings
 * rebuilds it (it builds every tab on open to measure them). */
let accountStatus = { state: 'notLinked', linked: false, email: null, deviceName: null, code: null, problem: null };
let accountAsking = false;      // Unlink has been pressed once: "sure?"
let accountBusy = null;         // the action whose answer we're waiting on
let accountPanel = null;        // the panel on screen, if any
let accountChecking = null;     // the quiet check in flight, so re-renders don't re-ask

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
    html =
      `<div class="account-linked">` +
        `<span class="account-dot" aria-hidden="true"></span>` +
        `<span>${tr('account.linkedAs', {
          email: `<b>${escapeHtml(s.email || '')}</b>`,
          name: `<b>${escapeHtml(s.deviceName || '')}</b>`,
        })}</span>` +
      `</div>` +
      (v.ask ? `<div class="account-ask">${escapeHtml(tr('account.unlinkAsk'))}</div>` : '');
  } else if (v.problem) {
    html = `<div class="account-problem${ACCOUNT_SAID_DONE.includes(s.problem) ? ' said' : ''}">` +
      `${escapeHtml(tr(v.problem))}</div>`;
  }
  body.innerHTML = html;
  body.dataset.kind = v.kind;
  if (swap) replayClass(body, 'account-swap');

  acts.innerHTML = v.actions.map((a) =>
    `<button class="account-btn${a.tone ? ' ' + a.tone : ''}" type="button" data-act="${a.act}"` +
      `${accountBusy ? ' disabled' : ''}>` +
      `${escapeHtml(tr(accountBusy === a.act ? 'account.working.' + a.act : a.key))}</button>`).join('');
  acts.querySelectorAll('.account-btn').forEach((b) => { b.onclick = () => accountAct(b.dataset.act); });
}

/* Take a status from the backend and show it. Linking that just succeeded
 * lands the way a reply does. */
function accountApply(next) {
  if (!next || typeof next !== 'object') return;
  const was = accountStatus;
  accountStatus = next;
  if (next.state !== 'linked') accountAsking = false;
  if (was.state === 'linking' && next.state === 'linked') accountLanded();
  accountPaint(was.state !== next.state || was.problem !== next.problem);
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
 * then the check — and if the link was ended from app.krystal.rip while Krystal
 * was closed, say so once. */
async function accountBootCheck() {
  try { accountApply(await api.cloudStatus()); } catch (_) { return; }
  if (!accountStatus.linked) return;
  const s = await accountCheck();
  if (!s || s.problem !== 'unlinkedRemotely') return;
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

window.addEventListener('i18n:changed', () => accountPaint(false));
