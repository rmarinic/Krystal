/* boot.js       — entry point — runs the startup sequence (loads LAST)
   Part of the chat frontend; shares one global scope (see core.js). */
/* --------------------------------- init ---------------------------------- */
/* Every launch starts on the project picker — you choose a project to enter. */

enhanceLogos();
applyExtraEffects();   // reflect the Extra effects setting first: the intro's movement depends on it
playLogoIntro();   // the face wakes up, the wordmark glows once
updateLangBtn();
// Tell the backend the current UI language so it can pick the reply-language
// tie-break for messages too short to identify (never an override).
api.setUiLanguage(window.I18N.getLang()).catch(() => {});
api.setSuggestions(settingOn('promptSuggestions')).catch(() => {});
updateSettingsBtn();
scheduleLogoLife();
api.discordSetShareName(settingOn('discordShareName')).catch(() => {});
if (discordEnabled()) api.setDiscordEnabled(true).catch(() => {});
populatePickers();
startModelRefresh();
startUsage();
accountBootCheck();   // is this computer still linked to app.krystal.rip?
showProjectPicker();

// Faint build-version label in the bottom-right corner (purely informational).
api.appVersion().then((v) => {
  const el = document.getElementById('app-version');
  if (el && v) el.textContent = 'v' + v;
}).catch(() => {});

// Quietly check whether the Claude Code CLI has a newer release and, if so, offer
// a one-click update. Delayed a touch so it never competes with the intro.
setTimeout(() => { checkClaudeCodeUpdate().catch(() => {}); }, 2500);
