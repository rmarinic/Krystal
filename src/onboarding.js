/* onboarding.js — first-run readiness flow for the Tauri build.
 *
 * On launch it asks the backend (preflight) whether Claude Code is installed and
 * the user is signed in. If anything's missing it shows the #onb-overlay and
 * walks the user through it:  install → sign in → ready. The install streams
 * live log lines over a Channel; sign-in opens Claude's own login in a terminal
 * and we re-check. Everything is best-effort: if preflight can't run we stay out
 * of the way and let the app start.
 *
 * Wrapped in an IIFE so it never collides with app.js's global `invoke`.
 */
(function () {
  const core = (window.__TAURI__ && window.__TAURI__.core) || null;
  if (!core || typeof core.invoke !== 'function') return;
  const invoke = core.invoke;
  const Channel = core.Channel;
  const tr = (k, v, fb) => (window.I18N ? window.I18N.t(k, v, fb) : (fb || k));

  const $ = (id) => document.getElementById(id);
  let el = {};
  function cache() {
    el = {
      overlay: $('onb-overlay'),
      title: $('onb-title'),
      body: $('onb-body'),
      log: $('onb-log'),
      status: $('onb-status'),
      statusText: $('onb-status-text'),
      actions: $('onb-actions'),
      error: $('onb-error'),
    };
  }

  const show = () => { el.overlay.hidden = false; };
  const hide = () => { el.overlay.hidden = true; };

  function setStatus(text) {
    if (!text) { el.status.hidden = true; return; }
    el.statusText.textContent = text;
    el.status.hidden = false;
  }
  function setError(text) {
    if (!text) { el.error.hidden = true; return; }
    el.error.textContent = text;
    el.error.hidden = false;
  }
  const clearActions = () => { el.actions.innerHTML = ''; };

  function addBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = 'onb-btn ' + cls;
    b.textContent = label;
    b.onclick = onClick;
    el.actions.appendChild(b);
    return b;
  }
  // Escape hatch so a false "not installed/signed-in" can never trap the user.
  const addSkip = () => addBtn(tr('onb.skip'), 'link', hide);

  function appendLog(line) {
    el.log.hidden = false;
    const span = document.createElement('span');
    span.className = 'ln';
    span.textContent = line;
    el.log.appendChild(span);
    el.log.scrollTop = el.log.scrollHeight;
  }

  /* ------------------------------- states -------------------------------- */

  function showInstall() {
    el.title.textContent = tr('onb.install.title');
    el.body.innerHTML = tr('onb.install.body');
    el.log.hidden = true; el.log.innerHTML = '';
    setStatus(null); setError(null); clearActions();
    addBtn(tr('onb.install.btn'), 'primary', doInstall);
    addSkip();
  }

  async function doInstall() {
    clearActions(); setError(null);
    setStatus(tr('onb.install.working'));
    el.log.hidden = false; el.log.innerHTML = '';
    const channel = new Channel();
    channel.onmessage = (msg) => { if (msg && msg.type === 'log') appendLog(msg.line); };
    try {
      const pf = await invoke('install_claude', { onEvent: channel });
      setStatus(null);
      if (!pf || !pf.installed) throw new Error(tr('onb.install.retry'));
      if (pf.authenticated) showReady();
      else showLogin();
    } catch (err) {
      setStatus(null);
      setError(tr('onb.install.failed', { err: String((err && err.message) || err) }));
      clearActions();
      addBtn(tr('onb.install.retry'), 'primary', doInstall);
      addSkip();
    }
  }

  function showLogin() {
    el.title.textContent = tr('onb.login.title');
    el.body.textContent = tr('onb.login.body');
    el.log.hidden = true;
    setStatus(null); setError(null); clearActions();
    addBtn(tr('onb.login.btn'), 'primary', async () => {
      setError(null);
      try {
        await invoke('open_login');
        el.body.textContent = tr('onb.login.opened');
      } catch (err) {
        setError(tr('onb.error.generic', { err: String((err && err.message) || err) }));
      }
    });
    addBtn(tr('onb.login.recheck'), 'ghost', recheckLogin);
    addSkip();
  }

  async function recheckLogin() {
    setError(null);
    setStatus(tr('onb.login.checking'));
    try {
      const pf = await invoke('preflight');
      setStatus(null);
      if (pf && pf.authenticated) showReady();
      else setError(tr('onb.login.notyet'));
    } catch (err) {
      setStatus(null);
      setError(tr('onb.error.generic', { err: String((err && err.message) || err) }));
    }
  }

  function showReady() {
    el.title.textContent = tr('onb.ready.title');
    el.body.textContent = tr('onb.ready.body');
    el.log.hidden = true;
    setStatus(null); setError(null); clearActions();
    setTimeout(hide, 1500);
  }

  /* -------------------------------- boot --------------------------------- */

  // Dev/QA preview: force a screen without needing a machine that lacks Claude.
  //   location hash  #onb=install | #onb=login | #onb=ready
  //   or localStorage 'krystal.onb.force' = one of the same values
  function forcedState() {
    const m = (location.hash || '').match(/onb=(install|login|ready)/);
    if (m) return m[1];
    try { return localStorage.getItem('krystal.onb.force'); } catch (_) { return null; }
  }

  async function run() {
    cache();
    if (!el.overlay) return;

    const forced = forcedState();
    if (forced) {
      show();
      if (forced === 'install') showInstall();
      else if (forced === 'login') showLogin();
      else if (forced === 'ready') showReady();
      return;
    }

    let pf;
    try {
      pf = await invoke('preflight');
    } catch (_) {
      return;               // backend not ready — don't block startup
    }
    if (pf && pf.installed && pf.authenticated) return;   // all good, no overlay
    show();
    if (!pf || !pf.installed) showInstall();
    else showLogin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
