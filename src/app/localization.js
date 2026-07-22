/* localization.js — EN/HR flag toggle; re-renders dynamic surfaces on switch
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ localization ----------------------------- */
/* The flag toggle (top-right) flips between English and Hrvatski. i18n.js
 * re-translates the static DOM and fires 'i18n:changed'; we then re-render the
 * dynamic surfaces (pickers, sidebar, open thread) so nothing is left stale. */

const FLAG_SVG = {
  en:
    '<svg class="flag" viewBox="0 0 24 16" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect width="24" height="16" fill="#b22234"/>' +
    '<rect y="1.23" width="24" height="1.23" fill="#fff"/><rect y="3.69" width="24" height="1.23" fill="#fff"/>' +
    '<rect y="6.15" width="24" height="1.23" fill="#fff"/><rect y="8.62" width="24" height="1.23" fill="#fff"/>' +
    '<rect y="11.08" width="24" height="1.23" fill="#fff"/><rect y="13.54" width="24" height="1.23" fill="#fff"/>' +
    '<rect width="10" height="8.62" fill="#3c3b6e"/></svg>',
  hr:
    '<svg class="flag" viewBox="0 0 24 16" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect width="24" height="5.33" fill="#ff0000"/><rect y="5.33" width="24" height="5.34" fill="#fff"/>' +
    '<rect y="10.67" width="24" height="5.33" fill="#171796"/>' +
    '<rect x="10" y="4" width="4" height="8" fill="#fff" stroke="#ff0000" stroke-width="0.4"/>' +
    '<rect x="10" y="4" width="2" height="2" fill="#ff0000"/><rect x="12" y="6" width="2" height="2" fill="#ff0000"/>' +
    '<rect x="10" y="8" width="2" height="2" fill="#ff0000"/><rect x="12" y="10" width="2" height="2" fill="#ff0000"/></svg>',
};
const LANG_CODE = { en: 'EN', hr: 'HR' };

function updateLangBtn() {
  const cur = window.I18N.getLang();
  const html = FLAG_SVG[cur] + `<span class="lang-code">${LANG_CODE[cur]}</span>`;
  document.querySelectorAll('.lang-toggle').forEach((b) => { b.innerHTML = html; });
}

function relocalizeDynamic() {
  buildPickers();                          // re-translate model/mode (keeps selection)
  // The Insight button's label can lose its data-i18n span after use — refresh it.
  if (!els.hintBtn.disabled) {
    els.hintBtn.innerHTML = INSIGHT_SVG + `<span data-i18n="hint.label">${tr('hint.label')}</span>`;
  }
  if (!state.project) { renderProjects(); return; }
  if (state.view === 'saved') refreshSaved();
  else renderSidebar();                    // threads / search use cached data
  if (state.activeId) openThread(state.activeId);
  else showEmpty();
}

document.querySelectorAll('.lang-toggle').forEach((b) => {
  b.onclick = () => window.I18N.setLang(window.I18N.getLang() === 'en' ? 'hr' : 'en');
});
document.addEventListener('i18n:changed', (e) => {
  updateLangBtn();
  // Keep the backend's tie-break language in step with the interface.
  api.setUiLanguage((e.detail && e.detail.lang) || window.I18N.getLang()).catch(() => {});
  updateSettingsBtn();
  els.title.title = tr('rename.headerTitle');
  syncComposer();                          // re-translate the send/stop title
  if (!els.settingsOverlay.hidden) renderSettings();
  relocalizeTasks();                       // re-render the tasks panel if it's open
  if (state.activeId) refreshGit();        // re-translate the "no changes" label
  applyWelcomeInitLabel();                 // keep Initialize/Reinitialize correct
  refreshUsageSurfaces();                  // re-translate the usage chip + picker card
  relocalizeDynamic();
});

