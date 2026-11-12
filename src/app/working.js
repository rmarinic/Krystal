/* working.js    — the working line under a reply that is still being made
   Part of the chat frontend; shares one global scope (see core.js).

   A turn can go quiet for a long time while still working: Claude writing an
   artifact or a long file is writing that tool call's *input*, and nothing else
   comes down the wire until it's done; a command runs with no output until it
   ends; a sub-agent works somewhere else. A spinning chip only says so if one is
   on screen, and then only for that step. So every live reply carries one quiet
   line under it, from the moment it's sent until it lands: a dot, what Claude is
   doing right now (Thinking / Writing / Working / Waiting for you), and how long
   the turn has been going.

   It answers real things only. The dot is still, and brightens once on each real
   event (a word revealed, a step started or finished, another few KB of a tool
   call's input — the backend's `tool_input`); the clock moves because time does.
   Waiting on a permission prompt it turns amber and holds still, clock and all.
   Between answers, while a background job Claude started (a sub-agent, a long
   build) is still running, it says so — the backend's `background` event —
   until Claude picks the reply back up, and the jobs themselves are listed under
   it, each with its own clock and latest sign of life (background.js).
   When the reply lands the line fades and is gone. The words are a pure function
   of its state (`workLineText`), tested in tests/working.test.js. */

const WORK_BEAT_MS = 300;        // at most one brightening per this long
const WORK_SIZE_FROM = 1000;     // a tool input shows its size from this many characters
const workLines = new Set();     // the lines on screen, for the one shared clock
let workClock = null;

/* What the line says. `w`: { since, phase: 'thinking'|'writing'|'tool'|'background'|'check',
 * tool, chars, jobs, jobKind ('agent'|'shell' when that is all there is), waiting }.
 * Returns { label, meta, tone }. */
function workLineText(w, now) {
  if (w.waiting) return { label: tr('work.waiting'), meta: '', tone: 'wait' };
  const retry = retryLineText(w.retry, now);
  if (retry) return retry;
  if (w.phase === 'check') {
    const meta = [w.tool];
    if (w.since) meta.push(fmtDur(Math.max(0, now - w.since)));
    return { label: tr('work.checking'), meta: meta.filter(Boolean).join(' · '), tone: 'live' };
  }
  if (w.phase === 'background') {
    const meta = [];
    if (w.jobs > 1) meta.push(tr('work.jobs', { n: w.jobs }));
    if (w.since) meta.push(fmtDur(Math.max(0, now - w.since)));
    // One job of a known kind is named for what it is; anything else is "work".
    const label = w.jobs === 1 && w.jobKind === 'agent' ? tr('work.bgAgent')
      : w.jobs === 1 && w.jobKind === 'shell' ? tr('work.bgShell') : tr('work.background');
    return { label, meta: meta.join(' · '), tone: 'live' };
  }
  const label = w.phase === 'writing' ? tr('work.writing')
    : w.phase === 'tool' ? tr('work.working') : tr('work.thinking');
  const meta = [];
  if (w.phase === 'tool' && w.tool) meta.push(w.tool);
  if (w.phase === 'tool' && w.chars >= WORK_SIZE_FROM) {
    meta.push(tr('work.size', { n: Math.max(1, Math.round(w.chars / 1024)) }));
  }
  if (w.since) meta.push(fmtDur(Math.max(0, now - w.since)));
  return { label, meta: meta.join(' · '), tone: w.phase === 'thinking' ? 'think' : 'live' };
}

/* What an `api_retry` event means for whoever is watching: why the request
 * failed (in a word the UI can translate), when the next try is due, and which
 * try that will be. A usage-limit wait for a sub-agent is re-sent while it lasts,
 * so a fresh note simply replaces the last. */
function apiRetryNote(msg, now) {
  const m = msg || {};
  const err = String(m.error || '').toLowerCase();
  const why = m.status === 429 || /rate.?limit|usage/.test(err) ? 'limit'
    : m.status === 529 || /overload/.test(err) ? 'overloaded'
      : /no.?response|timeout|timed out|connection/.test(err) ? 'noanswer' : 'error';
  return {
    why,
    until: now + Math.max(0, Number(m.delayMs) || 0),
    attempt: Number(m.attempt) || 0,
    max: Number(m.maxRetries) || 0,
  };
}

/* "Waiting to retry · usage limit · next try in 40s · try 2 of 10", while the
 * wait lasts; null once it's over (the retried request is then in flight, and
 * whatever it brings moves the line on). */
function retryLineText(retry, now) {
  if (!retry || now >= retry.until) return null;
  const meta = [tr('retry.why.' + retry.why),
    tr('work.retryIn', { d: fmtDur(retry.until - now) })];
  if (retry.attempt && retry.max) meta.push(tr('work.retryTry', { n: retry.attempt, m: retry.max }));
  return { label: tr('work.retrying'), meta: meta.join(' · '), tone: 'think' };
}

/* The line for one live reply, placed right under its bubble. `since`: when the
 * turn began (kept on the liveTurn, so a chat opened mid-turn counts from there). */
function makeWorkLine(bubble, since) {
  const el = document.createElement('div');
  el.className = 'work-line';
  el.innerHTML = '<span class="wl-dot" aria-hidden="true"></span>' +
    '<span class="wl-label"></span><span class="wl-meta"></span>';
  bubble.after(el);
  const dot = el.querySelector('.wl-dot');
  const labelEl = el.querySelector('.wl-label');
  const metaEl = el.querySelector('.wl-meta');
  const w = { since: since || Date.now(), phase: 'thinking', tool: '', chars: 0, toolId: '', jobs: 0, waiting: false, retry: null };
  let lastBeat = 0;
  let gone = false;
  let jobsPanel = null;   // the jobs being waited on, listed under the line (background.js)

  const line = {
    get phase() { return w.phase; },
    get toolId() { return w.toolId; },
    set(patch) { Object.assign(w, patch); line.paint(); },
    paint() {
      if (gone) return;
      const t = workLineText(w, Date.now());
      if (labelEl.textContent !== t.label) labelEl.textContent = t.label;
      if (metaEl.textContent !== t.meta) metaEl.textContent = t.meta;
      el.dataset.tone = t.tone;
      if (jobsPanel) jobsPanel.paint(Date.now());
    },
    // The background jobs the reply is waiting on (`bgFromEvent`), or null once
    // Claude has picked it back up.
    showJobs(bg) {
      if (gone) return;
      if (!bg || !bg.jobs.length) {
        if (jobsPanel) { jobsPanel.remove(); jobsPanel = null; }
        return;
      }
      if (!jobsPanel) jobsPanel = makeBgPanel(el);
      jobsPanel.set(bg);
    },
    // Something real happened: the dot brightens once (rate-limited, and not
    // while the turn is waiting on you — that holds still).
    beat() {
      if (gone || w.waiting || !motionOK()) return;
      const now = Date.now();
      if (now - lastBeat < WORK_BEAT_MS) return;
      lastBeat = now;
      replayClass(dot, 'beat', 700);
    },
    // The reply landed: fade out, then go.
    end() {
      if (gone) return;
      line.detach(true);
      if (!motionOK()) { el.remove(); return; }
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    },
    // Gone at once (the chat left the screen, or the fade is handled above).
    detach(keep) {
      gone = true;
      if (jobsPanel) { jobsPanel.remove(); jobsPanel = null; }
      workLines.delete(line);
      if (!workLines.size) { clearInterval(workClock); workClock = null; }
      if (!keep) el.remove();
    },
  };
  workLines.add(line);
  if (!workClock) workClock = setInterval(() => workLines.forEach((l) => l.paint()), 1000);
  line.paint();
  return line;
}

// The words are in the language of the moment.
document.addEventListener('i18n:changed', () => workLines.forEach((l) => l.paint()));
