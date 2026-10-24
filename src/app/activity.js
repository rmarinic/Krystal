/* activity.js   — Activity panel: what Claude ran (commands & sub-agents)
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------- Activity: commands & sub-agents --------------------- */
/* The Activity button stays disabled until Claude runs a shell (Bash/PowerShell) or
 * launches a sub-agent (Task). Each such action is tracked here with its
 * command/description and — once the CLI reports it back — its output. Entries
 * persist with the chat via the saved segments.
 *
 * The panel is written for someone who doesn't read shell. It used to be a flat
 * log — every command and all of its output, open, oldest first — which made a
 * long chat a wall of monospace. Now:
 *   - steps are grouped under the message that asked for them, newest first;
 *     only the latest group is open, and its header jumps to that message;
 *   - each step is one line in plain words ("Search for “keyframes”"), closed;
 *     the command and the end of its output are one click away, and a failed
 *     step opens on its own;
 *   - a run of plain looking-around (reads, searches, listings) folds into one
 *     "Looked through the project" line, so what changed, built or failed
 *     stands out;
 *   - a summary says what ran and what's running now, and the filters are the
 *     two questions worth asking: what failed, what's still going. */

const ACTIVITY_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
// Shells & sub-agents — the two kinds of thing worth logging here.
const isActivityTool = (name) => isShellTool(name) || isAgentTool(name);

/* ------------------------------ the activity list ------------------------------ */

// Rebuild the activity list from a thread's saved messages (tool segments). Each
// step remembers the message that asked for it — its turn.
function activityFromSegments(messages) {
  const list = [];
  let turn = null;
  for (const m of (messages || [])) {
    if (m.role === 'user') { turn = { key: 'm' + m.id, text: m.text || '', mid: m.id }; continue; }
    if (m.role !== 'assistant' || !Array.isArray(m.segments)) continue;
    for (const s of m.segments) {
      if (s && s.type === 'tool' && isActivityTool(s.name)) {
        list.push({
          id: s.id || null, name: s.name, target: s.target || '', detail: s.detail || '',
          output: (s.output != null ? s.output : null), isError: !!s.isError, running: false, turn,
        });
      }
    }
  }
  return list;
}

// The turn a live step belongs to. Made once per liveTurn; the message's id
// arrives with the `saved` event, so it is filled in when it's known.
let actTurnSeq = 0;
function activityTurnOf(live) {
  if (!live) return null;
  const t = live.actTurn || (live.actTurn = { key: 'live' + (++actTurnSeq), text: live.userText || '', mid: null, live: true });
  if (!t.mid && live.savedFrom) t.mid = live.savedFrom;
  return t;
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
      `<span class="activity-orch-ico" aria-hidden="true">${icon('zap')}</span>` +
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
// `live` is the turn it belongs to (for grouping and timing). `isActive` gates
// the UI refresh: a background thread's tools accumulate into its own list
// silently and surface when you switch to it.
function trackTool(act, msg, isActive, live) {
  if (msg.type === 'tool_result') {
    const it = msg.id && act.find((a) => a.id === msg.id);
    if (it) { it.output = msg.output || ''; it.isError = !!msg.isError; it.running = false; it.end = Date.now(); }
  } else {
    if (!isActivityTool(msg.name)) return;
    let it = msg.id ? act.find((a) => a.id === msg.id) : null;
    if (it) {                          // refine the same action (start → stop)
      if (msg.target) it.target = msg.target;
      if (msg.detail) { it.detail = msg.detail; it._cmd = null; }
      it.running = true;
    } else {
      act.push({
        id: msg.id || ('t' + act.length), name: msg.name,
        target: msg.target || '', detail: msg.detail || '',
        output: null, isError: false, running: true,
        turn: activityTurnOf(live), start: Date.now(),
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

/* --------------------------------- grouping --------------------------------- */

// A step still going. `running` is only cleared by a result, and a turn that was
// stopped never gets one — so it only counts while the chat's turn is live.
const actRunning = (a) => !!a.running && !!state.streaming;

// Group steps by the message that asked for them, in order. Steps arrive in
// order, so a group is a run of the same turn key.
function activityTurns(list) {
  const groups = [];
  for (const a of list) {
    const key = a.turn ? a.turn.key : '';
    const g = groups[groups.length - 1];
    if (g && g.key === key) g.items.push(a);
    else groups.push({ key, turn: a.turn || null, items: [a] });
  }
  return groups;
}

// Lay out one turn's steps: sub-agents first (each the biggest piece of work in
// the turn), then the commands in order, with every run of FOLD_MIN or more
// finished, successful looking-around steps folded into one line.
const FOLD_MIN = 3;
function activitySteps(items, kindOf, isRunning) {
  const agents = [], rest = [];
  for (const a of items) (kindOf(a) === 'agent' ? agents : rest).push(a);
  const out = agents.map((a) => ({ type: 'step', a }));
  let run = [];
  const flush = () => {
    if (run.length >= FOLD_MIN) out.push({ type: 'fold', items: run });
    else for (const a of run) out.push({ type: 'step', a });
    run = [];
  };
  for (const a of rest) {
    if (kindOf(a) === 'look' && !a.isError && !isRunning(a)) run.push(a);
    else { flush(); out.push({ type: 'step', a }); }
  }
  flush();
  return out;
}

// Counted noun, with Croatian's three forms (1 naredba, 2 naredbe, 5 naredbi).
function actPlural(n, base) {
  const lang = (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : 'en';
  let form = n === 1 ? 'one' : 'many';
  if (lang === 'hr') {
    const d = n % 10, h = n % 100;
    form = (d === 1 && h !== 11) ? 'one' : (d >= 2 && d <= 4 && (h < 12 || h > 14)) ? 'few' : 'many';
  }
  return tr(`${base}.${form}`, { n }, tr(`${base}.many`, { n }));
}

// "14 commands · 2 sub-agents · 1 failed" for a set of steps.
function activityCounts(items) {
  const agents = items.filter((a) => isAgentTool(a.name)).length;
  const cmds = items.length - agents;
  const failed = items.filter((a) => a.isError).length;
  const parts = [];
  if (cmds) parts.push(escapeHtml(actPlural(cmds, 'activity.n.cmd')));
  if (agents) parts.push(escapeHtml(actPlural(agents, 'activity.n.agent')));
  if (failed) parts.push(`<span class="bad">${escapeHtml(actPlural(failed, 'activity.n.failed'))}</span>`);
  return parts.join(' · ');
}

/* --------------------------------- the panel --------------------------------- */

const ACT_FILTERS = ['all', 'failed', 'running'];
function activityMatches(a, f) {
  return f === 'failed' ? a.isError : f === 'running' ? actRunning(a) : true;
}
// "All" always; "Failed" and "Running now" only when there is something to
// show (or you're looking at them). A lone "All" says nothing — then no filters.
function renderActivityFilters() {
  const counts = {
    all: state.activity.length,
    failed: state.activity.filter((a) => a.isError).length,
    running: state.activity.filter(actRunning).length,
  };
  const shown = ACT_FILTERS.filter((f) => f === 'all' || counts[f] > 0 || state.activityFilter === f);
  els.activityFilters.innerHTML = shown.length < 2 ? '' : shown.map((f) =>
    `<button class="activity-filter${state.activityFilter === f ? ' on' : ''}${f === 'failed' ? ' bad' : ''}" data-f="${f}">` +
    `${tr('activity.filter.' + f)} ${counts[f]}</button>`).join('');
}

/* Tallest the panel has been this session — locking the body to it keeps the
 * window size persistent while switching statuses (filtering down never shrinks
 * it). Reset when the panel opens fresh or the active chat changes. */
let activityMinH = 0;
const actTurnOpen = new Map();   // turn key -> open? (your choice; by default only the newest is)
const actFoldOpen = new Set();   // first step id of each looking-around fold you opened
let actClock = 0;                // 1 s ticker for the running clocks — only while something runs

// A different chat: its groups, folds and filter start from their defaults.
function resetActivityView() {
  activityMinH = 0;
  actTurnOpen.clear();
  actFoldOpen.clear();
  state.activityFilter = 'all';
}

function refreshActivityPanel() {
  if (els.activityOverlay.hidden) return;
  renderActivityFilters();
  const body = els.activityBody;
  const top = body.scrollTop;       // a live re-render must not throw you back to the top
  body.style.minHeight = '';        // measure the natural height first
  renderActivityBody(body);
  // Never let switching statuses make the modal smaller than it has been.
  activityMinH = Math.max(activityMinH, body.offsetHeight);
  body.style.minHeight = activityMinH + 'px';
  body.scrollTop = top;
  syncActivityClock();
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
  body.appendChild(renderActivitySummary());
  const f = state.activityFilter;
  const list = state.activity.filter((a) => activityMatches(a, f));
  if (!list.length) {
    emptyLine(f === 'running' ? tr('activity.emptyRunning') : tr('activity.emptyFailed'));
    return;
  }
  const groups = activityTurns(list);
  // Newest first: what just happened is what you opened the panel to see. A
  // filtered view is short by nature, so every group in it opens.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const open = f !== 'all' ? true : (actTurnOpen.has(g.key) ? actTurnOpen.get(g.key) : i === groups.length - 1);
    body.appendChild(renderActivityTurn(g, open));
  }
}

// What ran in this chat, and what's running now.
function renderActivitySummary() {
  const box = document.createElement('div');
  box.className = 'act-summary';
  const counts = document.createElement('div');
  counts.className = 'act-sum-counts';
  counts.innerHTML = activityCounts(state.activity);
  box.appendChild(counts);
  const running = state.activity.filter(actRunning);
  const now = document.createElement('div');
  now.className = 'act-sum-now' + (running.length ? ' live' : '');
  if (running.length) {
    const a = running[running.length - 1];
    now.innerHTML =
      `<span class="act-dot" aria-hidden="true"></span>` +
      `<span class="act-sum-label">${escapeHtml(tr('activity.now'))} <b>${escapeHtml(activityInfo(a).label)}</b></span>` +
      (a.start ? `<span class="act-clock" data-start="${a.start}">${fmtDur(Date.now() - a.start)}</span>` : '') +
      (running.length > 1 ? `<span class="act-sum-more">+${running.length - 1}</span>` : '');
  } else {
    now.innerHTML = `<span class="act-dot" aria-hidden="true"></span><span>${escapeHtml(tr('activity.idle'))}</span>`;
  }
  box.appendChild(now);
  return box;
}

// The message a turn's group belongs to, in the transcript. A turn still being
// answered may not carry its id on the bubble yet — it's the last thing you said.
function turnMessageEl(turn) {
  if (!turn) return null;
  if (turn.mid != null) {
    const el = els.feed.querySelector(`.msg.user[data-mid="${cssEsc(String(turn.mid))}"]`);
    if (el) return el;
  }
  if (turn.live) {
    const all = els.feed.querySelectorAll('.msg.user');
    return all[all.length - 1] || null;
  }
  return null;
}

// Close the panel and bring the message into view, with the same brief glow a
// search hit gets — so you can see what the steps were answering.
function jumpToTurn(turn) {
  const el = turnMessageEl(turn);
  if (!el) return;
  closeActivity();
  el.scrollIntoView({ block: 'center', behavior: motionOK() ? 'smooth' : 'auto' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

function renderActivityTurn(g, open) {
  const sec = document.createElement('section');
  sec.className = 'act-turn' + (open ? ' open' : '');
  sec.dataset.key = g.key;
  const head = document.createElement('div');
  head.className = 'act-turn-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(open));
  const text = g.turn ? String(g.turn.text || '').trim().split('\n')[0] : '';
  const live = g.items.some(actRunning);
  head.innerHTML =
    '<span class="act-caret" aria-hidden="true">▸</span>' +
    (g.turn
      ? `<span class="act-turn-who">${escapeHtml(tr('activity.turnYou'))}</span>` +
        `<span class="act-turn-text">${escapeHtml(cmdClip(text, 140) || '…')}</span>`
      : `<span class="act-turn-text muted">${escapeHtml(tr('activity.turnEarlier'))}</span>`) +
    (live ? '<span class="act-dot live" aria-hidden="true"></span>' : '') +
    `<span class="act-turn-meta">${activityCounts(g.items)}</span>`;
  if (g.turn && (g.turn.mid != null || g.turn.live)) {
    const jump = document.createElement('button');
    jump.className = 'act-jump';
    jump.title = tr('activity.showInChat');
    jump.setAttribute('aria-label', tr('activity.showInChat'));
    jump.innerHTML = icon('arrowRight');
    jump.onclick = (e) => { e.stopPropagation(); jumpToTurn(g.turn); };
    head.appendChild(jump);
  }
  const toggle = () => {
    actTurnOpen.set(g.key, !open);
    refreshActivityPanel();
    // The group you opened settles in; the rest of the panel stays put.
    const body = els.activityBody.querySelector(`.act-turn[data-key="${cssEsc(g.key)}"] .act-turn-body`);
    if (body && !open) replayClass(body, 'act-turn-in');
  };
  head.onclick = toggle;
  head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  sec.appendChild(head);
  if (open) {
    const body = document.createElement('div');
    body.className = 'act-turn-body';
    for (const s of activitySteps(g.items, (a) => activityInfo(a).kind, actRunning)) {
      body.appendChild(s.type === 'fold' ? renderActivityFold(s.items) : renderActivityStep(s.a));
    }
    sec.appendChild(body);
  }
  return sec;
}

// A row that opens in place: its one line, and a body under it that slides
// open (filled the first time it's needed — a long chat has hundreds of rows,
// and most are never opened).
function activityRow(cls, lineHtml, open, fill) {
  const row = document.createElement('div');
  row.className = 'act-row ' + cls + (open ? ' open' : '');
  const line = document.createElement('div');
  line.className = 'act-line';
  line.setAttribute('role', 'button');
  line.tabIndex = 0;
  line.setAttribute('aria-expanded', String(open));
  line.innerHTML = lineHtml + '<span class="act-caret" aria-hidden="true">▸</span>';
  const more = document.createElement('div');
  more.className = 'act-more';
  const inner = document.createElement('div');
  inner.className = 'act-more-in';
  more.appendChild(inner);
  row.append(line, more);
  let filled = false;
  const ensure = () => { if (!filled) { fill(inner); filled = true; } };
  if (open) ensure();
  row._toggle = (next) => {
    if (next) { ensure(); void more.offsetHeight; }   // in place first, so it slides from closed
    row.classList.toggle('open', next);
    line.setAttribute('aria-expanded', String(next));
  };
  return { row, line };
}

function stepMark(a) {
  if (a.isError) return `<span class="act-mark failed">${escapeHtml(tr('activity.state.error'))}</span>`;
  if (actRunning(a)) {
    return '<span class="act-mark running"><span class="act-dot live" aria-hidden="true"></span>' +
      (a.start ? `<span class="act-clock" data-start="${a.start}">${fmtDur(Date.now() - a.start)}</span>` : '') + '</span>';
  }
  const took = a.start && a.end && a.end - a.start >= 1000 ? `<span class="act-took">${fmtDur(a.end - a.start)}</span>` : '';
  return `<span class="act-mark done">${took}${icon('check')}</span>`;
}

function renderActivityStep(a) {
  const info = activityInfo(a);
  const running = actRunning(a);
  const cls = 'kind-' + info.kind + (a.isError ? ' failed' : running ? ' running' : '');
  // A failed step opens on its own: the error is what you came to see.
  const open = a.open != null ? a.open : a.isError;
  const { row, line } = activityRow(cls,
    `<span class="act-ico" aria-hidden="true">${icon(info.icon)}</span>` +
    `<span class="act-label">${escapeHtml(info.label)}</span>` + stepMark(a),
    open, (box) => fillActivityDetails(box, a));
  // A sub-agent has a run of its own — offer the inspector right on its line,
  // and while it works, what it's doing now stays in view under it.
  if (info.kind === 'agent' && hasAgentRun(a.id)) {
    const btn = document.createElement('button');
    btn.className = 'activity-open';
    btn.textContent = tr('agent.openBtn');
    btn.title = tr('agent.openTitle');
    btn.onclick = (e) => { e.stopPropagation(); openAgentPanel(a.id); };
    line.insertBefore(btn, line.querySelector('.act-mark'));
  }
  if (info.kind === 'agent' && running && a.progress) {
    const now = document.createElement('div');
    now.className = 'act-agent-now';
    now.appendChild(renderAgentProgress(a.progress));
    row.insertBefore(now, row.querySelector('.act-more'));
  }
  const toggle = () => { a.open = !row.classList.contains('open'); row._toggle(a.open); };
  line.onclick = toggle;
  line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  return row;
}

// A run of looking-around, as one line that opens onto its steps.
function renderActivityFold(items) {
  const key = items[0].id || '';
  const open = actFoldOpen.has(key);
  const { row, line } = activityRow('act-fold kind-look',
    `<span class="act-ico" aria-hidden="true">${icon('search')}</span>` +
    `<span class="act-label">${escapeHtml(tr('activity.lookedAround'))}</span>` +
    `<span class="act-mark done"><span class="act-took">${escapeHtml(actPlural(items.length, 'activity.n.cmd'))}</span>${icon('check')}</span>`,
    open, (box) => { for (const a of items) box.appendChild(renderActivityStep(a)); });
  const toggle = () => {
    const next = !row.classList.contains('open');
    if (next) actFoldOpen.add(key); else actFoldOpen.delete(key);
    row._toggle(next);
  };
  line.onclick = toggle;
  line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  return row;
}

// What's behind a step's line: the command itself, then the end of what it
// printed (or a sub-agent's report). The CLI sends a shell's output only when it
// finishes, so a running one says so instead of looking empty.
const ACT_TAIL_LINES = 12;
function fillActivityDetails(box, a) {
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'act-detail';
  if (!isAgentTool(a.name) && a.detail) {
    const c = document.createElement('div');
    c.className = 'act-cmd';
    c.textContent = shellPrompt(a.name) + a.detail;
    d.appendChild(c);
  }
  if (a.output != null && a.output !== '') {
    const lines = String(a.output).replace(/\s+$/, '').split('\n');
    const cut = !a.full && lines.length > ACT_TAIL_LINES;
    const pre = document.createElement('pre');
    pre.className = 'act-out' + (a.isError ? ' err' : '');
    pre.textContent = cut ? lines.slice(-ACT_TAIL_LINES).join('\n') : lines.join('\n');
    if (cut) {
      const all = document.createElement('button');
      all.className = 'act-all';
      all.textContent = tr('activity.showAll', { n: lines.length });
      all.onclick = (e) => { e.stopPropagation(); a.full = true; fillActivityDetails(box, a); };
      d.append(all, pre);
    } else {
      d.appendChild(pre);
      if (a.full && lines.length > ACT_TAIL_LINES) {
        const less = document.createElement('button');
        less.className = 'act-all';
        less.textContent = tr('activity.showLess');
        less.onclick = (e) => { e.stopPropagation(); a.full = false; fillActivityDetails(box, a); };
        d.appendChild(less);
      }
    }
  } else {
    const n = document.createElement('div');
    n.className = 'act-note';
    n.textContent = actRunning(a) ? tr('activity.runningNote')
      : a.output === '' ? tr('activity.noOutput') : tr('activity.noCapture');
    d.appendChild(n);
  }
  box.appendChild(d);
}

// The running clocks tick once a second while the panel is open and something
// runs, and stop the moment nothing does: a resting panel costs nothing.
function syncActivityClock() {
  const need = !els.activityOverlay.hidden && !!els.activityBody.querySelector('.act-clock');
  if (need && !actClock) {
    actClock = setInterval(() => {
      if (els.activityOverlay.hidden) { clearInterval(actClock); actClock = 0; return; }   // closed some other way
      const now = Date.now();
      els.activityBody.querySelectorAll('.act-clock').forEach((c) => { c.textContent = fmtDur(now - Number(c.dataset.start)); });
    }, 1000);
  } else if (!need && actClock) {
    clearInterval(actClock);
    actClock = 0;
  }
}

function openActivity() {
  if (els.activityBtn.disabled) return;
  activityMinH = 0;                 // re-measure size for this panel session
  openOverlay(els.activityOverlay);
  refreshActivityPanel();
}
function closeActivity() {
  closeOverlay(els.activityOverlay);
  if (actClock) { clearInterval(actClock); actClock = 0; }
}

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
  // The agent inspector opens on top of this panel — Escape closes that first.
  if (e.key === 'Escape' && !els.activityOverlay.hidden && els.agentOverlay.hidden) closeActivity();
});
