/* background.js — what a reply is waiting on, while it waits
   Part of the chat frontend; shares one global scope (see core.js).

   When Claude hands work to a background helper agent or a background command
   and ends its answer, the reply stays open until that work reports back,
   sometimes for many minutes with nothing else on the wire. A bare "Waiting for
   background work" can't tell busy from hung, so under the working line each job
   gets a row of its own: what it is, how long it has run, what it is doing right
   now, and when it last gave a sign of life.

   Every word answers something real. A helper's step is the latest one it took
   (its run in agents.js, fed by `agent_activity`/`agent_progress`), or the tool
   it is still waiting on with that tool's own clock; a command's is the last line
   it printed (the backend's `job_activity`, sent each time its output file grows).
   The row's dot brightens once on each such sign and is otherwise still; the
   clocks move because time does. A job silent for BG_STALE_MS turns amber and
   still, the colour of "needs you", and offers to check on it or stop it, worded
   by what the silence probably is. Stop ends that one job (`stop_job`); the reply
   and the other jobs keep going. A row opens to the helper's last few steps, or
   the end of the command's output, without leaving the conversation.

   The backend sends the list (`background`) whenever it changes; the working line
   (working.js) owns the panel and repaints it on its one-second clock. The words
   are the pure `bgJobView`, tested in tests/background.test.js. */

const BG_STALE_MS = 10 * 60 * 1000;   // silent this long: amber, offer to check or stop
const BG_NOW_MS = 5000;               // a sign of life this recent reads "just now"
const BG_STEPS = 5;                   // a helper's steps shown when its row is open
const BG_TAIL_LINES = 12;             // …and a command's output lines
const BG_LINE_CHARS = 140;
const bgOpen = new Set();             // job ids whose row is open (survives a repaint or a chat switch)
const bgStopping = new Set();         // job ids a Stop was sent for
const bgPanels = new Set();           // the panels on screen, for beats

/* The jobs of a `background` event on this clock. The backend sends ages, not
 * times (a phone's clock may differ from the computer's); what a job printed
 * so far is kept from the list before. */
function bgFromEvent(msg, prev, threadId, now) {
  const old = new Map(((prev && prev.jobs) || []).map((j) => [j.id, j]));
  const jobs = (Array.isArray(msg.jobs) ? msg.jobs : []).map((j) => {
    const was = old.get(j.id);
    return {
      id: j.id || '', task: j.task || '', kind: j.kind === 'shell' ? 'shell' : 'agent',
      description: j.description || '', owner: j.owner || null,
      startedAt: was ? was.startedAt : now - Math.max(0, Number(j.ageMs) || 0),
      tail: was ? was.tail : '', tailAt: was ? was.tailAt : null,
    };
  });
  return { running: Number(msg.running) || 0, jobs, threadId };
}

/* A command printed more: keep the end of it, and say so on its row. */
function bgJobActivity(bg, msg, now) {
  const job = bg && bg.jobs.find((j) => j.id === msg.id);
  if (!job) return;
  job.tail = msg.tail || '';
  job.tailAt = now;
  bgBeat(job.id);
}

/* The last non-empty line of a command's output, cut to fit a row. */
function bgLastLine(tail) {
  const lines = String(tail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.length > BG_LINE_CHARS ? last.slice(0, BG_LINE_CHARS - 1) + '…' : last;
}

/* The first line of something a helper said, cut to fit a row. */
function bgFirstLine(text) {
  const line = String(text || '').trim().split(/\r?\n/)[0].trim();
  return line.length > BG_LINE_CHARS ? line.slice(0, BG_LINE_CHARS - 1) + '…' : line;
}

/* What one job's row says. `run` is the helper's run (agents.js), null for a
 * command. Returns { title, clock, step, mono, last, tone, warn, check }:
 * tone is 'live' or 'stale' (amber); `warn` the line that explains a silence;
 * `check` what "Check on it" does ('inspect' a helper, 'open' a command's row). */
function bgJobView(job, run, now) {
  const shell = job.kind === 'shell';
  const title = job.description || (run && run.description) || tr(shell ? 'bg.kind.shell' : 'bg.kind.agent');
  const clock = fmtDur(Math.max(0, now - job.startedAt));
  let step = '';
  let mono = false;
  let warn = '';
  let lastAt;
  let quietOk = false;   // the silence is explained (an API wait), so it isn't a warning
  if (shell) {
    lastAt = job.tailAt || job.startedAt;
    step = bgLastLine(job.tail);
    mono = !!step;
    if (!step) step = tr('bg.noOutput');
  } else {
    lastAt = Math.max(job.startedAt, (run && run.heardAt) || 0);
    const retry = run && retryLineText(run.retry, now);
    const out = run && agentToolOut(run);
    const said = run && [...run.log].reverse().find((e) => e.kind === 'text' || e.kind === 'tool');
    if (retry) {
      step = retry.label + ' · ' + retry.meta;
      quietOk = true;
    } else if (out) {
      step = [toolLabel(out.tool), out.target, fmtDur(Math.max(0, now - out.at))].filter(Boolean).join(' · ');
    } else if (said && said.kind === 'text') {
      step = bgFirstLine(said.text);
    } else if (run && run.now) {
      step = run.now;
    } else if (said) {
      step = [toolLabel(said.tool), said.target].filter(Boolean).join(' · ');
    } else {
      step = tr('bg.starting');
    }
    if (out && now - lastAt >= BG_STALE_MS) warn = tr('bg.staleTool', { tool: toolLabel(out.tool), d: fmtDur(now - out.at) });
  }
  const quiet = now - lastAt;
  const last = quiet < BG_NOW_MS ? tr('bg.lastNow')
    : tr(shell ? 'bg.lastOutput' : 'bg.last', { d: fmtDur(quiet) });
  const stale = !quietOk && quiet >= BG_STALE_MS;
  if (stale && !warn) warn = tr(shell ? 'bg.staleShell' : 'bg.staleQuiet', { d: fmtDur(quiet) });
  return {
    title, clock, step, mono,
    last: shell && !job.tailAt ? '' : last,
    tone: stale ? 'stale' : 'live',
    warn: stale ? warn : '',
    check: shell ? 'open' : 'inspect',
  };
}

/* ------------------------------- the panel ------------------------------- */

/* The rows under a working line (`after`). Returns { set, paint, beat, remove }. */
function makeBgPanel(after) {
  const el = document.createElement('div');
  el.className = 'bg-jobs';
  after.after(el);
  const rows = new Map();   // job id -> row element
  let bg = null;
  const panel = {
    el,
    has: (id) => rows.has(id),
    // A new list: rows come and go (a new one enters, a finished one fades).
    set(next) {
      bg = next;
      const ids = new Set(bg.jobs.map((j) => j.id));
      for (const [id, row] of rows) {
        if (ids.has(id)) continue;
        rows.delete(id);
        bgStopping.delete(id);
        bgRowGone(row);
      }
      for (const job of bg.jobs) {
        let row = rows.get(job.id);
        if (!row) {
          row = bgRow(job, () => bg);
          rows.set(job.id, row);
          if (motionOK()) replayClass(row, 'enter', 400);
        }
        row._job = job;
        const parent = job.owner && rows.get(job.owner);
        const home = parent ? parent.querySelector('.bg-kids') : el;
        if (row.parentNode !== home) home.appendChild(row);
      }
      panel.paint(Date.now());
    },
    paint(now) {
      for (const row of rows.values()) bgPaintRow(row, now);
    },
    beat(id) {
      const row = rows.get(id);
      const dot = row && row.querySelector(':scope > .bg-head .bg-dot');
      if (!dot || row.dataset.tone === 'stale' || !motionOK()) return;
      const t = Date.now();
      if (t - (row._beatAt || 0) < WORK_BEAT_MS) return;
      row._beatAt = t;
      replayClass(dot, 'beat', 700);
    },
    remove() {
      bgPanels.delete(panel);
      el.remove();
    },
  };
  bgPanels.add(panel);
  return panel;
}

/* A job gave a sign of life: its dot brightens once, wherever it is shown. */
function bgBeat(id) {
  if (!id) return;
  bgPanels.forEach((p) => { if (p.has(id)) p.beat(id); });
}

/* One job's row: head (dot, kind, title, clock, caret), what it's doing now,
 * the warning, and what opens under it. `getBg` gives the turn's current list. */
function bgRow(job, getBg) {
  const row = document.createElement('div');
  row.className = 'bg-job';
  row.dataset.kind = job.kind;
  row.innerHTML =
    '<button type="button" class="bg-head">' +
      '<span class="bg-dot" aria-hidden="true"></span>' +
      `<span class="bg-ico" aria-hidden="true">${icon(job.kind === 'shell' ? 'terminal' : 'agent')}</span>` +
      '<span class="bg-title"></span><span class="bg-clock"></span>' +
      '<span class="bg-caret" aria-hidden="true">▸</span>' +
    '</button>' +
    '<div class="bg-sub"><span class="bg-step"></span><span class="bg-last"></span></div>' +
    '<div class="bg-warn" hidden><span class="bg-warn-text"></span>' +
      '<button type="button" class="bg-act bg-check"></button>' +
      '<button type="button" class="bg-act bg-stop"></button></div>' +
    '<div class="bg-more" hidden></div>' +
    '<div class="bg-kids"></div>';
  row._getBg = getBg;
  row.querySelector('.bg-head').onclick = () => bgToggle(row);
  row.querySelector('.bg-check').onclick = () => {
    if (row._job.kind === 'shell') bgToggle(row, true);
    else openAgentPanel(row._job.id);
  };
  row.querySelector('.bg-stop').onclick = () => bgStop(row);
  return row;
}

function bgToggle(row, open) {
  const id = row._job.id;
  const on = open == null ? !bgOpen.has(id) : open;
  if (on) bgOpen.add(id); else bgOpen.delete(id);
  bgPaintRow(row, Date.now());
}

/* Repaint a row, writing only what changed (this runs every second). */
function bgPaintRow(row, now) {
  const job = row._job;
  const run = job.kind === 'agent' ? agentRun(job.id) : null;
  const v = bgJobView(job, run, now);
  const set = (sel, text) => {
    const n = row.querySelector(sel);
    if (n.textContent !== text) n.textContent = text;
  };
  set('.bg-title', v.title);
  set('.bg-clock', v.clock);
  set('.bg-step', v.step);
  set('.bg-last', v.last);
  row.querySelector('.bg-step').classList.toggle('mono', v.mono);
  if (row.dataset.tone !== v.tone) row.dataset.tone = v.tone;
  const warn = row.querySelector(':scope > .bg-warn');
  warn.hidden = !v.warn;
  if (v.warn) {
    set('.bg-warn-text', v.warn);
    set('.bg-check', tr('bg.check'));
  }
  bgPaintStops(row);
  const open = bgOpen.has(job.id);
  row.classList.toggle('open', open);
  row.querySelector(':scope > .bg-head').setAttribute('aria-expanded', String(open));
  const more = row.querySelector(':scope > .bg-more');
  more.hidden = !open;
  if (open) bgPaintMore(row, more, run);
}

/* What an open row shows: a helper's last steps (and a way to its inspector),
 * or the end of a command's output; both with Stop. Rebuilt only when what it
 * shows has changed. */
function bgPaintMore(row, more, run) {
  const job = row._job;
  const key = job.kind === 'shell' ? job.tail : (run ? run.log.length + ':' + run.log.filter((e) => e.output != null).length : '');
  if (more._key === key && more.firstChild) return;
  more._key = key;
  more.innerHTML = '';
  if (job.kind === 'shell') {
    const pre = document.createElement('pre');
    pre.className = 'bg-tail';
    const lines = String(job.tail || '').split(/\r?\n/);
    pre.textContent = job.tail ? lines.slice(-BG_TAIL_LINES).join('\n') : tr('bg.noOutput');
    more.appendChild(pre);
  } else {
    const steps = run ? run.log.filter((e) => e.kind === 'tool' || e.kind === 'text').slice(-BG_STEPS) : [];
    const list = document.createElement('div');
    list.className = 'bg-steps';
    if (!steps.length) list.textContent = tr('bg.noSteps');
    for (const e of steps) {
      const line = document.createElement('div');
      line.className = 'bg-step-row' + (e.isError ? ' err' : '') + (e.kind === 'tool' && e.output == null ? ' out' : '');
      line.innerHTML = `<span class="bg-step-ico" aria-hidden="true">${e.kind === 'tool' ? toolIcon(e.tool) : icon('agent')}</span>` +
        '<span class="bg-step-text"></span>';
      line.querySelector('.bg-step-text').textContent = e.kind === 'tool'
        ? [toolLabel(e.tool), e.target].filter(Boolean).join(' · ')
        : bgFirstLine(e.text);
      list.appendChild(line);
    }
    more.appendChild(list);
  }
  const acts = document.createElement('div');
  acts.className = 'bg-acts';
  if (job.kind === 'agent') {
    const insp = document.createElement('button');
    insp.type = 'button';
    insp.className = 'bg-act';
    insp.textContent = tr('bg.inspect');
    insp.onclick = () => openAgentPanel(job.id);
    acts.appendChild(insp);
  }
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'bg-act bg-stop';
  stop.onclick = () => bgStop(row);
  acts.appendChild(stop);
  more.appendChild(acts);
  bgPaintStops(row);
}

/* Bring every Stop button in a row up to date, writing only what changed. */
function bgPaintStops(row) {
  const stopping = bgStopping.has(row._job.id);
  const label = tr(stopping ? 'bg.stopping' : 'bg.stop');
  // Its own buttons only: a helper's row holds its commands' rows too.
  row.querySelectorAll(':scope > .bg-warn .bg-stop, :scope > .bg-more .bg-stop').forEach((b) => {
    if (b.textContent !== label) b.textContent = label;
    b.disabled = stopping;
    b.title = tr('bg.stopTitle');
  });
}

/* Stop just this job. Its row goes when the backend's list no longer has it;
 * until then the button says it is on its way. */
async function bgStop(row) {
  const job = row._job;
  const bg = row._getBg();
  if (!bg || !job.task || bgStopping.has(job.id)) return;
  bgStopping.add(job.id);
  bgPaintStops(row);
  let ok = false;
  try { ok = !!(await api.stopJob(bg.threadId, job.task)).ok; } catch (_) {}
  if (!ok) {
    bgStopping.delete(job.id);
    bgPaintStops(row);
    showTip({ key: 'status', icon: 'alert', label: tr('bg.stop'), body: tr('bg.stopFailed') });
  }
}

/* A finished job's row fades and goes (at once under reduced motion). */
function bgRowGone(row) {
  if (!motionOK()) { row.remove(); return; }
  row.classList.add('out');
  setTimeout(() => row.remove(), 300);
}

// The words are in the language of the moment.
document.addEventListener('i18n:changed', () => bgPanels.forEach((p) => p.paint(Date.now())));
