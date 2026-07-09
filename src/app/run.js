/* run.js        — RUN button: start the project locally for testing + live output.
   Part of the chat frontend; shares one global scope (see core.js).

   Each project stores ONE run command (set by hand or detected by Claude). The
   little RUN button under the logo starts/stops that command in the project
   folder; a modal streams its stdout/stderr live. First click with no command
   set opens a small setup panel instead. The process is tracked by the backend
   keyed on the project path, so it survives the panel being closed. */

const runState = {
  command: '',      // last known command for the active project
  running: false,
  buffer: [],       // [{ text, cls }] output lines, kept so reopening shows history
  channel: null,    // live Channel while a run is streaming into this window
  pid: 0,
  outEl: null,      // the mounted <pre> (or null when not showing the output view)
  statusDot: null,
  statusLabel: null,
};

const runCwd = () => state.project && state.project.path;

/* ----------------------------- button state ------------------------------ */

/* Reflect running/idle on the little sidebar button (play ⇄ stop). */
function setRunBtn(running) {
  runState.running = running;
  const b = els.runBtn;
  if (!b) return;
  b.classList.toggle('running', running);
  const label = b.querySelector('.run-label');
  if (label) label.textContent = running ? tr('run.running') : tr('run.btn');
  b.title = running ? tr('run.viewTitle') : tr('run.btnTitle');
}

/* Sync the button when a project is opened/switched — a run may already be in
   flight for that folder (started earlier, panel since closed). */
async function refreshRunBtn() {
  if (!runCwd()) { setRunBtn(false); runState.command = ''; return; }
  try {
    const cfg = await api.getRunConfig(runCwd());
    runState.command = cfg.command || '';
    setRunBtn(!!cfg.running);
  } catch (_) { setRunBtn(false); }
}

/* ------------------------------- click flow ------------------------------ */

async function onRunClick() {
  if (!runCwd()) return;
  // Already running → reopen the live output panel so you can watch it (Stop
  // lives inside the panel). This keeps the button re-clickable after a start.
  if (runState.running) { openRunPanel('output'); return; }
  let cfg;
  try { cfg = await api.getRunConfig(runCwd()); } catch (_) { cfg = { command: '' }; }
  runState.command = cfg.command || '';
  if (!runState.command) { openRunPanel('setup'); return; }   // first run: set it up
  startRun(runState.command);
}

function openRunPanel(mode, prefill) {
  openOverlay(els.runOverlay);
  if (mode === 'setup') renderSetup(prefill != null ? prefill : runState.command);
  else renderOutput();
}

/* ------------------------------- setup view ------------------------------ */

function renderSetup(prefill) {
  runState.outEl = null;
  const body = els.runBody;
  body.innerHTML =
    `<div class="run-intro">${escapeHtml(tr('run.intro'))}</div>` +
    `<div class="run-field-label">${escapeHtml(tr('run.cmdLabel'))}</div>` +
    `<textarea class="run-cmd-input" rows="1" spellcheck="false" ` +
      `placeholder="${escapeHtml(tr('run.cmdPlaceholder'))}"></textarea>` +
    `<div class="run-detect-row">` +
      `<button class="run-detect" type="button">${escapeHtml(tr('run.detect'))}</button>` +
      `<span class="run-detect-status"></span>` +
    `</div>` +
    `<div class="run-path-hint">${escapeHtml(tr('run.hintCmd', { path: runCwd() || '' }))}</div>`;

  const input = body.querySelector('.run-cmd-input');
  input.value = prefill || '';
  const detectBtn = body.querySelector('.run-detect');
  const statusEl = body.querySelector('.run-detect-status');

  // "Let Claude figure it out": inspect the project and pre-fill a command.
  detectBtn.onclick = async () => {
    detectBtn.disabled = true;
    statusEl.classList.remove('err');
    statusEl.textContent = tr('run.detecting');
    try {
      const r = await api.detectRunCommand(runCwd());
      if (r && r.command) {
        input.value = r.command;
        statusEl.textContent = tr('run.detected');
        input.focus();
      } else {
        statusEl.classList.add('err');
        statusEl.textContent = tr('run.detectFail');
      }
    } catch (_) {
      statusEl.classList.add('err');
      statusEl.textContent = tr('run.detectFail');
    } finally {
      detectBtn.disabled = false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCommand(input.value, true); }
  });

  els.runFoot.innerHTML =
    `<button class="run-act" data-act="cancel">${escapeHtml(tr('run.cancel'))}</button>` +
    `<button class="run-act" data-act="save">${escapeHtml(tr('run.save'))}</button>` +
    `<button class="run-act primary" data-act="saverun">${escapeHtml(tr('run.saveRun'))}</button>`;
  els.runFoot.querySelector('[data-act="cancel"]').onclick = () => closeOverlay(els.runOverlay);
  els.runFoot.querySelector('[data-act="save"]').onclick = () => saveCommand(input.value, false);
  els.runFoot.querySelector('[data-act="saverun"]').onclick = () => saveCommand(input.value, true);
  setTimeout(() => input.focus(), 30);
}

async function saveCommand(value, thenRun) {
  const cmd = (value || '').trim();
  if (!cmd) {
    const s = els.runBody.querySelector('.run-detect-status');
    if (s) { s.classList.add('err'); s.textContent = tr('run.needCmd'); }
    return;
  }
  runState.command = cmd;
  try { await api.setRunConfig(runCwd(), cmd); } catch (_) {}
  if (thenRun) startRun(cmd);
  else closeOverlay(els.runOverlay);
}

/* ------------------------------ output view ------------------------------ */

function renderOutput() {
  const body = els.runBody;
  body.innerHTML =
    `<div class="run-status-row">` +
      `<span class="run-dot"></span>` +
      `<span class="run-status-label"></span>` +
    `</div>` +
    `<pre class="run-output" tabindex="0"></pre>`;
  runState.outEl = body.querySelector('.run-output');
  runState.statusDot = body.querySelector('.run-dot');
  runState.statusLabel = body.querySelector('.run-status-label');
  if (runState.buffer.length) {
    for (const l of runState.buffer) mountLine(l.text, l.cls);
  } else {
    mountLine(tr('run.waiting'), 'sys');
  }
  updateRunStatus(runState.running ? 'running' : 'stopped');
  scrollRunOutput();
  renderOutputFoot();
}

function renderOutputFoot() {
  els.runFoot.innerHTML =
    `<button class="run-act" data-act="edit">${escapeHtml(tr('run.edit'))}</button>` +
    (runState.running
      ? `<button class="run-act danger" data-act="stop">${escapeHtml(tr('run.stopBtn'))}</button>`
      : `<button class="run-act primary" data-act="restart">${escapeHtml(tr('run.restart'))}</button>`);
  const editB = els.runFoot.querySelector('[data-act="edit"]');
  if (editB) editB.onclick = () => renderSetup(runState.command);
  const stopB = els.runFoot.querySelector('[data-act="stop"]');
  if (stopB) stopB.onclick = () => doStop();
  const restartB = els.runFoot.querySelector('[data-act="restart"]');
  if (restartB) restartB.onclick = () => startRun(runState.command);
}

function updateRunStatus(kind) {
  const dot = runState.statusDot, label = runState.statusLabel;
  if (!dot || !label || !document.body.contains(dot)) return;
  dot.classList.remove('live', 'err');
  let text;
  if (kind === 'starting') { dot.classList.add('live'); text = tr('run.starting'); }
  else if (kind === 'running') { dot.classList.add('live'); text = tr('run.running'); }
  else if (kind === 'error') { dot.classList.add('err'); text = tr('run.startFail'); }
  else { text = tr('run.stopped'); }
  label.textContent = text;
}

// Strip ANSI escape sequences and stray carriage returns so the stream reads
// like a clean terminal even when a tool forces colour output.
function cleanLine(s) {
  return String(s == null ? '' : s)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\r$/, '');
}

function mountLine(text, cls) {
  const out = runState.outEl;
  if (!out || !document.body.contains(out)) return;
  const span = document.createElement('span');
  span.className = 'run-line ' + (cls || 'out');
  span.textContent = text;
  out.appendChild(span);
}
function appendRunLine(text, cls) {
  text = cleanLine(text);
  runState.buffer.push({ text, cls });
  if (runState.buffer.length > 2000) runState.buffer.splice(0, runState.buffer.length - 2000);
  mountLine(text, cls);
  scrollRunOutput();
}
function scrollRunOutput() {
  const out = runState.outEl;
  if (out) out.scrollTop = out.scrollHeight;
}

/* ------------------------------ start / stop ----------------------------- */

function startRun(command) {
  const cwd = runCwd();
  if (!cwd) return;
  runState.command = command;
  runState.buffer = [{ text: '▶ ' + command, cls: 'cmd' }];
  openRunPanel('output');
  setRunBtn(true);
  updateRunStatus('starting');

  const ch = new Channel();
  runState.channel = ch;
  ch.onmessage = (ev) => {
    if (!ev) return;
    if (ev.type === 'line') appendRunLine(ev.text, ev.stream === 'err' ? 'err' : 'out');
    else if (ev.type === 'start') { runState.pid = ev.pid; updateRunStatus('running'); }
    else if (ev.type === 'exit') onRunExit(ev.code, false);
  };
  api.runApp(cwd, command, ch).catch((e) => {
    appendRunLine(String((e && e.message) || e), 'err');
    onRunExit(-1, true);
  });
}

function onRunExit(code, failed) {
  setRunBtn(false);
  runState.channel = null;
  updateRunStatus(failed ? 'error' : 'stopped');
  if (failed) appendRunLine(tr('run.startFail'), 'err');
  else appendRunLine(code === 0 ? tr('run.exitedOk') : tr('run.exited', { code }), code === 0 ? 'ok' : 'err');
  renderOutputFoot();
}

async function doStop() {
  if (!runCwd()) return;
  try { await api.stopRun(runCwd()); } catch (_) {}
  // If the live channel is still attached, its `exit` event finalizes state;
  // otherwise (panel reopened without a channel) settle the button now.
  if (!runState.channel) { setRunBtn(false); updateRunStatus('stopped'); renderOutputFoot(); }
}

/* -------------------------------- wiring --------------------------------- */

if (els.runBtn) els.runBtn.onclick = onRunClick;
if (els.runClose) els.runClose.onclick = () => closeOverlay(els.runOverlay);
if (els.runOverlay) {
  els.runOverlay.addEventListener('mousedown', (e) => {
    if (e.target === els.runOverlay) closeOverlay(els.runOverlay);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.runOverlay && !els.runOverlay.hidden) closeOverlay(els.runOverlay);
});
// Keep the button label localized on language switch.
window.addEventListener('i18n:changed', () => setRunBtn(runState.running));
