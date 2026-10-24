/* usage.js     — Claude subscription usage (the 5-hour session + weekly limits).
   Part of the chat frontend; shares one global scope (see core.js). */
/* The real numbers, as Claude's own usage settings show them. Two sources feed
 * one list of windows ({ kind, label, pct, resetsAt, severity }, see
 * claude/limits.rs): the `claude_usage` command asks the usage endpoint — on
 * start, every few minutes while the window is in view, and when a window's
 * reset time passes — and every turn's `rate_limit` event (stream.js) brings
 * the server's latest session and weekly figures in between. A window a turn
 * doesn't mention (a model's own weekly share) keeps what the endpoint said.
 * Surfaces: a glanceable chip in the context ring's popover, a mark on the ring
 * itself while the session or the week nears its limit (so you see it without
 * opening anything), the Settings → Usage tab, and a toast when a window
 * crosses into warning. */

const USAGE_POLL_MS = 5 * 60000;    // ask the endpoint this often while the window is visible
const USAGE_THROTTLE_MS = 60000;    // …and never more often than this, unless asked
const USAGE_WARN = 0.80;            // amber nudge
const USAGE_HIGH = 0.95;            // red nudge

let usageData = null;               // { available, reason?, windows, at }
let usageFetchedAt = 0;
let usageFetching = null;           // in-flight promise (dedupe concurrent calls)
let usagePollTimer = null;
const usageWarned = {};             // e.g. { 's:warn': true } — fire each level once per session

/* ------------------------------- model ----------------------------------- */

const usageNow = () => Date.now() / 1000;
const usageKey = (w) => w.kind + '|' + (w.label || '');

// Fold fresh windows into the ones we had: same kind + label replaces, the
// rest stay. Pure, so the merge rules are testable.
function mergeUsageWindows(prev, fresh) {
  const out = (prev || []).slice();
  for (const w of fresh || []) {
    const i = out.findIndex((o) => usageKey(o) === usageKey(w));
    if (i >= 0) out[i] = w; else out.push(w);
  }
  return out;
}

function usageWindow(kind) {
  const ws = (usageData && usageData.windows) || [];
  return ws.find((w) => w.kind === kind && !w.label) || ws.find((w) => w.kind === kind) || null;
}

// Fraction (0..1) used in a window, or null when we know nothing about it. A
// window whose reset time has passed is empty until the next figure arrives.
function windowFrac(w, now) {
  if (!w || typeof w.pct !== 'number') return null;
  if (w.resetsAt && w.resetsAt <= (now == null ? usageNow() : now)) return 0;
  return Math.max(0, w.pct / 100);
}
function usageFrac(kind) { return windowFrac(usageWindow(kind)); }

// Seconds until a window resets, or null.
function windowResetSecs(w) {
  return w && w.resetsAt ? w.resetsAt - usageNow() : null;
}

function usageLevel(f, severity) {
  if (severity === 'limited') return 'high';
  return f == null ? '' : f >= USAGE_HIGH ? 'high' : f >= USAGE_WARN ? 'warn' : 'ok';
}
function windowLevel(w) { return usageLevel(windowFrac(w), w && w.severity); }

// Which of the two limits that matter — the session and the week — are near
// running out, and the worse of their levels ('' when neither is).
function usageAlert(s, wk) {
  const hot = [s, wk].filter((w) => w && (windowLevel(w) === 'warn' || windowLevel(w) === 'high'));
  const level = hot.some((w) => windowLevel(w) === 'high') ? 'high' : hot.length ? 'warn' : '';
  return { level, hot };
}

function fmtPct(f) { return f == null ? '—' : Math.min(100, Math.round(f * 100)) + '%'; }
function fmtResetIn(secs) {
  if (secs == null) return '';
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return tr('usage.resetSoon');
  const m = Math.round(s / 60);
  if (m < 60) return tr('usage.minShort', { n: m });
  return tr('usage.hmShort', { h: Math.floor(m / 60), m: m % 60 });
}
// "Mon 10:00" — a weekly reset moment, in the app's language.
function fmtWeekly(epoch) {
  const lang = window.I18N.getLang();
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString(lang, { weekday: 'short' }) + ' ' +
         d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}
// When a window frees up: a countdown for the session, a day and time for a week.
function windowResetText(w) {
  const secs = windowResetSecs(w);
  if (secs == null || secs <= 0) return '';
  return w.kind === 'session' || secs < 86400
    ? tr('usage.resetIn', { time: fmtResetIn(secs) })
    : tr('usage.resetAt', { when: fmtWeekly(w.resetsAt) });
}

/* ------------------------------- fetch ----------------------------------- */

// A figure from before a window's reset says nothing about it any more.
function usageStale() {
  const at = (usageData && usageData.at) || 0;
  return ((usageData && usageData.windows) || []).some((w) => w.resetsAt && w.resetsAt * 1000 > at && w.resetsAt <= usageNow());
}

async function fetchUsage(force) {
  const fresh = Date.now() - usageFetchedAt < USAGE_THROTTLE_MS;
  if (!force && usageData && fresh && !usageStale()) return usageData;
  if (usageFetching) return usageFetching;
  usageFetching = api.claudeUsage()
    .then((d) => {
      usageFetchedAt = Date.now();
      if (d && d.available) {
        usageData = { available: true, windows: d.windows || [], at: Date.now() };
      } else if (usageData && usageData.windows && usageData.windows.length) {
        // The endpoint couldn't answer (a token the CLI hasn't refreshed yet,
        // offline): what the last turn said still stands.
        usageData = { ...usageData, reason: d && d.reason };
      } else {
        usageData = { available: false, reason: (d && d.reason) || 'offline', windows: [] };
      }
      return usageData;
    })
    .catch(() => { usageData = usageData || { available: false, reason: 'offline', windows: [] }; return usageData; })
    .finally(() => { usageFetching = null; });
  const d = await usageFetching;
  refreshUsageSurfaces();
  maybeWarnUsage();
  return d;
}

// A turn's `rate_limit` event: the server's own figures, as they stand now.
function usageFromTurn(windows) {
  if (!Array.isArray(windows) || !windows.length) return;
  usageData = {
    available: true,
    windows: mergeUsageWindows(usageData && usageData.windows, windows),
    at: Date.now(),
  };
  refreshUsageSurfaces();
  maybeWarnUsage();
}

// Re-paint every place usage is shown (cheap; safe to call often).
function refreshUsageSurfaces() {
  renderUsageChip();
  paintUsageMark();
  if (settingsTab === 'usage' && !els.settingsOverlay.hidden && settingsPanelEl) {
    renderUsagePanel(settingsPanelEl);
  }
}

/* ------------------------------ rendering -------------------------------- */

function windowLabel(w) {
  if (w.kind === 'session') return tr('usage.5h.label');
  if (w.kind === 'weekly') return tr('usage.weekly.label');
  return tr('usage.scoped.label', { name: w.label || '?' });
}

// One labelled bar with its reset time under it.
function usageBar(w) {
  const f = windowFrac(w);
  const pct = f == null ? 0 : Math.min(100, f * 100);
  const reset = windowResetText(w);
  return `<div class="usage-bar-row">` +
      `<div class="usage-bar-head">` +
        `<span class="usage-bar-label">${escapeHtml(windowLabel(w))}</span>` +
        `<span class="usage-bar-pct">${fmtPct(f)}</span>` +
      `</div>` +
      `<div class="usage-bar"><div class="usage-bar-fill lvl-${windowLevel(w) || 'ok'}" style="width:${pct}%"></div></div>` +
      (reset ? `<div class="usage-reset">${escapeHtml(reset)}</div>` : '') +
    `</div>`;
}

// Session first, then the week, then each model's own share of it.
function usageBarsHtml() {
  const order = { session: 0, weekly: 1, weekly_scoped: 2 };
  const ws = ((usageData && usageData.windows) || []).slice()
    .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  return `<div class="usage-bars">${ws.map(usageBar).join('')}</div>`;
}

// Glanceable header chip near the context meter.
function renderUsageChip() {
  const chip = els.usageChip;
  if (!chip) return;
  const s = usageWindow('session'), wk = usageWindow('weekly');
  if (!s && !wk) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = 'usage-chip lvl-' + (usageAlert(s, wk).level || 'ok');
  chip.title = tr('usage.chipTitle');
  // Each half wears its own level, so you can tell which limit is the close one.
  const seg = (w, k) =>
    `<span class="uc-seg lvl-${windowLevel(w) || 'ok'}"><span class="uc-k">${escapeHtml(tr(k))}</span> ${fmtPct(windowFrac(w))}</span>`;
  chip.innerHTML =
    `<span class="uc-ico" aria-hidden="true">${icon('zap')}</span>` +
    seg(s, 'usage.5hShort') + seg(wk, 'usage.wkShort');
}

/* The mark on the context ring: a small "!" at the ring's shoulder while the
 * session or the week is at 80% or more — amber, red from 95% or once refused.
 * It answers the figure changing, not a timer: it pops in once when it appears
 * or rises a level, and otherwise sits still. Opening the ring shows which. */
function paintUsageMark() {
  const btn = typeof ctxRing !== 'undefined' && ctxRing.btn;
  if (!btn) return;
  const { level, hot } = usageAlert(usageWindow('session'), usageWindow('weekly'));
  let mark = btn.querySelector('.ctx-alert');
  if (!level) { if (mark) mark.remove(); return; }
  const rose = !mark || (mark.dataset.lvl === 'warn' && level === 'high');
  if (!mark) {
    mark = document.createElement('span');
    btn.appendChild(mark);
  }
  mark.className = 'ctx-alert lvl-' + level;
  mark.dataset.lvl = level;
  mark.textContent = '!';
  const what = hot.map((w) => `${windowLabel(w)} ${fmtPct(windowFrac(w))}`).join(' · ');
  mark.title = tr('usage.markTitle', { what });
  if (rose && motionOK()) replayClass(mark, 'pop', 600);
}

// "Updated 3 min ago", for the panel's foot.
function usageUpdatedText() {
  const at = usageData && usageData.at;
  if (!at) return '';
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? tr('usage.updatedNow') : tr('usage.updatedAgo', { time: fmtResetIn(m * 60) });
}

// The Settings → Usage tab.
function renderUsagePanel(panel) {
  if (!usageData) fetchUsage(true);       // nothing yet → ask
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'usage-panel';
  const has = usageData && usageData.windows && usageData.windows.length;

  if (!has) {
    const reason = (usageData && usageData.reason) || 'loading';
    wrap.innerHTML = `<div class="usage-unavailable">${escapeHtml(tr('usage.none.' + reason))}</div>`;
  } else {
    wrap.innerHTML =
      `<p class="usage-intro">${escapeHtml(tr('usage.intro'))}</p>` +
      usageBarsHtml() +
      `<div class="usage-foot">` +
        `<span class="usage-updated">${escapeHtml(usageUpdatedText())}</span>` +
        `<button class="usage-refresh" type="button">${escapeHtml(tr('usage.refresh'))}</button>` +
      `</div>`;
    const btn = wrap.querySelector('.usage-refresh');
    btn.onclick = () => { btn.disabled = true; fetchUsage(true); };
  }
  panel.appendChild(wrap);
}

/* ------------------------------- warnings -------------------------------- */

// Nudge once per level per window per session as a window nears its limit.
function maybeWarnUsage() {
  warnWindow('s', usageWindow('session'), 'usage.warnSession', 'usage.highSession');
  warnWindow('w', usageWindow('weekly'), 'usage.warnWeekly', 'usage.highWeekly');
}
function warnWindow(tag, w, warnKey, highKey) {
  const f = windowFrac(w);
  if (f == null) return;
  const lvl = windowLevel(w);
  if (lvl === 'ok') { delete usageWarned[tag + ':warn']; delete usageWarned[tag + ':high']; return; }
  const k = tag + ':' + lvl;
  if (usageWarned[k]) return;
  usageWarned[k] = true;
  const body = tr(lvl === 'high' ? highKey : warnKey, { pct: fmtPct(f), reset: windowResetText(w) });
  // A toast under the bell, like any other news; a side-tip when toasts are off.
  const shown = typeof showNotice === 'function' && showNotice({
    id: 'usage-' + tag, tone: lvl, icon: '!',
    kind: tr('usage.warnLabel'), html: body, where: tr('usage.toastOpen'),
    run: openUsageSettings,
  });
  if (shown) return;
  showTip({
    key: 'usage-' + tag, cls: lvl, icon: 'zap',
    label: tr('usage.warnLabel'),
    body,
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

// Poll while the window is visible; ask again when it comes back into view.
// The minute tick only re-asks once a window's reset has passed.
function startUsage() {
  fetchUsage(true);
  clearInterval(usagePollTimer);
  usagePollTimer = setInterval(() => {
    if (document.hidden) return;
    if (usageStale() || Date.now() - usageFetchedAt >= USAGE_POLL_MS) fetchUsage(true);
    else refreshUsageSurfaces();   // the countdowns move on
  }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchUsage(); });
}
