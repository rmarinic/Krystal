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
  els.activityBtn.disabled = n === 0;
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
  if (!state.activity.length) {
    body.innerHTML = `<div class="activity-empty">${tr('activity.empty')}</div>`;
    return;
  }
  const list = state.activity.filter((a) => activityMatches(a, state.activityFilter));
  if (!list.length) {
    const msg = state.activityFilter === 'active' ? tr('activity.emptyActive') : tr('activity.emptyClosed');
    body.innerHTML = `<div class="activity-empty">${msg}</div>`;
    return;
  }
  body.innerHTML = '';
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
    const pre = document.createElement('pre');
    pre.className = 'activity-out' + (a.isError ? ' err' : '');
    pre.textContent = a.output != null
      ? (a.output || tr('activity.noOutput'))
      : (a.running ? tr('activity.running') : tr('activity.noCapture'));
    item.appendChild(pre);
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

