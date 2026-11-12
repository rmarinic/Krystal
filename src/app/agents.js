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
      heardAt: null,      // the last time the worker gave any sign (agentHeard)
      now: '',            // the CLI's word on its current step ("Running the tests")
      retry: null,        // a wait for the API the turn is in (agentRetrySeen)
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
 * their parent's run and get no inspector of their own.
 *
 * A shell chip is never adopted: the CLI reports every shell command as a task of
 * its own now, and taking that for delegation turned each command's chip into an
 * empty agent window. (The backend no longer forwards those; this keeps it so.) */
function adoptAgentRun(id) {
  const known = agentRun(id);
  if (known) return known;
  const chip = els.feed.querySelector(`.action-chip[data-id="${cssEsc(id)}"]`);
  if (!chip || isShellTool((chip._seg && chip._seg.name) || chip.dataset.tool)) return null;
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
  if (ico) ico.innerHTML = icon('agent');
  const caret = row.querySelector('.chip-caret');
  if (caret) caret.remove();
  if (!row.querySelector('.chip-tally')) {
    const tally = document.createElement('span');
    tally.className = 'chip-tally';
    row.appendChild(tally);
  }
  if (!row.querySelector('.chip-time')) {
    const time = document.createElement('span');
    time.className = 'chip-time';
    row.appendChild(time);
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
  // The CLI's description moves with the work ("Reading README.txt"); the run's
  // is the brief it was given, which the timeline below it is the story of. Only
  // fill it if we never got the brief.
  if (msg.description && !r.description) r.description = msg.description;
  // …while a progress report's description is that step itself, which is what
  // the waiting panel under the reply says the worker is doing (background.js).
  if (msg.phase === 'progress' && msg.description) r.now = msg.description;
  if (msg.lastTool) r.lastTool = msg.lastTool;
  if (msg.toolUses != null) r.toolUses = msg.toolUses;
  if (msg.tokens != null) r.tokens = msg.tokens;
  if (msg.durationMs != null) r.durationMs = msg.durationMs;
  if (!r.endedAt) r.running = true;      // a straggler must not un-finish a run
  agentHeard(r);
  agentRunChanged(r);
}

/* The worker gave a sign of life. A sub-agent streams nothing while it thinks
 * or writes: each step arrives whole once it's done, so the time since the last
 * sign is how long the step now in the making has taken (agentpanel.js). */
function agentHeard(r, at) {
  r.heardAt = at || Date.now();
}

/* The tool call the worker is waiting on, if any: of the calls at the end of
 * its log (newest last), the earliest one still out (parallel calls come back
 * in any order). Its output arrives only when it returns, so this is what a
 * long silence is, when it is anything. */
function agentToolOut(r) {
  let out = null;
  for (let i = r.log.length - 1; i >= 0 && r.log[i].kind === 'tool'; i--) {
    if (r.log[i].output == null && r.log[i].toolId) out = r.log[i];
  }
  return out;
}

/* The API refused a request and the CLI is waiting to try again (`api_retry`,
 * with the note `apiRetryNote` made of it). The CLI doesn't say which agent is
 * waiting, so every worker of that turn still out carries it until it passes. */
function agentRetrySeen(threadId, note) {
  for (const r of agentRuns.values()) {
    if (r.threadId === threadId && r.running) r.retry = note;
  }
}

/* One line of what the worker is saying or doing right now → the timeline. */
function agentActivitySeen(msg) {
  if (!msg || !msg.id) return;
  const r = adoptAgentRun(msg.id);
  if (!r) return;
  // What a step came back with belongs to that step, not on a line of its own.
  if (msg.kind === 'result') return agentStepResult(r, msg);
  const at = Date.now();
  const entry = {
    kind: msg.kind === 'tool' || msg.kind === 'thinking' ? msg.kind : 'text',
    tool: msg.tool || '', target: msg.target || '', detail: msg.detail || '',
    toolId: msg.toolId || '', output: null, isError: false,
    text: msg.text || '', at,
    chars: Number(msg.chars) || 0,
    // How long this step was in the making: since the worker's last sign.
    gapMs: Math.max(0, at - (r.heardAt || r.startedAt || at)),
  };
  agentHeard(r, at);
  r.log.push(entry);
  while (r.log.length > AGENT_LOG_MAX) r.log.shift();
  agentRunChanged(r, entry);
}

/* One of the worker's own tools returned: fold the output into the step that ran
 * it (newest first — the step is almost always the last one or two). */
function agentStepResult(r, msg) {
  let step = null;
  for (let i = r.log.length - 1; i >= 0 && !step; i--) {
    if (r.log[i].toolId && r.log[i].toolId === msg.toolId) step = r.log[i];
  }
  if (!step) return;
  step.output = msg.text || '';
  step.isError = !!msg.isError;
  agentHeard(r);
  if (agentOpenId !== r.id || els.agentOverlay.hidden) return;
  const row = els.agentBody.querySelector(`.ag-row[data-tool="${cssEsc(step.toolId)}"] .ag-body`);
  if (!row || row.querySelector('.ag-out')) return;
  row.appendChild(agentStepOutput(step));
  agentFollow();
}

/* A step's output, folded away by default so the timeline still reads as a list
 * of steps — open the one you care about. */
function agentStepOutput(entry) {
  const d = document.createElement('details');
  d.className = 'ag-out' + (entry.isError ? ' err' : '');
  const sum = document.createElement('summary');
  sum.textContent = tr('chip.outputLabel');
  const pre = document.createElement('pre');
  pre.textContent = entry.output || tr('agent.noOutput');
  d.append(sum, pre);
  return d;
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
    `<span class="chip-status" aria-hidden="true">${CHIP_TICK_SVG}</span>` +
    `<span class="chip-ico" aria-hidden="true">${icon('agent')}</span>` +
    `<span class="chip-label">${escapeHtml(toolLabel(seg.name || 'Agent') + (seg.target ? ' · ' + seg.target : ''))}</span>` +
    '<span class="chip-tally"></span>' +
    '<span class="chip-time"></span>' +
    '<span class="chip-open" aria-hidden="true">⤢</span>';
  el.appendChild(row);
  row.onclick = () => openAgentPanel(seg.id);
  syncAgentChip(el, r);
  return el;
}

/* Keep a chip's tally + status in step with its run. Its clock is the run's own
 * (the same reading the inspector's elapsed tile gives), on the shared chip
 * clock (messages.js) so it ticks while the worker does. */
function syncAgentChip(el, r) {
  const tally = el.querySelector('.chip-tally');
  if (tally) tally.textContent = agentTally(r);
  if (r.startedAt) {
    const t = chipTime(r.id);
    t.start = r.endedAt ? r.endedAt - agentElapsed(r) : Date.now() - agentElapsed(r);
    t.end = r.endedAt || null;
  }
  const st = agentState(r);
  const finishing = st !== 'running' && el.classList.contains('working');
  el.classList.toggle('working', st === 'running');
  el.classList.toggle('done', st !== 'running');
  el.classList.toggle('error', st === 'error');
  if (finishing && st !== 'error') replayClass(el, 'just-done', 500);   // draws its check (motion.css)
  paintChipTime(el);
  if (st === 'running') startChipClock();
}

/* Refresh every agent chip on screen from the store (used after a thread switch
 * replays a live turn's chips). */
function refreshAgentChips() {
  els.feed.querySelectorAll('.agent-chip[data-id]').forEach((el) => {
    const r = agentRun(el.dataset.id);
    if (r) syncAgentChip(el, r);
  });
}
