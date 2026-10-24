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
   When the reply lands the line fades and is gone. The words are a pure function
   of its state (`workLineText`), tested in tests/working.test.js. */

const WORK_BEAT_MS = 300;        // at most one brightening per this long
const WORK_SIZE_FROM = 1000;     // a tool input shows its size from this many characters
const workLines = new Set();     // the lines on screen, for the one shared clock
let workClock = null;

/* What the line says. `w`: { since, phase: 'thinking'|'writing'|'tool', tool,
 * chars, waiting }. Returns { label, meta, tone }. */
function workLineText(w, now) {
  if (w.waiting) return { label: tr('work.waiting'), meta: '', tone: 'wait' };
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
  const w = { since: since || Date.now(), phase: 'thinking', tool: '', chars: 0, toolId: '', waiting: false };
  let lastBeat = 0;
  let gone = false;

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
