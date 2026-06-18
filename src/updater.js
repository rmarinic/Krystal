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
  // No updater plugin (e.g. `cargo run` without it) → nothing to do.
  if (!updater || typeof updater.check !== 'function') return;

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
    // check() returns null when up to date. Some plugin versions instead return
    // an object with `available: false` — treat both as "nothing to do".
    if (!update || update.available === false) return;

    cache();
    if (!el.overlay) return;

    // ---- prompt state -----------------------------------------------------
    el.version.innerHTML = tr('update.version', {
      current: update.currentVersion || '?',
      version: update.version || '?',
    });
    renderNotes(update.body);
    el.progress.hidden = true;
    el.status.hidden = true;
    el.error.hidden = true;
    el.actions.hidden = false;
    el.overlay.hidden = false;

    el.later.onclick = () => { el.overlay.hidden = true; };
    el.now.onclick = () => { install(update); };
  }

  async function install(update) {
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

      // Download + install done — relaunch into the new version.
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
