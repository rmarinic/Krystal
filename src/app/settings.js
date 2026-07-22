/* settings.js   — Discord presence + Settings panel (tabs, feature switches)
   Part of the chat frontend; shares one global scope (see core.js). */
/* --------------------------- Discord presence ---------------------------- */
/* Opt-in (off by default). The preference lives in localStorage, mirroring how
 * the language choice is stored; the backend owns the actual IPC connection and
 * only ever receives the active project NAME — never chat content. The toggle
 * itself now lives in the Settings panel. */

const DISCORD_KEY = 'krystal.discord';

function discordEnabled() {
  try { return localStorage.getItem(DISCORD_KEY) === '1'; } catch (_) { return false; }
}

function projectLabel() {
  const p = state.project;
  return p ? (p.name || basename(p.path)) : null;
}

/* Flip Discord presence on/off, persist, and tell the backend. */
async function setDiscord(next) {
  try { localStorage.setItem(DISCORD_KEY, next ? '1' : '0'); } catch (_) {}
  try {
    await api.setDiscordEnabled(next);
    if (next) await api.discordSetProject(projectLabel());
  } catch (_) {}
}

/* Push the current project to Discord (no-op when presence is off). */
function syncDiscordProject() {
  if (!discordEnabled()) return;
  api.discordSetProject(projectLabel()).catch(() => {});
}

/* ------------------------------- settings -------------------------------- */
/* Feature switches, remembered in localStorage. Discord lives here too (it
 * keeps its own legacy key). Defaults: the niceties are on, Discord is off. */

const SETTINGS_KEY = 'krystal.settings';
const SETTINGS_DEFAULTS = {
  gitStatus: true, logoLife: true, discordShareName: true, linkOpen: 'ask',
  // Claude-usage calibration caps (weighted tokens). null = not calibrated yet.
  usageCap5h: null, usageCap7d: null,
  // Weekly reset anchor read off Claude's /usage (local weekday 0=Sun..6=Sat + "HH:MM").
  usageWeekResetDay: null, usageWeekResetTime: null,
};

let settings = (function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
  catch (_) { return { ...SETTINGS_DEFAULTS }; }
})();

function settingOn(k) { return !!settings[k]; }
function settingVal(k) { return settings[k]; }
function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
function setSetting(k, v) {
  settings[k] = !!v;
  persistSettings();
  applySetting(k);
}
function setSettingVal(k, v) {           // non-boolean (e.g. the link-open choice)
  settings[k] = v;
  persistSettings();
  applySetting(k);
}
function applySetting(k) {
  if (k === 'gitStatus') refreshGit();
  else if (k === 'logoLife') { scheduleLogoLife(); applyExtraEffects(); }
  else if (k === 'discordShareName') {
    api.discordSetShareName(settingOn(k)).catch(() => {});
    syncDiscordProject();
  }
}

const SETTINGS_GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function updateSettingsBtn() {
  document.querySelectorAll('.settings-toggle').forEach((b) => {
    b.innerHTML = SETTINGS_GEAR_SVG;
    b.title = tr('settings.title');
  });
}

/* The panel is organised into tabs. Each row uses the generic settings store,
 * unless it supplies its own get/set (Discord keeps its legacy key). `sub: true`
 * nests a row under the one above it (e.g. Discord's name-sharing option). */
const SETTINGS_TABS = [
  { id: 'general', rows: [
    { key: 'linkOpen', type: 'choice', choices: ['ask', 'browser', 'app'] },
    { key: 'gitStatus' },
    { key: 'logoLife' },
    { key: 'claudeUpdate', type: 'action' },
  ] },
  { id: 'integrations', rows: [
    { key: 'discord', get: discordEnabled, set: setDiscord },
    { key: 'discordShareName', sub: true },
  ] },
  // Custom-rendered tab (Claude usage + calibration); see renderUsagePanel in usage.js.
  { id: 'usage', custom: 'usage' },
  // Custom-rendered tab: live background chat processes + a stop-all (renderRunsPanel).
  { id: 'activity', custom: 'runs' },
];
let settingsTab = 'general';

/* Claude Code self-update row: shows the installed CLI version and a button that
 * runs `claude update` in the background (same as the terminal), streaming the
 * updater's log lines live. Lives in General so it's easy to find. */
function buildClaudeUpdateRow() {
  const item = document.createElement('div');
  item.className = 'settings-row col claude-update';
  item.innerHTML =
    `<div class="settings-text">` +
      `<div class="settings-name">${escapeHtml(tr('settings.claudeUpdate.name'))}</div>` +
      `<div class="settings-desc">${escapeHtml(tr('settings.claudeUpdate.desc'))}</div>` +
    `</div>` +
    `<div class="cu-status" aria-live="polite"></div>` +
    `<pre class="cu-log" hidden></pre>` +
    `<div class="cu-actions">` +
      `<button class="cu-btn" type="button">${escapeHtml(tr('settings.claudeUpdate.btn'))}</button>` +
    `</div>`;

  const statusEl = item.querySelector('.cu-status');
  const logEl = item.querySelector('.cu-log');
  const btn = item.querySelector('.cu-btn');

  // Best-effort: show the currently-installed version under the description.
  api.preflight().then((pf) => {
    if (pf && pf.version) statusEl.textContent = tr('settings.claudeUpdate.current', { version: pf.version });
  }).catch(() => {});

  btn.onclick = async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy');
    statusEl.textContent = tr('settings.claudeUpdate.working');
    logEl.hidden = false;
    logEl.textContent = '';
    replayClass(logEl, 'cu-log-in');

    const channel = new Channel();
    channel.onmessage = (msg) => {
      if (!msg || msg.type !== 'log') return;
      logEl.textContent += (logEl.textContent ? '\n' : '') + msg.line;
      logEl.scrollTop = logEl.scrollHeight;
    };

    try {
      const res = await api.updateClaude(channel);
      if (res && res.updated && res.version) {
        statusEl.textContent = tr('settings.claudeUpdate.updated', { version: res.version });
      } else if (res && res.version) {
        statusEl.textContent = tr('settings.claudeUpdate.upToDate', { version: res.version });
      } else {
        statusEl.textContent = tr('settings.claudeUpdate.done');
      }
    } catch (err) {
      statusEl.textContent = tr('settings.claudeUpdate.failed', { err: String((err && err.message) || err) });
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  };

  return item;
}

/* ---- Auto-check for a newer Claude Code CLI on launch ----
 * The Settings row above is the manual path; this is the automatic one. On boot
 * we ask npm for the latest published Claude Code version, compare it to what's
 * installed, and — only when there's something newer the user hasn't already
 * waved off — slide in a tip offering a one-click update. Best-effort: any
 * failure (offline, blocked, not installed) is silent, never a nag. */
const CLAUDE_UPD_DISMISS_KEY = 'krystal.claudeUpdateDismissed';

// Compare dotted numeric versions; true when `latest` is strictly newer.
function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const norm = (v) => String(v).trim().replace(/^v/i, '').split(/[.+-]/);
  const a = norm(latest), b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i] || '0', 10), y = parseInt(b[i] || '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) break;   // hit a non-numeric tag — stop comparing
    if (x !== y) return x > y;
  }
  return false;
}

// Ask npm for the latest published Claude Code version (best-effort, time-boxed).
async function latestClaudeVersion() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.version) || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Boot-time offer: if a newer Claude Code is available and the user hasn't
 * already dismissed this exact version, gently prompt for a one-click update. */
async function checkClaudeCodeUpdate() {
  let pf;
  try { pf = await api.preflight(); } catch (_) { return; }
  if (!pf || !pf.installed || !pf.version) return;          // not installed → onboarding owns that
  const latest = await latestClaudeVersion();
  if (!latest || !isNewerVersion(latest, pf.version)) return;
  let dismissed = null;
  try { dismissed = localStorage.getItem(CLAUDE_UPD_DISMISS_KEY); } catch (_) {}
  if (dismissed === latest) return;                          // already said "later" for this version

  showTip({
    key: 'claudeUpd', icon: '⬆️', label: tr('claudeUpd.label'),
    body: escapeHtml(tr('claudeUpd.body', { latest, current: pf.version })),
    actions: [
      { text: tr('claudeUpd.update'), run: (close) => { close(); runClaudeCodeUpdate(); } },
      { text: tr('claudeUpd.later'), ghost: true, run: (close) => {
        try { localStorage.setItem(CLAUDE_UPD_DISMISS_KEY, latest); } catch (_) {}
        close();
      } },
    ],
  });
}

/* Run `claude update` with the polished progress overlay, streaming the updater's
 * latest log line as the sub-caption. Reuses the compact/clear overlay helpers. */
async function runClaudeCodeUpdate() {
  showProgressOverlay({ glyph: '⬆️', title: tr('claudeUpd.overlayTitle'), sub: tr('claudeUpd.overlaySub') });
  const channel = new Channel();
  channel.onmessage = (msg) => {
    if (msg && msg.type === 'log' && msg.line) els.procSub.textContent = msg.line;
  };
  try {
    const res = await api.updateClaude(channel);
    finishProgressOverlay(tr('claudeUpd.overlayDone'));
    if (res && res.updated && res.version) {
      showTip({ key: 'status', icon: '✅', label: tr('claudeUpd.doneLabel'),
        body: escapeHtml(tr('claudeUpd.doneBody', { version: res.version })) });
    } else if (res && res.version) {
      showTip({ key: 'status', icon: '👍', label: tr('claudeUpd.doneLabel'),
        body: escapeHtml(tr('claudeUpd.upToDate', { version: res.version })) });
    }
    try { localStorage.removeItem(CLAUDE_UPD_DISMISS_KEY); } catch (_) {}
  } catch (err) {
    hideProgressOverlay();
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('claudeUpd.failLabel'),
      body: escapeHtml(String((err && err.message) || err)) });
  }
}

/* Settings → Activity tab: the chat turns the app currently has running in the
 * background, each verified against the OS so stale ones (process already gone)
 * are flagged, plus a single Stop-all. Re-queried every time the tab is shown. */
function runTitle(threadId) {
  const t = (state.threads || []).find((x) => x.id === threadId);
  return (t && t.title) || tr('settings.runs.unknown');
}

function renderRunsList(listEl, runs, stopAllBtn) {
  if (stopAllBtn) stopAllBtn.disabled = !runs.length;
  if (!runs.length) {
    listEl.innerHTML = `<div class="runs-empty">${escapeHtml(tr('settings.runs.empty'))}</div>`;
    replayClass(listEl, 'list-swap');
    return;
  }
  listEl.innerHTML = runs.map((r) => {
    const cls = r.alive ? 'alive' : 'stale';
    const label = r.alive ? tr('settings.runs.alive') : tr('settings.runs.stale');
    return `<div class="run ${cls}">` +
        `<span class="run-dot" aria-hidden="true"></span>` +
        `<span class="run-title">${escapeHtml(runTitle(r.threadId))}</span>` +
        `<span class="run-pid">PID ${escapeHtml(String(r.pid))}</span>` +
        `<span class="run-state">${escapeHtml(label)}</span>` +
      `</div>`;
  }).join('');
  replayClass(listEl, 'list-swap');
}

function renderRunsPanel(panel) {
  panel.innerHTML =
    `<div class="settings-row col runs-row">` +
      `<div class="settings-text">` +
        `<div class="settings-name">${escapeHtml(tr('settings.runs.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('settings.runs.desc'))}</div>` +
      `</div>` +
      `<div class="runs-list" aria-live="polite"></div>` +
      `<div class="runs-actions">` +
        `<button class="runs-refresh" type="button">${escapeHtml(tr('settings.runs.refresh'))}</button>` +
        `<button class="runs-stop-all" type="button">${escapeHtml(tr('settings.runs.stopAll'))}</button>` +
      `</div>` +
    `</div>`;

  const listEl = panel.querySelector('.runs-list');
  const refreshBtn = panel.querySelector('.runs-refresh');
  const stopAllBtn = panel.querySelector('.runs-stop-all');

  async function load() {
    listEl.classList.add('busy');
    let runs = [];
    try { runs = await api.activeRuns(); } catch (_) {}
    listEl.classList.remove('busy');
    renderRunsList(listEl, runs || [], stopAllBtn);
  }

  refreshBtn.onclick = () => { if (!refreshBtn.disabled) load(); };
  stopAllBtn.onclick = async () => {
    if (stopAllBtn.disabled) return;
    stopAllBtn.disabled = true;
    try { await api.stopAllChats(); } catch (_) {}
    if (state.view === 'threads') renderSidebar();   // drop the sidebar streaming marks
    await load();
  };

  load();
}

function buildSettingRow(row) {
  if (row.key === 'claudeUpdate') return buildClaudeUpdateRow();

  const item = document.createElement('div');
  item.className = 'settings-row' + (row.sub ? ' sub' : '') + (row.type === 'choice' ? ' col' : '');
  const text =
    `<div class="settings-text">` +
      `<div class="settings-name">${escapeHtml(tr('settings.' + row.key + '.name'))}</div>` +
      `<div class="settings-desc">${escapeHtml(tr('settings.' + row.key + '.desc'))}</div>` +
    `</div>`;

  if (row.type === 'choice') {
    // A small segmented control (e.g. Ask / Browser / In app).
    const seg = document.createElement('div');
    seg.className = 'seg-control';
    const cur = settingVal(row.key);
    seg.innerHTML = row.choices.map((c) =>
      `<button class="seg${c === cur ? ' on' : ''}" data-val="${c}">` +
      `${escapeHtml(tr('settings.' + row.key + '.' + c))}</button>`).join('');
    seg.onclick = (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      setSettingVal(row.key, b.dataset.val);
      seg.querySelectorAll('.seg').forEach((x) => x.classList.toggle('on', x === b));
    };
    item.innerHTML = text;
    item.appendChild(seg);
    return item;
  }

  const on = row.get ? row.get() : settingOn(row.key);
  item.innerHTML = text +
    `<button class="settings-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" ` +
      `title="${tr(on ? 'settings.on' : 'settings.off')}"><span class="switch-knob"></span></button>`;
  const sw = item.querySelector('.settings-switch');
  sw.onclick = async () => {
    const next = !(row.get ? row.get() : settingOn(row.key));
    if (row.set) await row.set(next); else setSetting(row.key, next);
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', String(next));
    sw.title = tr(next ? 'settings.on' : 'settings.off');
  };
  return item;
}

let settingsPanelEl = null;

// Fill the rows panel with one tab's settings (tabs/intro stay put around it).
function fillSettingsTab(panel, tabId) {
  panel.innerHTML = '';
  const active = SETTINGS_TABS.find((t) => t.id === tabId) || SETTINGS_TABS[0];
  if (active.custom === 'usage') { renderUsagePanel(panel); return; }   // usage.js
  if (active.custom === 'runs') { renderRunsPanel(panel); return; }
  for (const row of active.rows) panel.appendChild(buildSettingRow(row));
}

// Tallest tab's content height — locking the panel to it keeps the window size
// persistent when flipping tabs (no jump between General/Integrations).
function measureSettingsMax(panel) {
  panel.style.minHeight = '';
  let max = 0;
  for (const t of SETTINGS_TABS) {
    fillSettingsTab(panel, t.id);
    max = Math.max(max, panel.offsetHeight);
  }
  fillSettingsTab(panel, settingsTab);   // restore the visible tab
  return max;
}

function renderSettings() {
  const body = els.settingsBody;
  body.innerHTML = '';

  const tabs = document.createElement('div');
  tabs.className = 'settings-tabs';
  for (const t of SETTINGS_TABS) {
    const b = document.createElement('button');
    b.className = 'settings-tab' + (t.id === settingsTab ? ' on' : '');
    b.dataset.tab = t.id;
    b.textContent = tr('settings.tab.' + t.id);
    b.onclick = () => switchSettingsTab(t.id);
    tabs.appendChild(b);
  }
  const underline = document.createElement('div');
  underline.className = 'settings-tab-underline';
  tabs.appendChild(underline);
  body.appendChild(tabs);
  positionTabUnderline(false);   // place it under the active tab (no slide on first paint)

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = tr('settings.intro');
  body.appendChild(intro);

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  body.appendChild(panel);
  settingsPanelEl = panel;

  fillSettingsTab(panel, settingsTab);
  const max = measureSettingsMax(panel);
  if (max) panel.style.minHeight = max + 'px';
}

// Slide the underline to sit beneath the active tab. `animate=false` snaps it
// (used on first render so it doesn't slide in from the left).
function positionTabUnderline(animate) {
  const tabs = els.settingsBody.querySelector('.settings-tabs');
  const underline = tabs && tabs.querySelector('.settings-tab-underline');
  const on = tabs && tabs.querySelector('.settings-tab.on');
  if (!underline || !on) return;
  if (!animate) underline.style.transition = 'none';
  underline.style.left = on.offsetLeft + 'px';
  underline.style.width = on.offsetWidth + 'px';
  if (!animate) { void underline.offsetWidth; underline.style.transition = ''; }
}

// Switch tabs without rebuilding the chrome: just swap rows with a crossfade.
function switchSettingsTab(id) {
  if (id === settingsTab || !settingsPanelEl) return;
  settingsTab = id;
  els.settingsBody.querySelectorAll('.settings-tab').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === id));
  positionTabUnderline(true);
  fillSettingsTab(settingsPanelEl, id);
  replayClass(settingsPanelEl, 'panel-swap');
}

// Show first, then render: the panel height must be measured while visible
// (an element inside display:none reports zero height).
function openSettings() { openOverlay(els.settingsOverlay); renderSettings(); }
function closeSettings() { closeOverlay(els.settingsOverlay); }

document.querySelectorAll('.settings-toggle').forEach((b) => { b.onclick = openSettings; });
els.settingsClose.onclick = closeSettings;

// Backdrop click closes (same press-start-and-end guard as the other modals).
let setPressOnBackdrop = false;
els.settingsOverlay.addEventListener('mousedown', (e) => { setPressOnBackdrop = (e.target === els.settingsOverlay); });
els.settingsOverlay.addEventListener('mouseup', (e) => {
  if (setPressOnBackdrop && e.target === els.settingsOverlay) closeSettings();
  setPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.settingsOverlay.hidden) closeSettings();
});

