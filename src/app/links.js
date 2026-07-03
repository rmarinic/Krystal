/* links.js      — intercept reply links; open in browser, ask, or in-app viewer
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ opening links ---------------------------- */
/* Links inside replies must never navigate the top window (that used to trap
 * the user with no way back). Every click is intercepted and routed by the
 * `linkOpen` setting: ask each time, always the default browser, or an in-app
 * viewer with a clearly-visible Back button. */

function isOpenableHref(href) {
  return /^https?:\/\//i.test(href);
}

function openExternalUrl(url) {
  api.openExternal(url).catch((e) => {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('link.failLabel'),
      body: escapeHtml(String((e && e.message) || e)) });
  });
}

function handleLinkClick(href) {
  const mode = settingVal('linkOpen') || 'ask';
  if (mode === 'browser') openExternalUrl(href);
  else if (mode === 'app') openLinkInApp(href);
  else askOpenLink(href);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!isOpenableHref(href)) return;     // ignore in-page anchors / non-web schemes
  e.preventDefault();
  handleLinkClick(href);
});

/* "Ask each time" dialog: browser vs in-app, with an optional "always do this"
 * that writes the choice back to settings. */
function askOpenLink(href) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay link-ask';
  overlay.innerHTML =
    `<div class="init-modal link-ask-modal" role="dialog" aria-modal="true">` +
      `<header class="init-head"><div class="init-title">🔗 ${escapeHtml(tr('link.askTitle'))}</div></header>` +
      `<div class="init-body">` +
        `<div class="link-url">${escapeHtml(href)}</div>` +
        `<label class="link-remember"><input type="checkbox" class="link-remember-cb"> ${escapeHtml(tr('link.remember'))}</label>` +
      `</div>` +
      `<footer class="init-foot">` +
        `<button class="init-act ghost" data-act="cancel">${escapeHtml(tr('link.cancel'))}</button>` +
        `<button class="init-act" data-act="app">${escapeHtml(tr('link.openHere'))}</button>` +
        `<button class="init-act primary" data-act="browser">${escapeHtml(tr('link.openBrowser'))}</button>` +
      `</footer>` +
    `</div>`;
  document.body.appendChild(overlay);
  const close = () => closeOverlay(overlay, () => overlay.remove());
  const remember = overlay.querySelector('.link-remember-cb');
  overlay.querySelector('.init-foot').onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'cancel') return close();
    if (remember.checked) setSettingVal('linkOpen', act);
    close();
    if (act === 'browser') openExternalUrl(href);
    else openLinkInApp(href);
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

/* In-app viewer: a native child webview window. Unlike an embedded iframe, a
 * top-level webview isn't subject to a site's X-Frame-Options / frame-ancestors
 * headers, so pages like YouTube that refuse to be framed (which used to show
 * "Refused to connect") open correctly here. It's a standalone window with its
 * own chrome; on failure we fall back to the default browser. */
function openLinkInApp(href) {
  api.openWebview(href).catch((e) => {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('link.failLabel'),
      body: escapeHtml(String((e && e.message) || e)) });
    openExternalUrl(href);
  });
}

