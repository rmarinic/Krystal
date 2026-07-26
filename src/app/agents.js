/* agents.js     — Agent inspector: a live window into one sub-agent's run
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------- agent runs ------------------------------ */
/* Every sub-agent Claude launches (a Task tool call) gets a run record here,
 * keyed by the Task's tool_use id — the same id its action chip carries. The
 * record collects everything the CLI tells us about that worker: the brief it was
 * given, every tool it reaches for and every line it says, its token/step tally,
 * and finally the report it hands back.
 *
 * Deliberately kept OUTSIDE `state.live`: a turn is dropped from there the moment
 * it finishes, and you still want to open a finished agent and read what it did.
 * Live steps aren't persisted, though — reopening the chat in a later session
 * rebuilds the run from the saved Task segment (brief + report) and the panel
 * says as much. */

const agentRuns = new Map();        // tool_use id -> run (insertion-ordered)
const AGENT_LOG_MAX = 500;          // cap a chatty worker's timeline
const AGENT_RUNS_MAX = 200;         // …and how many runs a long session keeps around

function agentRun(id) { return id ? agentRuns.get(id) || null : null; }
function hasAgentRun(id) { return !!agentRun(id); }

function ensureAgentRun(id, threadId, opts = {}) {
  let r = agentRuns.get(id);
  if (!r) {
    r = {
      id, threadId: threadId || null,
      subagent: '', description: '',
      tokens: null, toolUses: null, durationMs: null, lastTool: '',
      startedAt: opts.live === false ? null : Date.now(), endedAt: null,
      running: opts.live !== false, live: opts.live !== false, stopped: false,
      output: null, isError: false,
      log: [],
    };
    agentRuns.set(id, r);
    trimAgentRuns();
  }
  if (threadId && !r.threadId) r.threadId = threadId;
  return r;
}

/* Keep a very long session from hoarding timelines: drop the oldest settled runs
 * (a Map iterates in insertion order) once we're past the cap. */
function trimAgentRuns() {
  if (agentRuns.size <= AGENT_RUNS_MAX) return;
  for (const [id, r] of agentRuns) {
    if (agentRuns.size <= AGENT_RUNS_MAX) break;
    if (!r.running && id !== agentOpenId) agentRuns.delete(id);
  }
}

/* The run behind an agent event, adopting the tool call it belongs to if we
 * haven't recognised it as delegation yet.
 *
 * Recognising it by tool name alone is brittle — the CLI has renamed this tool
 * before (`Task` → `Agent`), and an unknown name meant every agent event was
 * silently dropped. So: the CLI reporting progress under a tool_use id that has a
 * chip in the transcript IS the proof that chip launched a sub-agent, whatever the
 * tool is called. The chip is upgraded in place and tracked from here on.
 *
 * No chip for the id → a worker a worker spawned itself. Those are nested inside
 * their parent's run and get no inspector of their own. */
function adoptAgentRun(id) {
  const known = agentRun(id);
  if (known) return known;
  const chip = els.feed.querySelector(`.action-chip[data-id="${cssEsc(id)}"]`);
  if (!chip) return null;
  const r = ensureAgentRun(id, state.activeId);
  const seg = chip._seg || {};
  r.description = seg.detail || seg.target || '';
  upgradeChipToAgent(chip, r);
  return r;
}

/* Turn an ordinary tool chip into a sub-agent chip, in place — mutating rather
 * than replacing so the stream's reference to the live chip stays valid. */
function upgradeChipToAgent(chip, r) {
  if (chip.classList.contains('agent-chip')) return;
  chip.classList.add('agent-chip');
  chip.classList.remove('expandable', 'open');
  const details = chip.querySelector('.chip-details');
  if (details) details.remove();
  const row = chip.querySelector('.chip-row');
  if (!row) return;
  row.title = tr('agent.openTitle');
  const ico = row.querySelector('.chip-ico');
  if (ico) ico.textContent = TOOL_ICON.Agent;
  const caret = row.querySelector('.chip-caret');
  if (caret) caret.remove();
  if (!row.querySelector('.chip-tally')) {
    const tally = document.createElement('span');
    tally.className = 'chip-tally';
    row.appendChild(tally);
  }
  if (!row.querySelector('.chip-open')) {
    const open = document.createElement('span');
    open.className = 'chip-open';
    open.setAttribute('aria-hidden', 'true');
    open.textContent = '⤢';
    row.appendChild(open);
  }
  row.onclick = () => openAgentPanel(r.id);
  syncAgentChip(chip, r);
}

/* An Agent/Task tool event — the sub-agent was just launched (the second event
 * for the same id carries its brief, so this runs twice and refines in place). */
function agentTaskSeen(threadId, msg) {
  if (!msg || !msg.id) return;
  const r = ensureAgentRun(msg.id, threadId);
  if (msg.detail) r.description = msg.detail;
  else if (msg.target && !r.description) r.description = msg.target;
  agentRunChanged(r);
}

/* The CLI's periodic tally for a running worker (tokens, steps, last tool). */
function agentProgressSeen(msg) {
  if (!msg || !msg.id) return;
  const r = adoptAgentRun(msg.id);
  if (!r) return;
  if (msg.subagent) r.subagent = msg.subagent;
  if (msg.description) r.description = msg.description;
  if (msg.lastTool) r.lastTool = msg.lastTool;
  if (msg.toolUses != null) r.toolUses = msg.toolUses;
  if (msg.tokens != null) r.tokens = msg.tokens;
  if (msg.durationMs != null) r.durationMs = msg.durationMs;
  if (!r.endedAt) r.running = true;      // a straggler must not un-finish a run
  agentRunChanged(r);
}

/* One line of what the worker is saying or doing right now → the timeline. */
function agentActivitySeen(msg) {
  if (!msg || !msg.id) return;
  const r = adoptAgentRun(msg.id);
  if (!r) return;
  const entry = {
    kind: msg.kind === 'tool' ? 'tool' : 'text',
    tool: msg.tool || '', target: msg.target || '', detail: msg.detail || '',
    text: msg.text || '', at: Date.now(),
  };
  r.log.push(entry);
  while (r.log.length > AGENT_LOG_MAX) r.log.shift();
  agentRunChanged(r, entry);
}

/* The Task's tool_result — the worker finished and handed its report back. */
function agentResultSeen(msg) {
  if (!msg || !msg.id) return;
  const r = agentRun(msg.id);
  if (!r) return;
  r.output = msg.output != null ? msg.output : '';
  r.isError = !!msg.isError;
  r.running = false;
  r.endedAt = Date.now();
  agentRunChanged(r);
}

/* The whole turn ended (finished, failed or stopped): no more events are coming,
 * so nothing should still be spinning. A worker still running at this point never
 * got to report back — that's a stop, not a finish. */
function agentTurnEnded(threadId) {
  for (const r of agentRuns.values()) {
    if (r.threadId !== threadId || !r.running) continue;
    r.running = false;
    r.endedAt = Date.now();
    if (r.output == null) r.stopped = true;
    agentRunChanged(r);
  }
}

/* Rebuild the runs of a re-opened chat from its saved Task segments. Only fills
 * gaps: a run from this session keeps its full live timeline. */
function hydrateAgentRuns(threadId, messages) {
  for (const m of (messages || [])) {
    if (m.role !== 'assistant' || !Array.isArray(m.segments)) continue;
    for (const s of m.segments) {
      if (!s || s.type !== 'tool' || !isAgentTool(s.name) || !s.id) continue;
      if (agentRuns.has(s.id)) continue;
      const r = ensureAgentRun(s.id, threadId, { live: false });
      r.description = s.detail || s.target || '';
      r.output = s.output != null ? s.output : null;
      r.isError = !!s.isError;
    }
  }
}

/* Switching chats: an inspector showing another chat's worker doesn't belong on
 * top of the one you just opened. */
function closeAgentPanelIfForeign(threadId) {
  if (els.agentOverlay.hidden) return;
  const r = agentRun(agentOpenId);
  if (!r || (r.threadId && r.threadId !== threadId)) closeAgentPanel();
}

/* Status of a run, as one word the UI can key off: running | error | stopped | done. */
function agentState(r) {
  if (r.running) return 'running';
  if (r.isError) return 'error';
  if (r.stopped) return 'stopped';
  return 'done';
}

/* How long the worker has been going. The CLI's own duration wins when we have
 * it; between its updates we keep counting from the first event we saw so the
 * readout never looks frozen. */
function agentElapsed(r) {
  const own = Number(r.durationMs) || 0;
  const seen = r.startedAt ? (r.endedAt || Date.now()) - r.startedAt : 0;
  return Math.max(own, seen);
}

/* -------------------------------- the chip ------------------------------- */
/* A sub-agent doesn't expand inline like other tool chips — it opens the
 * inspector, so the chip stays a small pill carrying a live tally. */

function agentTally(r) {
  const bits = [];
  if (r.toolUses != null) bits.push(r.toolUses + ' ' + tr('agent.stat.steps'));
  if (r.tokens != null) bits.push(fmtTokens(r.tokens));
  return bits.join(' · ');
}

function renderAgentChip(seg, working) {
  const r = ensureAgentRun(seg.id, state.activeId, { live: working });
  if (seg.detail && !r.description) r.description = seg.detail;
  const el = document.createElement('div');
  el.className = 'action-chip agent-chip ' + (working ? 'working' : 'done');
  el.dataset.id = seg.id;
  el._seg = seg;

  const row = document.createElement('div');
  row.className = 'chip-row';
  row.title = tr('agent.openTitle');
  row.innerHTML =
    '<span class="chip-status" aria-hidden="true"></span>' +
    `<span class="chip-ico" aria-hidden="true">${TOOL_ICON.Agent}</span>` +
    `<span class="chip-label">${escapeHtml(toolLabel(seg.name || 'Agent') + (seg.target ? ' · ' + seg.target : ''))}</span>` +
    '<span class="chip-tally"></span>' +
    '<span class="chip-open" aria-hidden="true">⤢</span>';
  el.appendChild(row);
  row.onclick = () => openAgentPanel(seg.id);
  syncAgentChip(el, r);
  return el;
}

/* Keep a chip's tally + status in step with its run. */
function syncAgentChip(el, r) {
  const tally = el.querySelector('.chip-tally');
  if (tally) tally.textContent = agentTally(r);
  const st = agentState(r);
  el.classList.toggle('working', st === 'running');
  el.classList.toggle('done', st !== 'running');
  el.classList.toggle('error', st === 'error');
}

/* Refresh every agent chip on screen from the store (used after a thread switch
 * replays a live turn's chips). */
function refreshAgentChips() {
  els.feed.querySelectorAll('.agent-chip[data-id]').forEach((el) => {
    const r = agentRun(el.dataset.id);
    if (r) syncAgentChip(el, r);
  });
}

/* ------------------------------- the panel ------------------------------- */

let agentOpenId = null;      // run currently shown in the inspector, if open
let agentTick = null;        // 1s ticker that keeps the elapsed readout honest
let agentStick = true;       // timeline auto-follow (same rule as the chat feed)

const AGENT_STATS = ['tokens', 'steps', 'elapsed', 'tool'];

function openAgentPanel(id) {
  const r = agentRun(id);
  if (!r) return;
  agentOpenId = id;
  agentStick = true;
  openOverlay(els.agentOverlay);
  renderAgentPanel();
  els.agentBody.scrollTop = els.agentBody.scrollHeight;
  startAgentTick();
}

function closeAgentPanel() {
  stopAgentTick();
  agentOpenId = null;
  closeOverlay(els.agentOverlay);
}

function startAgentTick() {
  stopAgentTick();
  agentTick = setInterval(() => {
    const r = agentRun(agentOpenId);
    if (!r) return stopAgentTick();
    if (!r.running) return stopAgentTick();
    setAgentStat('elapsed', fmtDur(agentElapsed(r)));   // ticks every second: no flash
  }, 1000);
}
function stopAgentTick() { if (agentTick) { clearInterval(agentTick); agentTick = null; } }

/* Full render: header, stat tiles, timeline, footer. Called on open and whenever
 * the run changes state (started → finished); a plain new step only appends. */
function renderAgentPanel() {
  const r = agentRun(agentOpenId);
  if (!r) return;
  const st = agentState(r);

  els.agentTitle.innerHTML = escapeHtml(tr('agent.panelTitle')) +
    (r.subagent ? `<span class="agent-type">${escapeHtml(r.subagent)}</span>` : '');
  els.agentSub.textContent = r.description || '';
  els.agentSub.hidden = !r.description;
  els.agentStatus.className = 'agent-status ' + st;
  els.agentStatus.innerHTML =
    (st === 'running' ? '<span class="agent-live-dot" aria-hidden="true"></span>' : '') +
    `<span>${escapeHtml(tr('agent.status.' + st))}</span>`;

  els.agentStats.innerHTML = AGENT_STATS.map((k) =>
    `<div class="ag-stat" data-k="${k}">` +
      '<span class="ag-stat-v">–</span>' +
      `<span class="ag-stat-k">${escapeHtml(tr('agent.stat.' + k))}</span>` +
    '</div>').join('');
  updateAgentStats(r, true);

  renderAgentTimeline(r);
  syncAgentFoot(r);
}

function setAgentStat(key, value, bump) {
  const v = els.agentStats.querySelector(`.ag-stat[data-k="${key}"] .ag-stat-v`);
  if (!v) return;
  const next = value == null || value === '' ? '–' : String(value);
  if (v.textContent === next) return;
  v.textContent = next;
  if (bump) replayClass(v, 'bump', 400);      // a quiet colour tick, not a jump
}

function updateAgentStats(r, silent) {
  setAgentStat('tokens', r.tokens != null ? fmtTokens(r.tokens) : null, !silent);
  setAgentStat('steps', r.toolUses != null ? r.toolUses : null, !silent);
  setAgentStat('elapsed', agentElapsed(r) ? fmtDur(agentElapsed(r)) : null);
  setAgentStat('tool', r.lastTool ? toolLabel(r.lastTool) : null, !silent);
}

/* One timeline row: a marker (launched/finished), a tool the worker reached for,
 * or a line of what it said. */
function agentRow(kind, r, entry) {
  const row = document.createElement('div');
  row.className = 'ag-row ' + kind;

  const time = document.createElement('span');
  time.className = 'ag-time';
  time.textContent = agentOffset(r, entry && entry.at);
  row.appendChild(time);

  const mark = document.createElement('span');
  mark.className = 'ag-mark';
  mark.setAttribute('aria-hidden', 'true');
  row.appendChild(mark);

  const body = document.createElement('div');
  body.className = 'ag-body';
  if (kind === 'tool') {
    body.innerHTML =
      `<span class="ag-ico" aria-hidden="true">${TOOL_ICON[entry.tool] || '⚙️'}</span>` +
      '<span class="ag-label"></span>';
    body.querySelector('.ag-label').textContent =
      toolLabel(entry.tool) + (entry.target ? ' · ' + entry.target : '');
    if (entry.detail && entry.detail !== entry.target) {
      const d = document.createElement('div');
      d.className = 'ag-detail';
      d.textContent = entry.detail;
      body.appendChild(d);
    }
  } else if (kind === 'text') {
    body.textContent = entry.text;
  } else {
    body.textContent = entry.label;        // marker rows carry their own label
  }
  row.appendChild(body);
  return row;
}

// "+4.2s" since the worker started, so steps can be read as a rhythm.
function agentOffset(r, at) {
  if (!r.startedAt || !at) return '';
  const ms = Math.max(0, at - r.startedAt);
  if (ms < 10000) return '+' + (ms / 1000).toFixed(1) + 's';
  return '+' + fmtDur(ms);
}

function agentNote(text) {
  const d = document.createElement('div');
  d.className = 'ag-note';
  d.textContent = text;
  return d;
}

function renderAgentTimeline(r) {
  const body = els.agentBody;
  body.innerHTML = '';
  if (r.startedAt) {
    body.appendChild(agentRow('marker start', r, { at: r.startedAt, label: tr('agent.launched') }));
  }
  for (const e of r.log) body.appendChild(agentRow(e.kind, r, e));

  if (!r.log.length) {
    body.appendChild(agentNote(r.live ? tr('agent.waiting') : tr('agent.noHistory')));
  }
  if (!r.running) {
    const st = agentState(r);
    const label = st === 'error' ? tr('agent.failedLine')
      : st === 'stopped' ? tr('agent.stoppedLine') : tr('agent.finishedLine');
    body.appendChild(agentRow('marker end ' + st, r, { at: r.endedAt, label }));
  }
  if (r.output != null) body.appendChild(agentReport(r));
}

function agentReport(r) {
  const box = document.createElement('div');
  box.className = 'ag-report' + (r.isError ? ' err' : '');
  const head = document.createElement('div');
  head.className = 'ag-report-head';
  head.textContent = tr('agent.reportLabel');
  box.appendChild(head);
  const pre = document.createElement('pre');
  pre.className = 'ag-pre';
  pre.textContent = r.output || tr('agent.noReport');
  box.appendChild(pre);
  return box;
}

/* The footer: Stop is only real while the owning turn is still streaming, and it
 * says plainly that it ends the whole reply (the CLI can't kill one worker). */
function syncAgentFoot(r) {
  const canStop = r.running && state.live.has(r.threadId);
  els.agentStop.hidden = !canStop;
  els.agentStop.disabled = false;
  els.agentStop.textContent = tr('agent.stopBtn');
  els.agentHint.textContent = canStop ? tr('agent.stopHint') : '';
}

async function stopAgentRun() {
  const r = agentRun(agentOpenId);
  if (!r || !r.running) return;
  els.agentStop.disabled = true;
  els.agentStop.textContent = tr('agent.stopping');
  if (r.threadId === state.activeId) {
    await stopActiveTurn();
  } else {
    const live = state.live.get(r.threadId);
    if (live) live.stopped = true;
    try { await api.stopChat(r.threadId); } catch (_) {}
  }
}

/* A run changed. Chips always refresh; the open panel appends the one new step
 * (cheap, animated) or re-renders when the run's *state* moved. */
function agentRunChanged(r, entry) {
  els.feed.querySelectorAll(`.agent-chip[data-id="${cssEsc(r.id)}"]`)
    .forEach((el) => syncAgentChip(el, r));
  if (agentOpenId !== r.id || els.agentOverlay.hidden) return;

  const wasRunning = els.agentStatus.classList.contains('running');
  if (wasRunning !== (agentState(r) === 'running')) { renderAgentPanel(); agentFollow(); return; }

  updateAgentStats(r);
  if (!entry) return;
  const note = els.agentBody.querySelector('.ag-note');
  if (note) note.remove();
  const row = agentRow(entry.kind, r, entry);
  row.classList.add('enter');
  els.agentBody.appendChild(row);
  while (els.agentBody.querySelectorAll('.ag-row').length > AGENT_LOG_MAX + 2) {
    const oldest = els.agentBody.querySelector('.ag-row:not(.marker)');
    if (!oldest) break;
    oldest.remove();
  }
  agentFollow();
}

/* Timeline auto-follow, same deal as the chat feed: the wheel decides (it fires
 * before the scroll lands, so it can't be clobbered by our own scrolling), and
 * coming back to rest at the bottom re-attaches. */
function agentFollow() { if (agentStick) els.agentBody.scrollTop = els.agentBody.scrollHeight; }

els.agentBody.addEventListener('wheel', (e) => { if (e.deltaY < 0) agentStick = false; }, { passive: true });
els.agentBody.addEventListener('scroll', () => {
  const b = els.agentBody;
  if (b.scrollHeight - b.scrollTop - b.clientHeight < 24) agentStick = true;
}, { passive: true });

els.agentClose.onclick = closeAgentPanel;
els.agentDone.onclick = closeAgentPanel;
els.agentStop.onclick = stopAgentRun;

// Backdrop click closes — unless the release just ended a text drag-select
// (same guard as the Activity / Initialize modals).
let agentPressOnBackdrop = false;
els.agentOverlay.addEventListener('mousedown', (e) => { agentPressOnBackdrop = (e.target === els.agentOverlay); });
els.agentOverlay.addEventListener('mouseup', (e) => {
  if (agentPressOnBackdrop && e.target === els.agentOverlay) closeAgentPanel();
  agentPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.agentOverlay.hidden) closeAgentPanel();
});
