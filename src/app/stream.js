/* stream.js     — composer input, typewriter, concurrent streaming, send/stop
   Part of the chat frontend; shares one global scope (see core.js). */

/* ------------------------------ composer drafts -------------------------- *
 * What you've typed but not sent is kept PER CHAT: saved in localStorage (so it
 * survives closing the app) and restored when you reopen that chat. Switching
 * chats never loses an in-progress message, and the sidebar flags any chat that
 * has an unsent draft waiting (see updateDraftMark in sidebar.js). */
const DRAFTS_KEY = 'krystal.drafts';
let drafts = (function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch (_) { return {}; }
})();
function persistDrafts() {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch (_) {}
}
function getDraft(id) { return (id && drafts[id]) || ''; }
function hasDraft(id) { return !!(id && drafts[id] && drafts[id].trim()); }
/* Save (or clear) the draft for a chat. Only pokes the sidebar when the draft's
 * presence actually flips, so typing doesn't re-render the row on every keypress. */
function saveDraft(id, text) {
  if (!id) return;
  const had = !!drafts[id];
  if (text && text.trim()) drafts[id] = text; else delete drafts[id];
  const has = !!drafts[id];
  persistDrafts();
  if (had !== has && typeof updateDraftMark === 'function') updateDraftMark(id);
}
/* Forget a chat's draft entirely (e.g. the chat was deleted). */
function dropDraft(id) {
  if (id && drafts[id] != null) { delete drafts[id]; persistDrafts(); }
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}
els.input.addEventListener('input', () => {
  autosize(); syncShellMode();
  saveDraft(state.activeId, els.input.value);   // keep this chat's draft current
  if (typeof onComposerInput === 'function') onComposerInput();   // # mention autocomplete
  if (typeof onComposerSlash === 'function') onComposerSlash();   // / skill picker
});
els.input.addEventListener('keydown', (e) => {
  // The # mention and / skill popups get first crack at navigation/selection
  // keys. Only one can be open at a time (they trigger on different text).
  if (typeof mentionKeydown === 'function' && mentionKeydown(e)) return;
  if (typeof skillKeydown === 'function' && skillKeydown(e)) return;
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

/* Stop the active thread's in-flight turn, in two escalating steps.
 *
 * The first press is polite: the backend asks the CLI to abandon the turn (the
 * chat keeps its warm process — see session.rs), which comes back as an errored
 * `result` and ends it. We mark `stopped` so that error event is treated as a
 * clean stop, not a failure.
 *
 * But an interrupt is a *request*, and a turn buried in a long tool run or a
 * sub-agent tree can be slow to honour it — or never honour it. That used to be
 * the end of the road: this function returned early once `stopped` was set, so
 * pressing stop again did literally nothing and the turn ran on. Now a second
 * press (or STOP_ESCALATE_MS of nothing happening) kills the process instead. */
const STOP_ESCALATE_MS = 8000;

async function stopActiveTurn() {
  return stopTurn(state.activeId);
}

async function stopTurn(id) {
  const live = state.live.get(id);
  if (!live) return;
  const force = !!live.stopped;   // asked once already → this press means business
  if (force && live.forced) return;
  live.stopped = true;
  if (force) live.forced = true;
  clearStopTimer(live);
  // Nothing may disable the button here: being able to press again *is* the
  // escape hatch when the polite stop doesn't land.
  if (!force) {
    live.stopTimer = setTimeout(() => {
      if (state.live.get(id) === live) stopTurn(id);
    }, STOP_ESCALATE_MS);
  }
  try { await api.stopChat(id, force); } catch (_) {}
  showTip(force
    ? { key: 'status', icon: '⏹', label: tr('stop.forcedLabel'), body: tr('stop.forcedBody') }
    : { key: 'status', icon: '⏹', label: tr('stop.toastLabel'), body: tr('stop.toastBody') });
}

function clearStopTimer(live) {
  if (live && live.stopTimer) { clearTimeout(live.stopTimer); live.stopTimer = null; }
}

/* Auto-follow the stream ONLY while the user is parked at the bottom.
 *
 * Following is turned OFF by the user's *input* (wheel up, an upward touch drag,
 * grabbing the scrollbar, PageUp/Home) rather than by the scroll event alone —
 * those fire before the scroll is applied, so they beat the stream's next
 * auto-scroll. Deciding from scroll events only used to lose that race: the
 * stream could re-pin the feed to the bottom before the user's (coalesced) scroll
 * event was dispatched, so we sampled the bottom position and stayed locked —
 * the wheel felt dead and only dragging the scrollbar (which keeps overriding
 * scrollTop) could escape.
 *
 * Following is turned back ON as soon as the feed comes to rest at (near) the
 * bottom again — or right away when we jump it to the bottom on purpose (opening
 * a chat, sending). `feedAutoTop` records where our own jumps landed so their
 * echoed scroll event isn't mistaken for the user scrolling away. */
let stickToBottom = true;
function atBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 60;
}
function unfollowFeed() { stickToBottom = false; feedAutoTop = -1; }

els.feed.addEventListener('scroll', () => {
  // Echo of our own scrollFeed(): that jump always means "follow from here", and
  // it must not be measured against the bottom — the feed may have grown since,
  // which would read as "the user scrolled up" and freeze following.
  if (feedAutoTop >= 0 && Math.abs(els.feed.scrollTop - feedAutoTop) <= 1) {
    stickToBottom = true;
    return;
  }
  feedAutoTop = -1;
  stickToBottom = atBottom();
}, { passive: true });

// Wheel: any upward nudge detaches immediately; scrolling back down re-attaches
// via the scroll listener once the feed actually reaches the bottom.
els.feed.addEventListener('wheel', (e) => { if (e.deltaY < 0) unfollowFeed(); }, { passive: true });

// Touch drag: downward finger movement = scrolling up.
let touchY = 0;
els.feed.addEventListener('touchstart', (e) => {
  touchY = e.touches[0] ? e.touches[0].clientY : 0;
}, { passive: true });
els.feed.addEventListener('touchmove', (e) => {
  const y = e.touches[0] ? e.touches[0].clientY : touchY;
  if (y - touchY > 2) unfollowFeed();
  touchY = y;
}, { passive: true });

// Grabbing the scrollbar: stop fighting the drag for as long as it lasts.
els.feed.addEventListener('mousedown', (e) => {
  if (e.clientX - els.feed.getBoundingClientRect().left > els.feed.clientWidth) unfollowFeed();
});

// Keyboard scrolling of the feed (when it, not the composer, has focus).
els.feed.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') unfollowFeed();
});

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
  // Compacting needs a settled session, so it can't run mid-turn — say so with a
  // real disabled state instead of a button that looks live and does nothing.
  els.compactBtn.disabled = canStop || !state.activeId;
  els.compactBtn.title = tr(canStop ? 'compact.btnTitleBusy' : 'compact.btnTitle');
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
  refreshAgentChips();   // rebuilt sub-agent chips pick their tally back up
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
  clearStopTimer(live);                               // the turn ended on its own
  for (const a of live.activity) a.running = false;   // clear spinners even if backgrounded
  agentTurnEnded(live.threadId);                      // no worker is still going either
  state.live.delete(live.threadId);
  if (typeof permissionsTurnEnded === 'function') permissionsTurnEnded(live);   // nothing left to answer
  if (live.threadId === state.activeId) {
    syncComposer();
    refreshActivityPanel();
    refreshGit();   // Claude may have changed files this turn
    if (pendingAnswer) setTimeout(flushPendingAnswer, 0);
  }
  if (state.view === 'threads') loadThreads();   // refresh sidebar title/time
}

/* ------------------------- suggested next message ------------------------ */
/* The CLI can predict what the user is likely to ask next (--prompt-suggestions)
 * and emits it after a turn. It only offers one once a conversation has history,
 * and only when it has a confident guess — so this strip is a bonus that appears
 * on some turns, never a fixture. Click it to drop the text in the composer. */

function showSuggestion(text) {
  const el = els.composerSuggest;
  if (!el || !text) return;
  el.innerHTML =
    `<button type="button" class="suggest-chip" title="${escapeHtml(tr('suggest.title'))}">` +
      `<span class="suggest-label">${escapeHtml(tr('suggest.label'))}</span>` +
      `<span class="suggest-text">${escapeHtml(text)}</span>` +
    `</button>` +
    `<button type="button" class="suggest-x" title="${escapeHtml(tr('suggest.dismiss'))}" aria-label="${escapeHtml(tr('suggest.dismiss'))}">×</button>`;
  el.querySelector('.suggest-chip').onclick = () => {
    els.input.value = text;
    els.input.focus();
    autosize();
    hideSuggestion();
  };
  el.querySelector('.suggest-x').onclick = hideSuggestion;
  el.hidden = false;
  replayClass(el, 'in');
}

function hideSuggestion() {
  const el = els.composerSuggest;
  if (!el || el.hidden) return;
  el.hidden = true;
  el.innerHTML = '';
  const live = state.live.get(state.activeId);
  if (live) live.suggestion = null;   // dismissed for good, not just until a redraw
}

/* Re-show whatever the on-screen chat last suggested (thread switch / reopen). */
function syncSuggestion() {
  const live = state.activeId ? state.live.get(state.activeId) : null;
  if (live && live.suggestion) showSuggestion(live.suggestion);
  else hideSuggestion();
}

/* The channel callback. Runs for every event of `live` regardless of which
 * thread is currently on screen. */
function handleLiveEvent(live, msg) {
  const event = msg.type;
  const active = live.threadId === state.activeId;
  if (event === 'start') {
    // The session announced what `/skill-name` commands it can run — the only
    // place the CLI's own built-ins are ever named. Hand them to the picker.
    if (typeof learnSkills === 'function') learnSkills(msg.skills);
  } else if (event === 'saved') {
    // The backend has already written this turn's user message (and, from here
    // on, the answer as it arrives) to the database, so nothing is lost if the
    // app goes away mid-answer. Remember where the turn starts: `openThread`
    // skips those rows while the turn is live, since the live view paints them.
    live.savedFrom = msg.userId;
  } else if (event === 'token') {
    live.events.push({ type: 'token', text: msg.text });
    if (live.typer) live.typer.push(msg.text);
  } else if (event === 'tool') {
    live.events.push(msg);
    trackTool(live.activity, msg, active);
    // A sub-agent gets a run record of its own (before the chip is built, so the
    // chip can read its tally straight from it).
    if (isAgentTool(msg.name)) agentTaskSeen(live.threadId, msg);
    if (live.typer) live.typer.setTool(msg);
  } else if (event === 'tool_result') {
    if (msg.id) (live.outputs || (live.outputs = {}))[msg.id] = { output: msg.output, isError: msg.isError };
    trackTool(live.activity, msg, active);          // updates the Activity panel
    agentResultSeen(msg);                           // a sub-agent handed its report back
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
    // The turn's artifacts are in the database now, with the version they
    // settled on — refresh so the panel stops showing a version-less live view.
    if (live.madeArtifact && typeof artifactsTurnEnded === 'function') artifactsTurnEnded();
    finishLive(live);
  } else if (event === 'title') {
    // Late-arriving first-turn auto-title (fires after `done`). Refresh the
    // header if this thread is on screen, and the sidebar regardless.
    if (live.threadId === state.activeId) els.title.textContent = msg.title;
    if (state.view === 'threads') loadThreads();
  } else if (event === 'agent_progress') {
    // Live sub-agent tally (tokens, steps, last tool): into the Activity panel's
    // Task entry and into the run the agent inspector reads.
    live.events.push(msg);
    trackAgentProgress(live.activity, msg, active);
    agentProgressSeen(msg);
  } else if (event === 'agent_activity') {
    // What a delegated worker is saying/doing right now — one line per step, kept
    // in its run (survives a thread switch AND the end of the turn) and streamed
    // into the inspector's timeline if it's open.
    agentActivitySeen(msg);
  } else if (event === 'orchestration') {
    // End-of-turn orchestrator savings summary: how the turn's tokens split
    // between the premium supervisor and its cheaper workers. Stash on the turn
    // (survives switching away/back) and, if on screen, surface in the Activity panel.
    live.orch = msg;
    if (active) {
      state.activityOrch = msg;
      if (typeof refreshActivityBtn === 'function') refreshActivityBtn();
      if (typeof refreshActivityPanel === 'function') refreshActivityPanel();
    }
  } else if (event === 'suggestion') {
    // A predicted next message. Stash it on the turn so switching away and back
    // doesn't lose it, and show it under the composer if this chat is on screen.
    live.suggestion = msg.text;
    if (active) showSuggestion(msg.text);
  } else if (event === 'artifact') {
    // Claude created or revised an artifact. The whole document is in the event
    // (the backend read it back off disk), so the panel can repaint live.
    live.madeArtifact = true;
    if (typeof artifactEvent === 'function') artifactEvent(msg);
  } else if (event === 'permission') {
    // Ask mode: the turn has stopped to ask before changing or running something.
    // Queued on the turn (so it survives a thread switch) and shown above the
    // composer — see permissions.js.
    if (typeof permissionAsked === 'function') permissionAsked(live, msg);
  } else if (event === 'permission_gone') {
    // …and that question is settled: answered (here or from another view of this
    // turn) or withdrawn because the turn was stopped.
    if (typeof permissionGone === 'function') permissionGone(live, msg.id);
  } else if (event === 'tasks') {
    // Claude added/edited tasks via the snapshot file this turn — refresh the UI.
    if (typeof onTasksSynced === 'function') onTasksSynced(msg);
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
  const hasAtts = typeof hasComposerAttachments === 'function' && hasComposerAttachments();
  if ((!text && !hasAtts) || state.streaming || !state.activeId) return;

  // `$ …` runs a shell command directly, outside Claude.
  if (isShellInput(raw)) { runShellCommand(shellCommandOf(raw).trim()); return; }

  const threadId = state.activeId;   // capture: the active view may change mid-stream
  // Resolve any #-referenced chats to thread ids (background context), then reset.
  const refs = typeof resolveComposerRefs === 'function' ? resolveComposerRefs(text) : [];
  // Pasted/dropped attachments become file paths Claude is told to Read. Awaits
  // any in-flight save of a just-pasted screenshot so its path is ready.
  const files = typeof collectAttachmentPaths === 'function' ? await collectAttachmentPaths(threadId) : [];
  if (!text && !files.length) return;   // everything (e.g. a failed paste) dropped out

  // render the user message + clear composer. Sending re-engages auto-follow
  // (you want to watch the new reply), even if you'd scrolled up earlier.
  stickToBottom = true;
  state.seed = null;                 // this turn folds the compaction summary back in
  appendMessage('user', text, files, null);
  els.input.value = '';
  saveDraft(threadId, '');           // the draft was just sent — clear it
  if (typeof clearComposerRefs === 'function') clearComposerRefs(threadId);
  if (typeof clearComposerAttachments === 'function') clearComposerAttachments(threadId);
  autosize();
  scrollFeed();

  // The liveTurn owns this turn independently of the on-screen thread. Its
  // activity array IS the active thread's list (same ref), so tool chips keep
  // flowing into the Activity panel and survive switching away and back.
  const live = {
    threadId, userText: text, userFiles: files,
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
    await invoke('chat', { threadId, text, refs, files, onEvent: channel });
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
  saveDraft(threadId, '');           // the shell line was consumed — clear the draft
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

