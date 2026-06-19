/* usage.js     — Claude subscription usage (rolling 5-hour + weekly windows).
   Part of the chat frontend; shares one global scope (see core.js). */
/* The `claude` CLI exposes no rate-limit numbers, so we estimate usage the same
 * way the official-style status line does: the Rust `claude_usage` command sums
 * *weighted* tokens from the local session transcripts into a 5-hour window and a
 * 7-day window (plus the current 5h block's start). Those totals become
 * percentages against caps the user calibrates ONCE — read Claude's own /usage,
 * type the two %s, and we back-solve the caps (cap = used ÷ fraction). After that
 * the percentages are accurate for the account with no further input.
 * Surfaces: the project picker card, a glanceable header chip, and a Settings
 * tab; plus a gentle side-tip when a window nears its cap. */

const USAGE_POLL_MS = 60000;        // refresh cadence while the window is visible
const USAGE_THROTTLE_MS = 25000;    // never rescan the transcripts more often than this
const USAGE_WARN = 0.80;            // amber nudge
const USAGE_HIGH = 0.95;            // red nudge

let usageData = null;               // last { available, h5, d7, blockStart, now }
let usageFetchedAt = 0;
let usageFetching = null;           // in-flight promise (dedupe concurrent calls)
let usagePollTimer = null;
const usageWarned = {};             // e.g. { 's:warn': true } — fire each level once per session

/* ------------------------------- model ----------------------------------- */

function usageCaps() {
  return { c5: Number(settingVal('usageCap5h')) || 0, c7: Number(settingVal('usageCap7d')) || 0 };
}
function usageCalibrated() {
  const { c5, c7 } = usageCaps();
  return c5 > 0 && c7 > 0;
}

// Fraction (0..1+) used in a window, or null when uncalibrated / no data.
function usageFrac(which) {
  if (!usageData || !usageData.available) return null;
  const { c5, c7 } = usageCaps();
  if (which === '5h') return c5 > 0 ? usageData.h5 / c5 : null;
  return c7 > 0 ? usageData.d7 / c7 : null;
}

// Seconds until the current 5-hour session block frees up. The backend hands us
// the live block's start (Claude's fixed 5h session, hour-floored), and backend
// + UI share one clock, so the live countdown is just blockStart + 5h − now.
function usageResetSecs() {
  if (!usageData || usageData.blockStart == null) return null;
  return (usageData.blockStart + 5 * 3600) - (Date.now() / 1000);
}

/* The weekly limit resets on a fixed account schedule (e.g. "Mon 11:00") that the
 * local logs don't carry — the user reads it off Claude's /usage during
 * calibration. From the stored weekday+time we derive the window boundaries. */
// Most recent PAST weekly reset (unix secs), or null when not set yet.
function weeklyAnchorReset() {
  const day = settingVal('usageWeekResetDay');
  const time = settingVal('usageWeekResetTime');
  if (day == null || day === '' || !time) return null;
  const [hh, mm] = String(time).split(':').map((n) => parseInt(n, 10) || 0);
  const now = new Date();
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  d.setDate(d.getDate() - ((now.getDay() - Number(day) + 7) % 7));   // back to that weekday
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);       // not reached yet → last week
  return Math.floor(d.getTime() / 1000);
}
function weeklyNextReset() {
  const last = weeklyAnchorReset();
  return last == null ? null : last + 7 * 86400;
}
// Localized weekday name for 0=Sun..6=Sat (2024-01-07 was a Sunday).
function weekdayName(idx) {
  return new Date(2024, 0, 7 + idx).toLocaleDateString(window.I18N.getLang(), { weekday: 'long' });
}

function usageLevel(f) {
  return f == null ? '' : f >= USAGE_HIGH ? 'high' : f >= USAGE_WARN ? 'warn' : 'ok';
}

function fmtPct(f) { return f == null ? '—' : Math.min(999, Math.round(f * 100)) + '%'; }
function fmtDur(secs) {
  if (secs == null) return '';
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return tr('usage.resetSoon');
  const m = Math.round(s / 60);
  if (m < 60) return tr('usage.minShort', { n: m });
  return tr('usage.hmShort', { h: Math.floor(m / 60), m: m % 60 });
}
// "Mon 11:00" — the weekly reset moment, in the app's language.
function fmtWeekly(epoch) {
  const lang = window.I18N.getLang();
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString(lang, { weekday: 'short' }) + ' ' +
         d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------- fetch ----------------------------------- */

async function fetchUsage(force) {
  const fresh = Date.now() - usageFetchedAt < USAGE_THROTTLE_MS;
  if (!force && usageData && fresh) return usageData;
  if (usageFetching) return usageFetching;
  usageFetching = api.claudeUsage(weeklyAnchorReset())
    .then((d) => { usageData = d || { available: false }; usageFetchedAt = Date.now(); return usageData; })
    .catch(() => { usageData = usageData || { available: false }; return usageData; })
    .finally(() => { usageFetching = null; });
  const d = await usageFetching;
  refreshUsageSurfaces();
  maybeWarnUsage();
  return d;
}

// Re-paint every place usage is shown (cheap; safe to call often).
function refreshUsageSurfaces() {
  renderUsageChip();
  if (settingsTab === 'usage' && !els.settingsOverlay.hidden && settingsPanelEl) {
    renderUsagePanel(settingsPanelEl);
  }
}

/* ------------------------------ rendering -------------------------------- */

// One labelled bar (used by the picker card and the Settings panel).
function usageBar(labelKey, f) {
  const lvl = usageLevel(f) || 'ok';
  const pct = f == null ? 0 : Math.min(100, f * 100);
  return `<div class="usage-bar-row">` +
      `<div class="usage-bar-head">` +
        `<span class="usage-bar-label">${escapeHtml(tr(labelKey))}</span>` +
        `<span class="usage-bar-pct">${fmtPct(f)}</span>` +
      `</div>` +
      `<div class="usage-bar"><div class="usage-bar-fill lvl-${lvl}" style="width:${pct}%"></div></div>` +
    `</div>`;
}

function usageBarsHtml(opts) {
  opts = opts || {};
  let h = '';
  if (!usageCalibrated()) h += `<div class="usage-uncal">${escapeHtml(tr('usage.uncalibrated'))}</div>`;
  h += `<div class="usage-bars">` +
    usageBar('usage.5h.label', usageFrac('5h')) +
    usageBar('usage.weekly.label', usageFrac('weekly')) +
  `</div>`;
  if (opts.withReset) {
    const secs = usageResetSecs();
    if (secs != null && secs > 0) {
      h += `<div class="usage-reset">${escapeHtml(tr('usage.resetIn', { time: fmtDur(secs) }))}</div>`;
    }
    const wk = weeklyNextReset();
    if (wk != null) {
      h += `<div class="usage-reset">${escapeHtml(tr('usage.weeklyResetAt', { when: fmtWeekly(wk) }))}</div>`;
    }
  }
  return h;
}

// Glanceable header chip near the context meter (calibrated users only).
function renderUsageChip() {
  const chip = els.usageChip;
  if (!chip) return;
  if (!usageCalibrated() || !usageData || !usageData.available) { chip.hidden = true; return; }
  const f5 = usageFrac('5h'), f7 = usageFrac('weekly');
  chip.hidden = false;
  chip.className = 'usage-chip lvl-' + (usageLevel(Math.max(f5 || 0, f7 || 0)) || 'ok');
  chip.title = tr('usage.chipTitle');
  chip.innerHTML =
    `<span class="uc-ico" aria-hidden="true">⚡</span>` +
    `<span class="uc-seg"><span class="uc-k">${escapeHtml(tr('usage.5hShort'))}</span> ${fmtPct(f5)}</span>` +
    `<span class="uc-seg"><span class="uc-k">${escapeHtml(tr('usage.wkShort'))}</span> ${fmtPct(f7)}</span>`;
}

// The Settings → Usage tab: live bars + the calibration form.
function renderUsagePanel(panel) {
  if (!usageData) fetchUsage();           // nothing cached yet → kick a scan
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'usage-panel';

  if (usageData && !usageData.available) {
    wrap.innerHTML = `<div class="usage-unavailable">${escapeHtml(tr('usage.unavailable'))}</div>`;
    panel.appendChild(wrap);
    return;
  }

  wrap.innerHTML =
    `<p class="usage-intro">${escapeHtml(tr('usage.intro'))}</p>` +
    usageBarsHtml({ withReset: true });

  const cal = document.createElement('div');
  cal.className = 'usage-cal';
  cal.innerHTML =
    `<div class="usage-cal-head">${escapeHtml(tr(usageCalibrated() ? 'usage.recalTitle' : 'usage.calTitle'))}</div>` +
    `<p class="usage-cal-hint">${escapeHtml(tr('usage.calHint'))}</p>` +
    `<div class="usage-cal-row">` +
      `<label class="usage-cal-field"><span>${escapeHtml(tr('usage.cur5h'))}</span>` +
        `<input type="number" min="0" max="100" step="1" class="usage-in-5h" inputmode="numeric" placeholder="0"></label>` +
      `<label class="usage-cal-field"><span>${escapeHtml(tr('usage.curWeekly'))}</span>` +
        `<input type="number" min="0" max="100" step="1" class="usage-in-7d" inputmode="numeric" placeholder="0"></label>` +
    `</div>` +
    `<div class="usage-cal-row">` +
      `<label class="usage-cal-field"><span>${escapeHtml(tr('usage.weekResetDay'))}</span>` +
        `<select class="usage-in-wd">` +
          [0, 1, 2, 3, 4, 5, 6].map((i) => `<option value="${i}">${escapeHtml(weekdayName(i))}</option>`).join('') +
        `</select></label>` +
      `<label class="usage-cal-field"><span>${escapeHtml(tr('usage.weekResetTime'))}</span>` +
        `<input type="time" class="usage-in-wt"></label>` +
    `</div>` +
    `<div class="usage-cal-actions">` +
      (usageCalibrated() ? `<button class="usage-cal-clear" type="button">${escapeHtml(tr('usage.clearCal'))}</button>` : '') +
      `<button class="usage-cal-save" type="button">${escapeHtml(tr('usage.saveCal'))}</button>` +
    `</div>`;
  wrap.appendChild(cal);
  panel.appendChild(wrap);

  // Pre-fill the weekly reset from any stored anchor.
  const wd = cal.querySelector('.usage-in-wd'), wt = cal.querySelector('.usage-in-wt');
  if (settingVal('usageWeekResetDay') != null) wd.value = String(settingVal('usageWeekResetDay'));
  if (settingVal('usageWeekResetTime')) wt.value = settingVal('usageWeekResetTime');

  cal.querySelector('.usage-cal-save').onclick = () => {
    saveCalibration(parseFloat(cal.querySelector('.usage-in-5h').value),
                    parseFloat(cal.querySelector('.usage-in-7d').value),
                    wd.value, wt.value);
  };
  const clr = cal.querySelector('.usage-cal-clear');
  if (clr) clr.onclick = () => {
    setSettingVal('usageCap5h', null);
    setSettingVal('usageCap7d', null);
    for (const k in usageWarned) delete usageWarned[k];
    refreshUsageSurfaces();
  };
}

/* ----------------------------- calibration ------------------------------- */

// Back-solve each window's cap from the % the user read off Claude's /usage:
// cap = current_weighted_used ÷ (entered_pct / 100). Only set a window we have
// real numbers for (used > 0 and a positive percentage).
async function saveCalibration(p5, p7, weekday, time) {
  // Persist the weekly reset anchor FIRST, then re-scan so the weekly total is
  // summed over Claude's real weekly window before we back-solve its cap.
  if (weekday !== '' && weekday != null && time) {
    setSettingVal('usageWeekResetDay', Number(weekday));
    setSettingVal('usageWeekResetTime', time);
  }
  const d = await fetchUsage(true);
  if (!d || !d.available) return;
  let set = false;
  if (p5 > 0 && d.h5 > 0) { setSettingVal('usageCap5h', d.h5 / (p5 / 100)); set = true; }
  if (p7 > 0 && d.d7 > 0) { setSettingVal('usageCap7d', d.d7 / (p7 / 100)); set = true; }
  if (!set) {
    showTip({ key: 'usage', cls: 'warn', icon: '⚡', label: tr('usage.calLabel'), body: tr('usage.calNeedData') });
    return;
  }
  for (const k in usageWarned) delete usageWarned[k];   // re-evaluate against the new caps
  refreshUsageSurfaces();
  maybeWarnUsage();
  showTip({ key: 'usage', icon: '⚡', label: tr('usage.calLabel'), body: tr('usage.calSaved') });
}

/* ------------------------------- warnings -------------------------------- */

// Nudge once per level per window per session as a window nears its cap.
function maybeWarnUsage() {
  if (!usageCalibrated() || !usageData || !usageData.available) return;
  warnWindow('s', usageFrac('5h'), 'usage.warnSession', 'usage.highSession', true);
  warnWindow('w', usageFrac('weekly'), 'usage.warnWeekly', 'usage.highWeekly', false);
}
function warnWindow(tag, f, warnKey, highKey, withReset) {
  if (f == null) return;
  const lvl = usageLevel(f);
  if (lvl === 'ok') { delete usageWarned[tag + ':warn']; delete usageWarned[tag + ':high']; return; }
  const k = tag + ':' + lvl;
  if (usageWarned[k]) return;
  usageWarned[k] = true;
  const isHigh = lvl === 'high';
  const vars = { pct: fmtPct(f) };
  if (withReset) vars.time = fmtDur(usageResetSecs());
  showTip({
    key: 'usage-' + tag, cls: isHigh ? 'high' : 'warn', icon: '⚡',
    label: tr('usage.warnLabel'),
    body: tr(isHigh ? highKey : warnKey, vars),
    actions: [{ text: tr('usage.warnDismiss'), ghost: true, run: (close) => close() }],
  });
}

/* --------------------------------- wiring -------------------------------- */

// Header chip opens Settings straight to the Usage tab.
function openUsageSettings() {
  openSettings();              // settings.js
  switchSettingsTab('usage');  // settings.js
}
if (els.usageChip) els.usageChip.onclick = openUsageSettings;

// Poll while the window is visible; refresh immediately when it regains focus.
function startUsage() {
  fetchUsage(true);
  clearInterval(usagePollTimer);
  usagePollTimer = setInterval(() => { if (!document.hidden) fetchUsage(); }, USAGE_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchUsage(); });
}
