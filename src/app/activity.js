/* activity.js   — Activity panel: live shells & sub-agents
   Part of the chat frontend; shares one global scope (see core.js). */
/* --------------------- Activity: shells & sub-agents --------------------- */
/* The Activity button stays disabled until Claude runs a shell (Bash) or
 * launches a sub-agent (Task). Each such action is tracked here with its
 * command/description and — once the CLI reports it back — its output, so the
 * panel doubles as a live log of what Claude is doing under the hood (e.g. an
 * app it started). Entries persist with the chat via the saved segments. */

const ACTIVITY_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
const ACTIVITY_TOOLS = new Set(['Bash', 'Task']);   // shells & sub-agents
const ACT_ICON = { Bash: '⚡', Task: '🧩' };
const isActivityTool = (name) => ACTIVITY_TOOLS.has(name);

// Rebuild the activity list from a thread's saved messages (tool segments).
function activityFromSegments(messages) {
  const list = [];
  for (const m of (messages || [])) {
    if (m.role !== 'assistant' || !Array.isArray(m.segments)) continue;
    for (const s of m.segments) {
      if (s && s.type === 'tool' && isActivityTool(s.name)) {
        list.push({
          id: s.id || null, name: s.name, target: s.target || '', detail: s.detail || '',
          output: (s.output != null ? s.output : null), isError: !!s.isError, running: false,
        });
      }
    }
  }
  return list;
}

// The latest orchestrator savings summary saved in a thread's transcript (an
// `orchestration` segment, emitted at the end of each delegating turn). Returns
// the most recent one so the Activity panel banner reflects this thread's last
// orchestrator turn, or null if there wasn't one.
function orchFromSegments(messages) {
  let last = null;
  for (const m of (messages || [])) {
    if (m.role !== 'assistant' || !Array.isArray(m.segments)) continue;
    for (const s of m.segments) {
      if (s && s.type === 'orchestration') last = s;
    }
  }
  return last;
}

// Compact a token count for the readout: 12930 → "12.9k", 940 → "940".
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Human duration from milliseconds: 8200 → "8s", 96000 → "1m 36s".
function fmtDur(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// Fold a live agent-progress event into the matching running Task entry. The
// event id is the Task's tool_use id, which is the entry's id. Unmatched ids are
// nested sub-agents (no chip of their own) — ignored. Progress is live-only; the
// Task's final output replaces it once the tool_result lands.
function trackAgentProgress(act, msg, isActive) {
  const it = msg.id && act.find((a) => a.id === msg.id);
  if (!it) return;
  const p = it.progress || (it.progress = {});
  if (msg.subagent) p.subagent = msg.subagent;
  if (msg.description) p.description = msg.description;
  if (msg.lastTool) p.lastTool = msg.lastTool;
  if (msg.toolUses != null) p.toolUses = msg.toolUses;
  if (msg.tokens != null) p.tokens = msg.tokens;
  if (msg.durationMs != null) p.durationMs = msg.durationMs;
  it.running = true;
  if (isActive) { refreshActivityBtn(); refreshActivityPanel(); }
}

// Live "what this sub-agent is doing right now" block for a running Task: its
// current description plus the tool it last used and a step/token/time tally.
function renderAgentProgress(p) {
  const box = document.createElement('div');
  box.className = 'activity-progress';
  if (p.description) {
    const d = document.createElement('div');
    d.className = 'ap-desc';
    d.textContent = p.description;
    box.appendChild(d);
  }
  const meta = document.createElement('div');
  meta.className = 'ap-meta';
  const bits = [];
  if (p.lastTool) bits.push(`<span class="ap-tool">${escapeHtml(p.lastTool)}</span>`);
  if (p.toolUses != null) bits.push(`<span>${p.toolUses} ${escapeHtml(tr('activity.agent.steps'))}</span>`);
  if (p.tokens != null) bits.push(`<span>${fmtTokens(p.tokens)} ${escapeHtml(tr('activity.orch.tokens'))}</span>`);
  if (p.durationMs != null) bits.push(`<span>${fmtDur(p.durationMs)}</span>`);
  meta.innerHTML = bits.join('');
  box.appendChild(meta);
  return box;
}

// Render the orchestrator savings banner from an `orchestration` summary. Shows
// the share of the turn's tokens that ran on cheaper workers vs the premium
// supervisor — the payoff of orchestrator mode, made visible.
function renderOrchBanner(o) {
  const pct = Math.max(0, Math.min(100, Number(o.workerPct) || 0));
  const workerNames = (o.workers || []).map((w) => w.name).filter(Boolean);
  const el = document.createElement('div');
  el.className = 'activity-orch';
  el.innerHTML =
    `<div class="activity-orch-head">` +
      `<span class="activity-orch-ico" aria-hidden="true">⚡</span>` +
      `<span class="activity-orch-title">${escapeHtml(tr('activity.orch.title'))}</span>` +
      `<span class="activity-orch-pct">${pct}% <span class="activity-orch-pct-sub">${escapeHtml(tr('activity.orch.onWorkers'))}</span></span>` +
    `</div>` +
    `<div class="activity-orch-bar"><span class="activity-orch-bar-fill" style="width:${pct}%"></span></div>` +
    `<div class="activity-orch-legend">` +
      `<span class="activity-orch-tag worker">${escapeHtml(tr('activity.orch.workers'))}` +
        `${workerNames.length ? ' · ' + escapeHtml(workerNames.join(', ')) : ''}` +
        ` · ${fmtTokens(o.workerTokens)}</span>` +
      `<span class="activity-orch-tag boss">${escapeHtml(o.orchestrator ? o.orchestrator.name : tr('activity.orch.orchestrator'))}` +
        ` · ${fmtTokens(o.orchestratorTokens)}</span>` +
    `</div>` +
    `<div class="activity-orch-hint">${escapeHtml(tr('activity.orch.hint'))}</div>`;
  return el;
}

// Fold a streamed tool / tool_result event into a thread's activity list `act`.
// `isActive` gates the UI refresh: a background thread's tools accumulate into
// its own list silently and surface when you switch to it.
function trackTool(act, msg, isActive) {
  if (msg.type === 'tool_result') {
    const it = msg.id && act.find((a) => a.id === msg.id);
    if (it) { it.output = msg.output || ''; it.isError = !!msg.isError; it.running = false; }
  } else {
    if (!isActivityTool(msg.name)) return;
    let it = msg.id ? act.find((a) => a.id === msg.id) : null;
    if (it) {                          // refine the same action (start → stop)
      if (msg.target) it.target = msg.target;
      if (msg.detail) it.detail = msg.detail;
      it.running = true;
    } else {
      act.push({
        id: msg.id || ('t' + act.length), name: msg.name,
        target: msg.target || '', detail: msg.detail || '',
        output: null, isError: false, running: true,
      });
    }
  }
  if (isActive) { refreshActivityBtn(); refreshActivityPanel(); }
}

function refreshActivityBtn() {
  const n = state.activity.length;
  els.activityBtn.disabled = n === 0 && !state.activityOrch;
  const running = state.streaming && state.activity.some((a) => a.running);
  els.activityBtn.classList.toggle('live', running);
  const count = n ? `<span class="act-count">${n}</span>` : '';
  els.activityBtn.innerHTML = ACTIVITY_SVG + `<span>${running ? tr('activity.working') : tr('activity.label')}</span>` + count;
}

const ACT_FILTERS = ['all', 'active', 'done'];
function activityMatches(a, f) {
  return f === 'active' ? a.running : f === 'done' ? !a.running : true;
}
function renderActivityFilters() {
  const counts = {
    all: state.activity.length,
    active: state.activity.filter((a) => a.running).length,
    done: state.activity.filter((a) => !a.running).length,
  };
  els.activityFilters.innerHTML = ACT_FILTERS.map((f) =>
    `<button class="activity-filter${state.activityFilter === f ? ' on' : ''}" data-f="${f}">` +
    `${tr('activity.filter.' + f)} ${counts[f]}</button>`).join('');
}

/* Tallest the panel has been this session — locking the body to it keeps the
 * window size persistent while switching statuses (filtering down never shrinks
 * it). Reset when the panel opens fresh or the active chat changes. */
let activityMinH = 0;

function refreshActivityPanel() {
  if (els.activityOverlay.hidden) return;
  renderActivityFilters();
  const body = els.activityBody;
  body.style.minHeight = '';        // measure the natural height first
  renderActivityBody(body);
  // Never let switching statuses make the modal smaller than it has been.
  activityMinH = Math.max(activityMinH, body.offsetHeight);
  body.style.minHeight = activityMinH + 'px';
}

function renderActivityBody(body) {
  body.innerHTML = '';
  // Orchestrator savings banner (this thread's latest delegating turn), on top.
  if (state.activityOrch) body.appendChild(renderOrchBanner(state.activityOrch));
  const emptyLine = (txt) => {
    const d = document.createElement('div');
    d.className = 'activity-empty';
    d.textContent = txt;
    body.appendChild(d);
  };
  if (!state.activity.length) {
    if (!state.activityOrch) emptyLine(tr('activity.empty'));
    return;
  }
  const list = state.activity.filter((a) => activityMatches(a, state.activityFilter));
  if (!list.length) {
    emptyLine(state.activityFilter === 'active' ? tr('activity.emptyActive') : tr('activity.emptyClosed'));
    return;
  }
  for (const a of list) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    const cls = a.isError ? 'error' : (a.running ? 'running' : 'done');
    const stateLbl = tr('activity.state.' + cls);
    const kind = a.name === 'Task' ? tr('activity.kindAgent') : tr('activity.kindShell');
    const head = document.createElement('div');
    head.className = 'activity-item-head';
    head.innerHTML =
      `<span class="activity-ico" aria-hidden="true">${ACT_ICON[a.name] || '⚙️'}</span>` +
      `<span class="activity-name">${escapeHtml(kind)}</span>` +
      `<span class="activity-target">${escapeHtml(a.target || '')}</span>` +
      `<span class="activity-state ${cls}">${a.running ? '<span class="activity-spin"></span>' : ''}${escapeHtml(stateLbl)}</span>`;
    item.appendChild(head);
    if (a.detail) {
      const c = document.createElement('div');
      c.className = 'activity-cmd';
      c.textContent = (a.name === 'Bash' ? '$ ' : '') + a.detail;
      item.appendChild(c);
    }
    // Finished → show captured output. Still running with live sub-agent progress
    // → show what it's doing. Otherwise → a plain running/no-capture line.
    if (a.output != null) {
      const pre = document.createElement('pre');
      pre.className = 'activity-out' + (a.isError ? ' err' : '');
      pre.textContent = a.output || tr('activity.noOutput');
      item.appendChild(pre);
    } else if (a.running && a.progress) {
      item.appendChild(renderAgentProgress(a.progress));
    } else {
      const pre = document.createElement('pre');
      pre.className = 'activity-out';
      pre.textContent = a.running ? tr('activity.running') : tr('activity.noCapture');
      item.appendChild(pre);
    }
    body.appendChild(item);
  }
}

function openActivity() {
  if (els.activityBtn.disabled) return;
  activityMinH = 0;                 // re-measure size for this panel session
  openOverlay(els.activityOverlay);
  refreshActivityPanel();
}
function closeActivity() { closeOverlay(els.activityOverlay); }

els.activityBtn.onclick = openActivity;
els.activityClose.onclick = closeActivity;
els.activityFilters.onclick = (e) => {
  const b = e.target.closest('.activity-filter');
  if (!b || b.dataset.f === state.activityFilter) return;
  state.activityFilter = b.dataset.f;
  refreshActivityPanel();
  replayClass(els.activityBody, 'panel-swap');   // crossfade the new status view
};

// Close on a genuine backdrop click, but not when a text drag-select happens to
// release over the backdrop (mirrors the Initialize/CLAUDE.md modal guard).
let actPressOnBackdrop = false;
els.activityOverlay.addEventListener('mousedown', (e) => { actPressOnBackdrop = (e.target === els.activityOverlay); });
els.activityOverlay.addEventListener('mouseup', (e) => {
  if (actPressOnBackdrop && e.target === els.activityOverlay) closeActivity();
  actPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.activityOverlay.hidden) closeActivity();
});

