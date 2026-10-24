/* header.js     — the chat header's ⋯ menu, and the context ring in the dock
   Part of the chat frontend; shares one global scope (see core.js).

   The header is the chat's title and model. Everything you reach for now and
   then — editing the project's instructions, Settings, the language — lives in
   the ⋯ menu beside the bell instead of as a row of buttons.

   How full the conversation is used to be a bar across the header. It is now a
   small ring at the end of the dock's tools, next to Compact and Clear (the
   things that empty it); clicking it shows the numbers, the "view summary" link
   after a compaction, and the Claude-usage chip. updateUsage (chat.js) still
   fills the same #meter-fill / #meter-label, and calls paintContextRing. */

const headMenu = { btn: $('#head-more'), menu: $('#head-menu') };
const ctxRing = { btn: $('#ctx-ring'), arc: $('#ctx-arc'), pct: $('#ctx-pct'), pop: $('#ctx-pop') };
const CTX_RING_C = 2 * Math.PI * 8;   // the arc's circumference (r = 8)

/* One popover open at a time, shared by the menu and the ring: open/close with
 * the app's usual short fade-and-rise, and close on Escape or a click outside. */
let openPop = null;   // { pop, btn }
function showHeadPop(pop, btn) {
  if (openPop && openPop.pop === pop) { hideHeadPop(); return; }
  hideHeadPop();
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('on');
  requestAnimationFrame(() => pop.classList.add('open'));
  openPop = { pop, btn };
}
function hideHeadPop() {
  if (!openPop) return;
  const { pop, btn } = openPop;
  openPop = null;
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('on');
  pop.classList.remove('open');
  setTimeout(() => { if (!pop.classList.contains('open')) pop.hidden = true; }, 180);
}
document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.pop.contains(e.target) && !openPop.btn.contains(e.target)) hideHeadPop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPop) hideHeadPop();
});

/* ---------------------------------- ⋯ menu -------------------------------- */
headMenu.btn.onclick = () => {
  // Editing CLAUDE.md goes through a chat's session, so it needs one open.
  els.initBtn.hidden = !state.activeId;
  paintMenuLang();
  showHeadPop(headMenu.menu, headMenu.btn);
};
// Any item closes the menu once it has done its thing (init-btn's own handler
// is wizard.js's openClaudeEditor; this one only closes).
headMenu.menu.addEventListener('click', (e) => { if (e.target.closest('.hm-item')) hideHeadPop(); });
$('#hm-settings').onclick = () => openSettings();
$('#hm-lang').onclick = () => window.I18N.setLang(window.I18N.getLang() === 'en' ? 'hr' : 'en');

/* The language row shows what it is now, flag and code, like the old toggle. */
function paintMenuLang() {
  const cur = window.I18N.getLang();
  $('#hm-lang-val').innerHTML = FLAG_SVG[cur] + `<span>${LANG_CODE[cur]}</span>`;
}
document.addEventListener('i18n:changed', paintMenuLang);

/* ------------------------------ context ring ------------------------------ */
ctxRing.btn.onclick = () => showHeadPop(ctxRing.pop, ctxRing.btn);

/* Called by updateUsage with the share of the context window in use and its
 * level (ok / warn / high). The arc's length is the share; its colour the level. */
function paintContextRing(pct, level) {
  const p = Math.max(0, Math.min(100, pct || 0));
  ctxRing.arc.style.strokeDasharray = `${(CTX_RING_C * p / 100).toFixed(2)} ${CTX_RING_C.toFixed(2)}`;
  ctxRing.btn.classList.remove('lvl-ok', 'lvl-warn', 'lvl-high');
  ctxRing.btn.classList.add('lvl-' + (level || 'ok'));
  ctxRing.pct.textContent = p + '%';
}
