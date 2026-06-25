/* stream.js     — composer input, typewriter, concurrent streaming, send/stop
   Part of the chat frontend; shares one global scope (see core.js). */
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}
els.input.addEventListener('input', () => {
  autosize(); syncShellMode();
  if (typeof onComposerInput === 'function') onComposerInput();   // # mention autocomplete
});
els.input.addEventListener('keydown', (e) => {
  // The # mention popup gets first crack at navigation/selection keys.
  if (typeof mentionKeydown === 'function' && mentionKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

/* The `$` escape hatch: a leading `$` switches the composer to "shell mode",
 * where Enter runs the line as a shell command (in the project folder) instead
 * of messaging Claude. We light up the composer so the switch is unmistakable. */
function isShellInput(v) { return /^\s*\$/.test(v || ''); }
function shellCommandOf(v) { return (v || '').replace(/^\s*\$\s?/, ''); }
function syncShellMode() {
  const on = isShellInput(els.input.value) && !state.streaming;
  els.composer.classList.toggle('shell-mode', on);
}
/* The send button doubles as a stop button while a turn streams (when the
 * feature is enabled). Inline SVGs so syncComposer can swap them per state. */
const SEND_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';

// Both icons live in the button at once; CSS cross-morphs them as `.is-stop`
// toggles, so the arrow ships cleanly into the square (and back).
els.sendBtn.innerHTML = `<span class="ic ic-send">${SEND_SVG}</span><span class="ic ic-stop">${STOP_SVG}</span>`;
els.sendBtn.onclick = () => {
  if (state.streaming) stopActiveTurn();
  else send();
};

/* Interrupt the active thread's in-flight turn. The backend kills the claude
 * process; the stream then ends and finishLive runs. We mark `stopped` so the
 * resulting error event is treated as a clean stop, not a failure. */
async function stopActiveTurn() {
  const id = state.activeId;
  const live = state.live.get(id);
  if (!live || live.stopped) return;
  live.stopped = true;
  els.sendBtn.disabled = true;
  try { await api.stopChat(id); } catch (_) {}
  showTip({ key: 'status', icon: '⏹', label: tr('stop.toastLabel'), body: tr('stop.toastBody') });
}

/* Auto-follow the stream ONLY while the user is parked at the bottom. The
 * decision is driven by the user's own scrolling (a scroll listener), not
 * re-checked while we auto-scroll — otherwise a small wheel nudge up would land
 * within a "near bottom" threshold and get yanked straight back down, making it
 * impossible to scroll up to read while a reply streams in.
 *
 * As soon as the user scrolls away from the bottom, following stops; it resumes
 * when they return to (near) the bottom. Programmatic scrolls always land exactly
 * at the bottom, so they never accidentally toggle this off. */
let stickToBottom = true;
function atBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 60;
}
els.feed.addEventListener('scroll', () => { stickToBottom = atBottom(); }, { passive: true });
function maybeFollow() { if (stickToBottom) scrollFeed(); }

/* Typewriter: decouples network arrival from rendering. Tokens are buffered
 * and revealed at a smooth, adaptive cadence (always ~one breath behind the
 * stream) with a blinking caret. Markdown + syntax highlighting are applied
 * once at the end — never per token — which is what kills the lag. */
/* Renders one assistant turn as an ordered sequence of blocks — text blocks and
 * action chips, each on its own line — built up live as the stream arrives.
 *   • text streams with a typewriter caret, then is rendered to markdown once
 *     the block closes (a tool action or the end of the turn closes it);
 *   • each tool action becomes a chip that SPINS while it's the live action and
 *     settles to a dot once the next thing happens;
 *   • the same segment shapes are persisted server-side, so a reload rebuilds
 *     this exact transcript via renderSegments(). */
function makeTyper(bubble) {
  let pending = '';        // unrevealed tokens for the current text block
  let shown = '';          // revealed text for the current text block
  let textEl = null;       // DOM node of the open (streaming) text block, or null
  let chipEl = null;       // DOM node of the current working tool chip, or null
  let thinkEl = null;      // DOM node of the transient "thinking" indicator
  let finished = false;
  let finalText = null;    // canonical text, used only as a no-stream fallback
  let errMsg = null;
  let raf = null, last = 0;

  const caret = '<span class="caret"></span>';

  function clearThinking() { if (thinkEl) { thinkEl.remove(); thinkEl = null; } }
  function settleChip() {
    if (chipEl) { chipEl.classList.remove('working'); chipEl.classList.add('done'); chipEl = null; }
  }

  function openTextBlock() {
    settleChip();
    textEl = document.createElement('div');
    textEl.className = 'seg-text streaming';
    bubble.appendChild(textEl);
    shown = ''; pending = '';
  }

  function closeTextBlock() {
    if (!textEl) return;
    shown += pending; pending = '';
    if (shown.trim()) {
      textEl.classList.remove('streaming');
      textEl.innerHTML = renderMarkdown(shown);
      decorateCode(textEl);
    } else {
      textEl.remove();          // drop an empty text block (e.g. tool-only turn)
    }
    textEl = null;
  }

  function paintText() {
    if (!textEl) return;
    textEl.innerHTML = escapeHtml(shown).replace(/\n/g, '<br>') + caret;
    maybeFollow();
  }

  function frame(now) {
    const dt = last ? now - last : 16;
    last = now;
    if (pending && textEl) {
      // drain the backlog over ~340ms so it stays smooth but never falls behind
      const cps = Math.max(45, pending.length / 0.34);
      let n = Math.max(1, Math.round((cps * dt) / 1000));
      n = Math.min(n, pending.length);
      shown += pending.slice(0, n);
      pending = pending.slice(n);
    }
    if ((finished || errMsg) && !pending) {
      closeTextBlock();
      settleChip();
      clearThinking();
      // No streamed text at all (answer came only via the final result)? Show it.
      if (bubble.childElementCount === 0 && finalText && finalText.trim()) {
        const d = document.createElement('div');
        d.className = 'seg-text';
        d.innerHTML = renderMarkdown(finalText);
        decorateCode(d);
        bubble.appendChild(d);
      }
      if (errMsg) {
        const d = document.createElement('div');
        d.className = 'action-chip error';
        d.innerHTML = '<div class="chip-row"></div>';
        d.querySelector('.chip-row').textContent = '⚠ ' + errMsg;
        bubble.appendChild(d);
      }
      maybeFollow();
      raf = null;
      return;
    }
    if (textEl) paintText();
    raf = requestAnimationFrame(frame);
  }

  function run() { if (raf == null) { last = 0; raf = requestAnimationFrame(frame); } }

  return {
    thinking() {
      if (!thinkEl && !textEl && !chipEl) { thinkEl = renderThinkingChip(); bubble.appendChild(thinkEl); }
      maybeFollow();
    },
    push(t, instant) {
      clearThinking();
      if (!textEl) openTextBlock();   // text after a chip starts a fresh block
      if (instant) {                  // replay path: reveal buffered backlog without re-typing
        shown += t;
        paintText();
      } else {
        pending += t;
        run();
      }
    },
    setTool(seg) {
      clearThinking();
      const name = seg.name || '';
      // Rich tools (AskUserQuestion, ExitPlanMode) arrive with their payload on
      // the detailed event — swap the transient chip for the rendered card.
      const card = specialToolCard(seg);
      if (card) {
        if (chipEl && chipEl.dataset.tool === name) { chipEl.remove(); chipEl = null; }
        else { closeTextBlock(); settleChip(); }
        bubble.appendChild(card);
        maybeFollow();
        return;
      }
      const hasDetail = !!(seg.target || seg.detail);
      // The same tool fires twice (start = name only, then stop = with detail);
      // the second event refines the chip in place rather than adding another.
      if (chipEl && chipEl.dataset.tool === name && hasDetail && chipEl.dataset.detailed !== '1') {
        const updated = renderActionChip(seg, true);
        updated.dataset.tool = name; updated.dataset.detailed = '1';
        chipEl.replaceWith(updated);
        chipEl = updated;
      } else {
        closeTextBlock();
        settleChip();
        chipEl = renderActionChip(seg, true);
        chipEl.dataset.tool = name;
        chipEl.dataset.detailed = hasDetail ? '1' : '0';
        bubble.appendChild(chipEl);
      }
      maybeFollow();
    },
    finish(text) { finalText = text; finished = true; run(); },
    error(msg) { errMsg = msg; run(); },
    // A tool's output arrived — fold it into its chip so expanding shows it.
    setToolResult(msg) {
      if (!msg || !msg.id) return;
      const chip = bubble.querySelector(`.action-chip[data-id="${cssEsc(msg.id)}"]`);
      if (chip) setChipOutput(chip, msg.output, msg.isError);
    },
    // Detach from the render loop without finalizing — the bubble is about to be
    // removed (thread switch); the underlying live turn keeps accumulating.
    stop() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } },
  };
}

/* --------------------------- concurrent streaming ------------------------ *
 * Each in-flight turn lives in `state.live` keyed by thread id, independent of
 * which thread is on screen. The channel handler writes to its liveTurn always;
 * it only drives a visible typewriter when that thread is the active view. So a
 * turn started in thread A keeps streaming (and lands in A's DB row) while you
 * read or even start a new turn in thread B. */

function activeStreaming() { return state.live.has(state.activeId); }

/* Reflect the active thread's streaming state onto the composer + the derived
 * `state.streaming` flag that the rest of the UI guards on. */
function syncComposer() {
  state.streaming = activeStreaming();
  // While streaming, the send button always becomes a stop button so the user
  // can interrupt the turn; otherwise it sends (disabled when there's no chat).
  const canStop = state.streaming;
  els.sendBtn.classList.toggle('is-stop', canStop);   // CSS morphs the icon
  els.sendBtn.title = tr(canStop ? 'composer.stopTitle' : 'composer.sendTitle');
  els.sendBtn.disabled = canStop ? false : !state.activeId;
  syncShellMode();   // a streaming turn suppresses shell mode; refresh the badge
  refreshActivityBtn();
}

/* Build the visible assistant bubble + typewriter for a live turn and attach it
 * so subsequent events animate. Replays whatever the turn has buffered so far
 * (instant, no re-typing) when re-attaching after a thread switch. */
function attachLiveTyper(live) {
  const aDiv = appendMessage('assistant', '', null);
  const typer = makeTyper(aDiv.querySelector('.bubble'));
  live.bubble = aDiv;
  live.typer = typer;
  for (const ev of live.events) {
    if (ev.type === 'token') typer.push(ev.text, true);  // instant: catch up without re-typing
    else if (ev.type === 'tool') typer.setTool(ev);
  }
  // Re-apply any tool outputs received so far so expanded chips show them again.
  if (live.outputs) for (const id in live.outputs) {
    typer.setToolResult({ id, output: live.outputs[id].output, isError: live.outputs[id].isError });
  }
  if (!live.events.length) typer.thinking();
  return typer;
}

/* Stop painting a live turn whose bubble is about to be torn down (thread
 * switch). The stream keeps accumulating into `live`; only the view detaches. */
function detachLiveTyper(live) {
  if (!live || !live.typer) return;
  live.typer.stop();
  live.typer = null;
  live.bubble = null;
}

/* Single completion path for a live turn (done / error / exception). Idempotent.
 * By the time `done` arrives the backend has already persisted the turn, so we
 * drop the liveTurn and let the DB be the source of truth from here on. */
function finishLive(live) {
  if (live.finalized) return;
  live.finalized = true;
  live.typer = null;
  for (const a of live.activity) a.running = false;   // clear spinners even if backgrounded
  state.live.delete(live.threadId);
  if (live.threadId === state.activeId) {
    syncComposer();
    refreshActivityPanel();
    refreshGit();   // Claude may have changed files this turn
    if (pendingAnswer) setTimeout(flushPendingAnswer, 0);
  }
  if (state.view === 'threads') loadThreads();   // refresh sidebar title/time
}

/* The channel callback. Runs for every event of `live` regardless of which
 * thread is currently on screen. */
function handleLiveEvent(live, msg) {
  const event = msg.type;
  const active = live.threadId === state.activeId;
  if (event === 'token') {
    live.events.push({ type: 'token', text: msg.text });
    if (live.typer) live.typer.push(msg.text);
  } else if (event === 'tool') {
    live.events.push(msg);
    trackTool(live.activity, msg, active);
    if (live.typer) live.typer.setTool(msg);
  } else if (event === 'tool_result') {
    if (msg.id) (live.outputs || (live.outputs = {}))[msg.id] = { output: msg.output, isError: msg.isError };
    trackTool(live.activity, msg, active);          // updates the Activity panel
    if (live.typer) live.typer.setToolResult(msg);  // and folds output into the chip
  } else if (event === 'done') {
    live.finalText = msg.text;
    if (live.typer) {
      live.typer.finish(msg.text);
      if (msg.assistantId && live.bubble) {   // make the fresh reply starrable right away
        live.bubble.dataset.mid = msg.assistantId;
        const sb = live.bubble.querySelector('.star');
        if (sb) { sb.disabled = false; sb.onclick = () => toggleStar(live.bubble, sb); }
      }
    }
    if (active) {
      if (msg.title) els.title.textContent = msg.title;
      if (msg.usage) updateUsage(msg.usage);
    }
    finishLive(live);
  } else if (event === 'title') {
    // Late-arriving first-turn auto-title (fires after `done`). Refresh the
    // header if this thread is on screen, and the sidebar regardless.
    if (live.threadId === state.activeId) els.title.textContent = msg.title;
    if (state.view === 'threads') loadThreads();
  } else if (event === 'error') {
    // A turn the user stopped exits non-zero; settle it quietly instead of
    // painting a red error chip (any partial text is already kept).
    if (live.typer) {
      if (live.stopped) live.typer.finish(live.finalText || '');
      else live.typer.error(msg.message || 'error');
    }
    finishLive(live);
  }
}

async function send() {
  const raw = els.input.value;
  const text = raw.trim();
  if (!text || state.streaming || !state.activeId) return;

  // `$ …` runs a shell command directly, outside Claude.
  if (isShellInput(raw)) { runShellCommand(shellCommandOf(raw).trim()); return; }

  const threadId = state.activeId;   // capture: the active view may change mid-stream
  // Resolve any #-referenced chats to thread ids (background context), then reset.
  const refs = typeof resolveComposerRefs === 'function' ? resolveComposerRefs(text) : [];

  // render the user message + clear composer. Sending re-engages auto-follow
  // (you want to watch the new reply), even if you'd scrolled up earlier.
  stickToBottom = true;
  state.seed = null;                 // this turn folds the compaction summary back in
  appendMessage('user', text, null);
  els.input.value = '';
  if (typeof clearComposerRefs === 'function') clearComposerRefs();
  autosize();
  scrollFeed();

  // The liveTurn owns this turn independently of the on-screen thread. Its
  // activity array IS the active thread's list (same ref), so tool chips keep
  // flowing into the Activity panel and survive switching away and back.
  const live = {
    threadId, userText: text, userFiles: null,
    events: [], activity: state.activity, outputs: {},
    typer: null, bubble: null, finalText: null, finalized: false,
  };
  state.live.set(threadId, live);

  // assistant placeholder + typewriter, attached because this thread is on screen
  // (attachLiveTyper shows the "thinking" indicator while events is empty)
  attachLiveTyper(live);
  scrollFeed();
  syncComposer();
  if (state.view === 'threads') renderSidebar();   // show the live mark on this row

  try {
    // A Channel carries the streamed events from the Rust `chat` command,
    // exactly as the SSE stream did over HTTP. The handler routes by `live`,
    // not by the active view, so the reply always lands in `threadId`.
    const channel = new Channel();
    channel.onmessage = (msg) => handleLiveEvent(live, msg);
    await invoke('chat', { threadId, text, refs, onEvent: channel });
  } catch (e) {
    if (live.typer) live.typer.error(String(e && e.message || e));
    finishLive(live);
  } finally {
    if (threadId === state.activeId) els.input.focus();
  }
}

/* Build an empty shell-run bubble (mirrors how a persisted shell message reloads:
 * an assistant `.shell` message with no star and a terminal label). */
function appendShellRun() {
  const div = document.createElement('div');
  div.className = 'msg assistant shell';
  div.innerHTML = `<div class="role">${escapeHtml(tr('shell.role'))}</div><div class="bubble"></div>`;
  els.feed.appendChild(div);
  return { div, bubble: div.querySelector('.bubble') };
}

/* Run a `$` command directly in the project folder. Shows a running card, then
 * swaps in the result. The backend persists it regardless of the on-screen
 * thread, so switching away mid-run still keeps the result (it reloads later). */
async function runShellCommand(command) {
  if (!command || !state.activeId) return;
  const threadId = state.activeId;

  stickToBottom = true;
  els.input.value = '';
  autosize();
  syncShellMode();

  const { div, bubble } = appendShellRun();
  const running = renderShellCard({ command, output: tr('shell.running'), code: 0 });
  running.classList.add('running');
  bubble.appendChild(running);
  scrollFeed();

  const paint = (seg) => {
    if (threadId !== state.activeId) return;   // user switched threads — let reload show it
    bubble.innerHTML = '';
    bubble.appendChild(renderShellCard(seg));
    scrollFeed();
  };
  try {
    const r = await api.runShell(threadId, command);
    if (r && r.id != null && threadId === state.activeId) div.dataset.mid = r.id;
    paint(r);
  } catch (e) {
    paint({ command, output: String((e && e.message) || e), code: -1 });
  } finally {
    if (threadId === state.activeId) els.input.focus();
  }
}

