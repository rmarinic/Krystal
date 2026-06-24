/* updater.js — self-update flow for the Tauri build.
 *
 * On launch this asks GitHub Releases (via the Tauri updater plugin) whether a
 * newer signed build exists. If so it shows the #update-overlay and — only
 * after the user clicks "Install now" — downloads the update with a real
 * progress bar, then relaunches into the new version.
 *
 * Everything is best-effort and silent on failure: no network, no plugin, or a
 * malformed manifest simply means "no update" and the app starts normally.
 *
 * Globals come from `withGlobalTauri: true`:
 *   window.__TAURI__.updater.check()   → Update | null
 *   window.__TAURI__.process.relaunch()
 */
(function () {
  const tauri = window.__TAURI__ || {};
  const updater = tauri.updater;
  const process = tauri.process;
  const core = tauri.core;
  // No updater plugin (e.g. `cargo run` without it) → nothing to do.
  if (!updater || typeof updater.check !== 'function') return;

  const RELEASES_URL = 'https://github.com/rmarinic/Krystal/releases/latest';

  /* Loop-breaker memory. The Tauri/NSIS updater installs to its own fixed
   * location; if the app is launched from somewhere else (a custom/portable
   * folder, a stale copy on another drive, a failed-elevation install), the
   * installed binary is never the one being run, so check() keeps re-offering the
   * same version on every launch and the install never "sticks". We record which
   * version we just installed, keyed by THIS exe's path (localStorage is shared
   * across copies because the WebView2 data dir is identifier-based, so the key
   * must disambiguate which copy is running). If the same exe launches again and
   * is STILL behind, we know its updates aren't applying and show a manual-install
   * notice instead of silently re-installing forever. */
  const PENDING_KEY = 'krystal.update.pending';   // { [exePath]: { version, at } }
  const readMap = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; } catch (_) { return {}; } };
  const writeMap = (m) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(m)); } catch (_) {} };
  async function exePath() {
    try { return (core && typeof core.invoke === 'function') ? (await core.invoke('exe_path')) || '' : ''; }
    catch (_) { return ''; }
  }

  const tr = (key, vars, fb) =>
    (window.I18N ? window.I18N.t(key, vars, fb) : (fb || key));

  const $ = (id) => document.getElementById(id);
  const el = {};
  function cache() {
    el.overlay   = $('update-overlay');
    el.title     = $('update-title');
    el.version   = $('update-version');
    el.notes     = $('update-notes');
    el.progress  = $('update-progress');
    el.fill      = $('update-bar-fill');
    el.progLabel = $('update-progress-label');
    el.status    = $('update-status');
    el.actions   = $('update-actions');
    el.now       = $('update-now');
    el.later     = $('update-later');
    el.error     = $('update-error');
  }

  const mb = (bytes) => (bytes / 1048576).toFixed(1);

  function renderNotes(body) {
    if (!body || !body.trim()) { el.notes.hidden = true; return; }
    let html;
    try {
      if (window.marked && window.DOMPurify) {
        html = window.DOMPurify.sanitize(window.marked.parse(body));
      } else {
        html = body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
                   .replace(/\n/g, '<br>');
      }
    } catch (_) {
      html = '';
    }
    if (!html) { el.notes.hidden = true; return; }
    el.notes.innerHTML = `<strong>${tr('update.whatsNew')}</strong><br>${html}`;
    el.notes.hidden = false;
  }

  async function run() {
    let update;
    try {
      update = await updater.check();
    } catch (_) {
      return;                 // offline / endpoint unreachable / bad manifest
    }

    const me = await exePath();

    // check() returns null when up to date. Some plugin versions instead return
    // an object with `available: false` — treat both as "nothing to do".
    if (!update || update.available === false) {
      // This copy is current — clear any stuck record we kept for it.
      if (me) { const m = readMap(); if (m[me]) { delete m[me]; writeMap(m); } }
      return;
    }

    cache();
    if (!el.overlay) return;

    const cur = update.currentVersion || '?';
    const next = update.version || '?';

    // Loop-breaker: we already installed `next` from this exe on a prior launch,
    // yet it's still reporting an older version — the install isn't reaching the
    // copy we run. Don't re-install (it would loop); explain it instead.
    const m = readMap();
    if (me && m[me] && m[me].version === next && cur !== next) {
      showStuck(cur, next);
      return;
    }

    // ---- prompt state -----------------------------------------------------
    el.version.innerHTML = tr('update.version', { current: cur, version: next });
    el.title.textContent = tr('update.title');
    el.now.textContent = tr('update.install');
    renderNotes(update.body);
    el.progress.hidden = true;
    el.status.hidden = true;
    el.error.hidden = true;
    el.actions.hidden = false;
    el.overlay.hidden = false;

    el.later.onclick = () => { el.overlay.hidden = true; };
    el.now.onclick = () => { install(update, me); };
  }

  /* The update downloaded and installed but the running copy never changed —
   * re-installing would just loop. Tell the user plainly and point them at the
   * installer so one manual run puts them on a properly-managed copy. */
  function showStuck(cur, next) {
    el.title.textContent = tr('update.stuckTitle');
    el.version.innerHTML = tr('update.version', { current: cur, version: next });
    el.notes.textContent = tr('update.stuckBody', { current: cur, version: next });
    el.notes.hidden = false;
    el.progress.hidden = true;
    el.status.hidden = true;
    el.error.hidden = true;
    el.actions.hidden = false;
    el.now.textContent = tr('update.download');
    el.later.textContent = tr('update.later');
    el.now.onclick = () => {
      try { if (core && typeof core.invoke === 'function') core.invoke('open_external', { url: RELEASES_URL }); } catch (_) {}
    };
    el.later.onclick = () => { el.overlay.hidden = true; };
    el.overlay.hidden = false;
  }

  async function install(update, me) {
    // ---- downloading state ----
    el.actions.hidden = true;
    el.error.hidden = true;
    el.progress.hidden = false;
    el.status.hidden = false;
    el.status.textContent = tr('update.downloading');
    el.fill.classList.add('indeterminate');
    el.progLabel.textContent = tr('update.preparing');

    let total = 0;
    let done = 0;

    try {
      await update.downloadAndInstall((ev) => {
        switch (ev.event) {
          case 'Started':
            total = (ev.data && ev.data.contentLength) || 0;
            done = 0;
            break;
          case 'Progress':
            done += (ev.data && ev.data.chunkLength) || 0;
            if (total > 0) {
              el.fill.classList.remove('indeterminate');
              const pct = Math.min(100, Math.round((done / total) * 100));
              el.fill.style.width = pct + '%';
              el.progLabel.textContent = tr('update.progress', {
                done: mb(done), total: mb(total), pct,
              });
            } else {
              el.progLabel.textContent = tr('update.progressNoTotal', { done: mb(done) });
            }
            break;
          case 'Finished':
            el.fill.classList.remove('indeterminate');
            el.fill.style.width = '100%';
            // The plugin now applies the installer; we can't cancel past here.
            el.status.textContent = tr('update.installing');
            el.progLabel.textContent = '';
            break;
        }
      });

      // Download + install done — remember what we just applied for THIS copy, so
      // if the next launch is still behind we detect the stuck loop (see run()).
      if (me) { const m = readMap(); m[me] = { version: update.version, at: Date.now() }; writeMap(m); }

      // relaunch into the new version.
      el.status.textContent = tr('update.restarting');
      if (process && typeof process.relaunch === 'function') {
        await process.relaunch();
      }
    } catch (err) {
      // Surface the failure and let her dismiss / retry.
      el.progress.hidden = true;
      el.status.hidden = true;
      el.fill.classList.remove('indeterminate');
      el.error.textContent = tr('update.failed', { err: String(err && err.message || err) });
      el.error.hidden = false;
      el.actions.hidden = false;
    }
  }

  // Kick off once the DOM (and i18n) are ready. The overlay floats above the
  // app, so we never block normal startup — the picker loads underneath.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
