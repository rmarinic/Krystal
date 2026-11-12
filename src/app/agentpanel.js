/* agentpanel.js — the agent inspector's window: one sub-agent's run, live.
   The runs themselves live in agents.js. Part of the chat frontend; shares one
   global scope (see core.js). */
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
    paintAgentNow(r);
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

/* A worker's silence worth a mention: shorter gaps are just its pace. */
const AGENT_GAP_SHOW_MS = 30000;
const AGENT_QUIET_HINT_MS = 60000;   // …and when the "right now" line explains itself
const AGENT_SIZE_SHOW = 4096;        // a step that wrote this much says how much

/* The small line under a step that says what its arrival cost: a thought the
 * worker took a while over, the minutes a big file took to write. Empty when the
 * step came at the worker's usual pace. Pure (tested). */
function agentGapText(entry) {
  if (!entry) return '';
  const long = entry.gapMs >= AGENT_GAP_SHOW_MS;
  const d = fmtDur(entry.gapMs || 0);
  if (entry.kind === 'thinking') return long ? tr('agent.thought', { d }) : '';
  const kb = entry.chars >= AGENT_SIZE_SHOW ? Math.round(entry.chars / 1024) : 0;
  if (long && kb) return tr('agent.wroteIn', { n: kb, d });
  if (long) return tr('agent.tookIn', { d });
  return kb ? tr('agent.size', { n: kb }) : '';
}

/* What the worker is doing *right now*, for the line at the foot of a running
 * timeline. A sub-agent streams nothing between steps, so this is read off the
 * last thing it did: a tool still out is that tool running; otherwise it is
 * thinking or writing its next step, which lands whole when it's done. A wait
 * for the API says so instead. Pure (tested): { label, meta, hint, tone }. */
function agentNowLine(r, now) {
  const retry = retryLineText(r.retry, now);
  if (retry) return { ...retry, hint: tr('agent.retryHint') };
  const out = agentToolOut(r);
  if (out) {
    const ms = Math.max(0, now - out.at);
    return { label: toolLabel(out.tool), meta: fmtDur(ms), tone: 'live',
      hint: ms >= AGENT_QUIET_HINT_MS ? tr('agent.nowToolHint') : '' };
  }
  const ms = Math.max(0, now - (r.heardAt || r.startedAt || now));
  return { label: tr('agent.nowComposing'), meta: tr('agent.nowSince', { d: fmtDur(ms) }), tone: 'think',
    hint: ms >= AGENT_QUIET_HINT_MS ? tr('agent.quietHint') : '' };
}

/* Keep the "right now" line at the foot of the timeline (or gone, once the run
 * isn't running). Writes only what changed, every second from the tick. */
function paintAgentNow(r) {
  const body = els.agentBody;
  let el = body.querySelector('.ag-now');
  if (!r.running) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'ag-now';
    el.innerHTML = '<div class="ag-now-head"><span class="ag-now-label"></span>' +
      '<span class="ag-now-meta"></span></div><div class="ag-now-hint"></div>';
  }
  if (body.lastElementChild !== el) body.appendChild(el);
  const t = agentNowLine(r, Date.now());
  const set = (sel, text) => {
    const n = el.querySelector(sel);
    if (n.textContent !== text) n.textContent = text;
  };
  set('.ag-now-label', t.label);
  set('.ag-now-meta', t.meta);
  set('.ag-now-hint', t.hint || '');
  el.dataset.tone = t.tone;
}

/* One timeline row: a marker (launched/finished), a tool the worker reached for,
 * a line of what it said, or a long thought (a short one isn't a row: null). */
function agentRow(kind, r, entry) {
  if (kind === 'thinking' && !agentGapText(entry)) return null;
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
      `<span class="ag-ico" aria-hidden="true">${toolIcon(entry.tool)}</span>` +
      '<span class="ag-label"></span>';
    body.querySelector('.ag-label').textContent =
      toolLabel(entry.tool) + (entry.target ? ' · ' + entry.target : '');
    if (entry.toolId) row.dataset.tool = entry.toolId;
    if (entry.detail && entry.detail !== entry.target) {
      const d = document.createElement('div');
      d.className = 'ag-detail';
      d.textContent = entry.detail;
      body.appendChild(d);
    }
    agentStepFile(body, entry);
    if (entry.output != null) body.appendChild(agentStepOutput(entry));
  } else if (kind === 'text') {
    body.textContent = entry.text;
  } else if (kind === 'thinking') {
    body.textContent = agentGapText(entry);
  } else {
    body.textContent = entry.label;        // marker rows carry their own label
  }
  const gap = kind === 'tool' || kind === 'text' ? agentGapText(entry) : '';
  if (gap) {
    const g = document.createElement('div');
    g.className = 'ag-took';
    g.textContent = gap;
    body.appendChild(g);
  }
  row.appendChild(body);
  return row;
}

/* A step that read or wrote a file: Show in folder / Open, as on the transcript's
 * chips (chips.js), and an image shown right there, so you see what the worker
 * is looking at; a click opens it full-size (lightbox.js). */
function agentStepFile(body, entry) {
  const path = entry.detail;
  if (!path || !FILE_TOOLS.has(entry.tool)) return;
  body.appendChild(chipFileActs(path));
  if (!isImagePath(path)) return;
  const img = buildImagePreview(path);
  img.classList.add('ag-img');
  body.appendChild(img);
  loadChipImages(body, agentFollow);
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
  for (const e of r.log) {
    const row = agentRow(e.kind, r, e);
    if (row) body.appendChild(row);
  }

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
  paintAgentNow(r);
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

/* The background job this run is, if the reply is waiting on it: only such a
 * worker can be stopped on its own (`stop_job`, background.js). */
function agentJob(r) {
  const live = state.live.get(r.threadId);
  const jobs = (live && live.background && live.background.jobs) || [];
  return jobs.find((j) => j.id === r.id && j.task) || null;
}

/* The footer: Stop is only real while the owning turn is still streaming. A
 * background worker stops on its own; any other ends the whole reply, and the
 * hint says which. */
function syncAgentFoot(r) {
  const canStop = r.running && state.live.has(r.threadId);
  els.agentStop.hidden = !canStop;
  els.agentStop.disabled = false;
  els.agentStop.textContent = tr('agent.stopBtn');
  els.agentHint.textContent = !canStop ? '' : tr(agentJob(r) ? 'agent.stopJobHint' : 'agent.stopHint');
}

async function stopAgentRun() {
  const r = agentRun(agentOpenId);
  if (!r || !r.running) return;
  els.agentStop.textContent = tr('agent.stopping');
  const job = agentJob(r);
  if (job) {
    let ok = false;
    try { ok = !!(await api.stopJob(r.threadId, job.task)).ok; } catch (_) {}
    if (ok) return;   // its end arrives as the turn's next `background` list
  }
  // Shares the composer's escalation: the button stays live on purpose, so a
  // second press turns the polite interrupt into a kill (see stream.js).
  await stopTurn(r.threadId);
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
  if (row) {
    row.classList.add('enter');
    els.agentBody.appendChild(row);
  }
  paintAgentNow(r);                       // back to the foot, and reset to the new step
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
  // An image opened from a step closes first (lightbox.js handles that Esc).
  if (e.key === 'Escape' && !els.agentOverlay.hidden
      && !(els.lightboxOverlay && !els.lightboxOverlay.hidden)) closeAgentPanel();
});
