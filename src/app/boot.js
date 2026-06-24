/* boot.js       — entry point — runs the startup sequence (loads LAST)
   Part of the chat frontend; shares one global scope (see core.js). */
/* --------------------------------- init ---------------------------------- */
/* Every launch starts on the project picker — you choose a project to enter. */

enhanceLogos();
whenFontsReady(() => playLogoIntro());   // reveal + intro once the mono font is loaded (crisp K)
updateLangBtn();
updateSettingsBtn();
scheduleLogoLife();
api.discordSetShareName(settingOn('discordShareName')).catch(() => {});
if (discordEnabled()) api.setDiscordEnabled(true).catch(() => {});
populatePickers();
startUsage();
showProjectPicker();

// Faint build-version label in the bottom-right corner (purely informational).
api.appVersion().then((v) => {
  const el = document.getElementById('app-version');
  if (el && v) el.textContent = 'v' + v;
}).catch(() => {});

// Quietly check whether the Claude Code CLI has a newer release and, if so, offer
// a one-click update. Delayed a touch so it never competes with the intro.
setTimeout(() => { checkClaudeCodeUpdate().catch(() => {}); }, 2500);
