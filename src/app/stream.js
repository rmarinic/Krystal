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

/* Fit the composer to its text. Growing is instant (a transition there would
 * leave the text a frame behind its box while you type); shrinking — a message
 * just sent, a paragraph deleted — exhales back down. */
function autosize() {
  const el = els.input;
  const prev = parseFloat(el.style.height) || 0;
  el.style.height = 'auto';
  const next = Math.min(el.scrollHeight, 200);
  const exhale = motionOK() && prev > next;
  el.classList.toggle('exhale', exhale);
  if (exhale) { el.style.height = prev + 'px'; void el.offsetHeight; }
  el.style.height = next + 'px';
}
els.input.addEventListener('input', () => {
  autosize(); syncShellMode();
  lightKey();                                   // the floor warms as you type (light.js)
  saveDraft(state.activeId, els.input.value);   // keep this chat's draft current
  if (typeof syncQueueBtn === 'function') syncQueueBtn();         // something to queue mid-turn?
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
 * of messaging Claude. We light up the composer so the switch is unmistakable.
 * It works mid-turn too: the command runs beside Claude, not through it, so
 * there's nothing to wait for (the send button stays Stop; Enter runs it). */
function isShellInput(v) { return /^\s*\$/.test(v || ''); }
function shellCommandOf(v) { return (v || '').replace(/^\s*\$\s?/, ''); }
function syncShellMode() {
  const on = isShellInput(els.input.value);
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
    ? { key: 'status', icon: 'stop', label: tr('stop.forcedLabel'), body: tr('stop.forcedBody') }
    : { key: 'status', icon: 'stop', label: tr('stop.toastLabel'), body: tr('stop.toastBody') });
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
  syncReplyPill();
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

function maybeFollow() { if (stickToBottom) glideFeed(); else syncReplyPill(); }

/* ---------------------------- "new reply below" --------------------------- *
 * Scroll up to read while Claude is still writing and the reply carries on out
 * of sight — so a small pill above the composer says so, and a click glides you
 * back down to it (and keeps following). If the reply lands while you're still
 * up there, the pill says that instead and stays until you've been down to see
 * it. At the bottom there is nothing to say, so it isn't there. */
let replyPillEl = null;
let replyPillShown = '';
let replyUnseen = false;   // a reply finished while you were scrolled away from it

function syncReplyPill() {
  if (!replyPillEl) {
    replyPillEl = document.createElement('button');
    replyPillEl.type = 'button';
    replyPillEl.className = 'reply-pill';
    replyPillEl.hidden = true;
    replyPillEl.onclick = () => {
      stickToBottom = true;
      replyUnseen = false;
      glideFeed();
      syncReplyPill();
    };
    els.composer.prepend(replyPillEl);
  }
  let kind = '';
  if (state.activeId && !atBottom()) {
    if (state.live.has(state.activeId) && !stickToBottom) kind = 'writing';
    else if (replyUnseen) kind = 'new';
  } else {
    replyUnseen = false;
  }
  if (kind === replyPillShown) return;
  replyPillShown = kind;
  if (!kind) {   // leaves with a short fade rather than blinking out
    replyPillEl.classList.add('out');
    setTimeout(() => {
      if (replyPillShown) return;
      replyPillEl.hidden = true;
      replyPillEl.classList.remove('out');
    }, motionOK() ? 160 : 0);
    return;
  }
  replyPillEl.classList.remove('out');
  replyPillEl.classList.toggle('live', kind === 'writing');
  replyPillEl.innerHTML = (kind === 'writing' ? '<span class="rp-dot" aria-hidden="true"></span>' : '') +
    `<span>${escapeHtml(tr(kind === 'writing' ? 'replyPill.writing' : 'replyPill.new'))}</span>${icon('arrowDown')}`;
  replyPillEl.title = tr('replyPill.title');
  replyPillEl.hidden = false;
  replayClass(replyPillEl, 'in');
}

/* A different chat is on screen: whatever the last one had below is its own. */
function resetReplyPill() {
  replyUnseen = false;
  syncReplyPill();
}

/* Follow the stream by easing toward the bottom rather than jumping: each frame
 * closes a fifth of the gap, so a paragraph or a chip landing reads as the feed
 * gliding, and steady streaming as a smooth crawl. Each step records where it
 * put the feed (`feedAutoTop`), so its scroll echo counts as following; any user
 * scroll turns `stickToBottom` off and the glide simply stops there. */
let feedGlide = 0;
function glideFeed() {
  if (!motionOK()) { scrollFeed(); return; }
  if (feedGlide) return;
  const step = () => {
    feedGlide = 0;
    if (!stickToBottom) return;
    const f = els.feed;
    const gap = f.scrollHeight - f.clientHeight - f.scrollTop;
    if (Math.abs(gap) <= 1) { scrollFeed(); return; }
    const was = f.scrollTop;
    f.scrollTop = was + Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.2);
    if (f.scrollTop === was) { scrollFeed(); return; }   // pinned by rounding — just land
    feedAutoTop = f.scrollTop;
    feedGlide = requestAnimationFrame(step);
  };
  feedGlide = requestAnimationFrame(step);
}

/* Typewriter: decouples network arrival from rendering. Tokens are buffered
 * and revealed at a smooth, adaptive cadence (always ~one breath behind the
 * stream) with a blinking caret. */
/* Renders one assistant turn as an ordered sequence of blocks — text blocks and
 * action chips, each on its own line — built up live as the stream arrives.
 *   • text is formatted as it streams (livemd.js: finished blocks render once,
 *     the one being written re-renders each frame), and the whole block is
 *     rendered once more when it closes (a tool action or the end of the turn);
 *   • each tool action becomes a chip that SPINS until its own result is back;
 *   • the same segment shapes are persisted server-side, so a reload rebuilds
 *     this exact transcript via renderSegments(). */
function makeTyper(bubble) {
  let pending = '';        // unrevealed tokens for the current text block
  let shown = '';          // revealed text for the current text block
  let textEl = null;       // DOM node of the open (streaming) text block, or null
  let chipEl = null;       // DOM node of the current working tool chip, or null
  let thinkEl = null;      // DOM node of the transient "thinking" indicator
  let caretEl = null;      // the open text block's caret, after the last thing written
  let liveMd = null;       // the open text block's live markdown (livemd.js)
  let finished = false;
  let quietEnd = false;    // the turn was stopped — no "landed" flourish
  let finalText = null;    // canonical text, used only as a no-stream fallback
  let errMsg = null;
  let raf = null, last = 0;

  function clearThinking() { if (thinkEl) { thinkEl.remove(); thinkEl = null; } }
  /* A chip is done when its own result is back, not when the next thing starts:
   * Claude often runs several tools at once, and each should keep spinning until
   * it returns. So moving on only lets go of the chip; `setToolResult` (or the
   * end of the turn) settles it. A chip with no id can never be matched to a
   * result and settles the old way. A sub-agent's chip follows its run instead
   * (agents.js). */
  function chipDone(chip, quiet) {
    if (!chip || !chip.classList.contains('working') || chip.classList.contains('agent-chip')) return;
    chip.classList.remove('working');
    chip.classList.add('done');
    stopChipTime(chip);
    if (!quiet) replayClass(chip, 'just-done', 500);   // its check draws itself (motion.css)
  }
  function settleChip() {
    if (!chipEl) return;
    if (!chipEl.dataset.id) chipDone(chipEl);
    chipEl = null;
  }

  function openTextBlock() {
    settleChip();
    textEl = document.createElement('div');
    textEl.className = 'seg-text streaming';
    caretEl = document.createElement('span');
    caretEl.className = 'caret';
    textEl.appendChild(caretEl);
    bubble.appendChild(textEl);
    liveMd = makeLiveMarkdown(textEl, caretEl);
    shown = ''; pending = '';
  }

  /* Bring the open block up to date with what has been revealed. `still`: a
   * replay catching up, which appears at once rather than fading in. */
  function paintText(still) {
    if (textEl && liveMd) liveMd.update(shown, !still);
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
    caretEl = null;
    liveMd = null;
  }

  function frame(now) {
    const dt = last ? now - last : 16;
    last = now;
    if (pending && textEl) {
      // drain the backlog over ~340ms so it stays smooth but never falls behind
      const cps = Math.max(45, pending.length / 0.34);
      let n = Math.max(1, Math.round((cps * dt) / 1000));
      n = Math.min(n, pending.length);
      const chunk = pending.slice(0, n);
      shown += chunk;
      pending = pending.slice(n);
      paintText();
      lightWords(n);   // the words being revealed feed the lamp (light.js)
    }
    if ((finished || errMsg) && !pending) {
      closeTextBlock();
      settleChip();
      clearThinking();
      // Nothing more is coming: a chip still waiting on its result never gets one.
      bubble.querySelectorAll('.action-chip.working[data-id]').forEach((c) => chipDone(c, quietEnd));
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
        const row = d.querySelector('.chip-row');
        row.innerHTML = icon('alert');
        row.appendChild(document.createTextNode(' ' + errMsg));
        bubble.appendChild(d);
      } else if (!quietEnd && bubble.childElementCount) {
        replayClass(bubble, 'landed', 1300);   // the answer is in: one soft sweep (motion.css)
      }
      maybeFollow();
      raf = null;
      return;
    }
    if (textEl) maybeFollow();
    raf = requestAnimationFrame(frame);
  }

  function run() { if (raf == null) { last = 0; raf = requestAnimationFrame(frame); } }

  return {
    thinking() {
      lightMode('thinking');
      if (!thinkEl && !textEl && !chipEl) { thinkEl = renderThinkingChip(); bubble.appendChild(thinkEl); }
      maybeFollow();
    },
    push(t, instant) {
      lightMode('streaming');
      clearThinking();
      if (!textEl) openTextBlock();   // text after a chip starts a fresh block
      if (instant) {                  // replay path: reveal buffered backlog without re-typing
        shown += t;
        paintText(true);
        maybeFollow();
      } else {
        pending += t;
        run();
      }
    },
    setTool(seg) {
      lightMode('working');
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
    // `quiet`: the turn was stopped, so it ends without the "landed" sweep.
    finish(text, quiet) { finalText = text; finished = true; quietEnd = !!quiet; run(); },
    error(msg) { errMsg = msg; run(); },
    // A tool's output arrived — fold it into its chip so expanding shows it, and
    // that action is over. `quiet`: a replay, not a finish happening now.
    setToolResult(msg, quiet) {
      if (!msg || !msg.id) return;
      const chip = bubble.querySelector(`.action-chip[data-id="${cssEsc(msg.id)}"]`);
      if (!chip) return;
      setChipOutput(chip, msg.output, msg.isError);
      chipDone(chip, quiet);
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
  const wasStop = els.sendBtn.classList.contains('is-stop');
  els.sendBtn.classList.toggle('is-stop', canStop);   // CSS morphs the icon
  // Sending launched the plane (startTurn); when the turn is over a fresh one
  // drops back in, instead of the square simply morphing back.
  if (!canStop) els.sendBtn.classList.remove('launch');
  if (wasStop && !canStop && motionOK()) replayClass(els.sendBtn, 'land', 400);
  els.sendBtn.title = tr(canStop ? 'composer.stopTitle' : 'composer.sendTitle');
  els.sendBtn.disabled = canStop ? false : !state.activeId;
  // Mid-turn, Enter queues rather than sends — the box says so.
  els.input.placeholder = tr(canStop ? 'composer.placeholderBusy' : 'composer.placeholder');
  // Compacting needs a settled session, so it can't run mid-turn — say so with a
  // real disabled state instead of a button that looks live and does nothing.
  els.compactBtn.disabled = canStop || !state.activeId;
  els.compactBtn.title = tr(canStop ? 'compact.btnTitleBusy' : 'compact.btnTitle');
  refreshActivityBtn();
  // The queue strip words itself by whether a turn is running, and the queue
  // button only exists while one is — both follow the same flag.
  if (typeof renderQueue === 'function') renderQueue();
  if (typeof syncQueueBtn === 'function') syncQueueBtn();
}

/* Build the visible assistant bubble + typewriter for a live turn and attach it
 * so subsequent events animate. Replays whatever the turn has buffered so far
 * (instant, no re-typing) when re-attaching after a thread switch. */
function attachLiveTyper(live) {
  const aDiv = appendMessage('assistant', '', null);
  lightAnchor(aDiv);   // before the replay, so a re-attached lamp appears in place
  const typer = makeTyper(aDiv.querySelector('.bubble'));
  live.bubble = aDiv;
  live.typer = typer;
  for (const ev of live.events) {
    if (ev.type === 'token') typer.push(ev.text, true);  // instant: catch up without re-typing
    else if (ev.type === 'tool') typer.setTool(ev);
  }
  // The replay settled every earlier chip at once; only a chip finishing live
  // should draw its check, so drop the flourish before it can paint.
  live.bubble.querySelectorAll('.just-done').forEach((c) => c.classList.remove('just-done'));
  // Re-apply any tool outputs received so far so expanded chips show them again.
  if (live.outputs) for (const id in live.outputs) {
    typer.setToolResult({ id, output: live.outputs[id].output, isError: live.outputs[id].isError }, true);
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
  lightRest();
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
  if (live.failed && !live.stopped) taskbarFailedTurn();   // red on the taskbar if you were away
  taskbarSync();                                            // …or back to rest (titlebar.js)
  if (typeof paintProjectActivity === 'function') paintProjectActivity();       // its project may be idle now
  if (live.threadId === state.activeId) {
    if (!stickToBottom && !atBottom() && !live.stopped) replyUnseen = true;
    syncReplyPill();
    lightRest();    // the lamp cools down (light.js)
    syncComposer();
    refreshActivityPanel();
    refreshGit();   // Claude may have changed files this turn
    if (pendingAnswer) setTimeout(flushPendingAnswer, 0);
  }
  if (state.view === 'threads') loadThreads();   // refresh sidebar title/time
  // Anything typed while this turn ran goes next — or is held, if the turn was
  // stopped or failed (see queue.js).
  if (typeof queueTurnEnded === 'function') queueTurnEnded(live);
}

/* -------------------------- desktop notifications ------------------------ */
/* A reply that lands while you are in another window is easy to miss for an
 * hour. So when a turn ends — or stops to ask permission — and Krystal isn't the
 * window in front, the OS says so. Never while you are looking at the app: the
 * in-app tips already cover a chat that is merely off screen. */

function notifyAway(threadId, kind, body) {
  if (!settingOn('notify')) return;
  if (!document.hidden && document.hasFocus()) return;
  const thread = (state.threads || []).find((t) => t.id === threadId);
  const chat = (thread && thread.title) || tr('notify.chatFallback');
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  api.notify(tr('notify.' + kind, { chat }), text).catch(() => {});
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
    live.ckpt = msg.ckpt || '';   // what undoing this turn's file changes is keyed by
    // Saving bumped the chat's last-activity time — reload the list so it slides
    // up to the top now, as you send, rather than when the answer lands.
    if (state.view === 'threads') loadThreads();
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
    // A step handed its result back: one soft breath of light at its chip.
    if (live.bubble && msg.id) lightBeat(live.bubble.querySelector(`.action-chip[data-id="${cssEsc(msg.id)}"]`));
    agentResultSeen(msg);                           // a sub-agent handed its report back
    if (live.typer) live.typer.setToolResult(msg);  // and folds output into the chip
  } else if (event === 'done') {
    live.finalText = msg.text;
    if (live.typer) {
      live.typer.finish(msg.text, !!live.stopped);
      // What this reply changed, as a strip that opens the review panel — its
      // line counts rolling up from zero, since they were just made.
      if (typeof attachTurnChanges === 'function') {
        attachTurnChanges(live.bubble, liveTurnSegments(live), live.ckpt, live.threadId);
        rollTurnChanges(live.bubble);
      }
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
    if (!live.stopped) notifyAway(live.threadId, 'done', msg.text);
    // …and the bell, if it landed in a chat that isn't on screen (notifications.js)
    // — unless a queued message is about to start the next turn there: it isn't
    // finished until the queue is.
    const moreQueued = typeof queuedCount === 'function' && queuedCount(live.threadId) > 0;
    if (!live.stopped && !moreQueued && typeof notifyChat === 'function') {
      notifyChat(live, turnEndKind(live), msg.text, msg.title);
    }
    finishLive(live);
  } else if (event === 'title') {
    // Late-arriving first-turn auto-title (fires after `done`). Refresh the
    // header if this thread is on screen, and the sidebar regardless.
    if (live.threadId === state.activeId) els.title.textContent = msg.title;
    if (typeof notificationRetitled === 'function') notificationRetitled(live.threadId, msg.title);
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
    live.failed = true;   // either way it didn't finish — queued messages wait
    if (!live.stopped) notifyAway(live.threadId, 'failed', msg.message);
    if (!live.stopped && typeof notifyChat === 'function') notifyChat(live, 'failed', msg.message);
    if (!live.stopped && window.krystalNeedsLogin) window.krystalNeedsLogin(msg.message);
    if (live.typer) {
      if (live.stopped) live.typer.finish(live.finalText || '', true);
      else live.typer.error(msg.message || 'error');
    }
    finishLive(live);
  }
}

/* Enter / the send button. Takes what's in the composer and either starts a turn
 * with it or — when this chat's turn is still running — puts it in the chat's
 * queue, to go the moment that turn finishes (see queue.js). */
let sendBusy = false;   // a just-pasted screenshot is still saving; don't take the message twice
async function send() {
  const raw = els.input.value;
  const text = raw.trim();
  const hasAtts = typeof hasComposerAttachments === 'function' && hasComposerAttachments();
  if ((!text && !hasAtts) || !state.activeId || sendBusy) return;

  // `$ …` runs a shell command directly, outside Claude — even mid-turn.
  if (isShellInput(raw)) {
    runShellCommand(shellCommandOf(raw).trim());
    return;
  }

  const threadId = state.activeId;   // capture: the active view may change mid-stream
  // The #-referenced chats still named in the text (background context).
  const refs = typeof composerRefsIn === 'function' ? composerRefsIn(text) : [];
  // Pasted/dropped attachments become file paths Claude is told to Read. Awaits
  // any in-flight save of a just-pasted screenshot so its path is ready.
  sendBusy = true;
  let files = [];
  try {
    if (typeof collectAttachmentPaths === 'function') files = await collectAttachmentPaths(threadId);
  } finally {
    sendBusy = false;
  }
  if (!text && !files.length) return;   // everything (e.g. a failed paste) dropped out

  // The message is taken — clear the composer it came from. Where it sat is
  // where the sent bubble flies from (startTurn).
  let from = null;
  if (threadId === state.activeId) {
    const row = els.input.closest('.composer-row');
    if (row) from = row.getBoundingClientRect();
    els.input.value = ''; autosize();
  }
  saveDraft(threadId, '');           // the draft was just sent — clear it
  if (typeof clearComposerRefs === 'function') clearComposerRefs(threadId);
  if (typeof clearComposerAttachments === 'function') clearComposerAttachments(threadId);

  const msg = { text, files, refs };
  if (state.live.has(threadId) && typeof enqueueMessage === 'function') {
    enqueueMessage(threadId, msg);
    return;
  }
  // Sending re-engages auto-follow (you want to watch the new reply), even if
  // you'd scrolled up earlier.
  startTurn(threadId, msg, { follow: true, from });
}

/* Start a turn in `threadId` with `msg` ({ text, files, refs }) — typed just now,
 * or taken off the chat's queue. The chat need not be on screen: a queued message
 * goes out when its turn comes whatever you are looking at, and `openThread`
 * re-attaches the view if you switch to it mid-turn.
 *
 * `follow` jumps the feed to the new reply (you pressed Enter); without it the
 * feed only follows if you were already at the bottom, so a queued message going
 * out doesn't yank you away from what you had scrolled up to read. */
async function startTurn(threadId, msg, opts = {}) {
  const { text, files } = msg;
  const refs = (msg.refs || []).map((r) => r.id);
  const onScreen = threadId === state.activeId;

  if (onScreen) {
    if (typeof clearStarters === 'function') clearStarters();   // the first message is on its way
    if (opts.follow) stickToBottom = true;
    state.seed = null;               // this turn folds the compaction summary back in
    hideSuggestion();                // the next message has been chosen
    const sent = appendMessage('user', text, files, null);
    // Typed just now: the message lifts out of the composer into its place, and
    // the send arrow takes off as the button turns into Stop (motion.js/.css).
    if (opts.from && motionOK()) {
      flyFromComposer(sent.querySelector('.bubble'), opts.from);
      els.sendBtn.classList.add('launch');
    }
  }

  // The liveTurn owns this turn independently of the on-screen thread. On screen
  // its activity array IS the active thread's list (same ref), so tool chips keep
  // flowing into the Activity panel and survive switching away and back; off
  // screen it carries on the list of the turn before it.
  const live = {
    threadId, userText: text, userFiles: files,
    events: [], activity: onScreen ? state.activity : (opts.activity || []), outputs: {},
    typer: null, bubble: null, finalText: null, finalized: false,
  };
  state.live.set(threadId, live);
  if (typeof liveTurnStarted === 'function') liveTurnStarted(live);   // which project it is working in

  // assistant placeholder + typewriter, attached when this thread is on screen
  // (attachLiveTyper shows the "thinking" indicator while events is empty)
  if (onScreen) {
    lightTurnBegan(opts.from);   // the lamp rises from where the message left
    attachLiveTyper(live);
    if (opts.follow) glideFeed(); else maybeFollow();
  }
  syncComposer();
  if (state.view === 'threads') renderSidebar();   // show the live mark on this row

  try {
    // A Channel carries the streamed events from the Rust `chat` command,
    // exactly as the SSE stream did over HTTP. The handler routes by `live`,
    // not by the active view, so the reply always lands in `threadId`.
    const channel = new Channel();
    channel.onmessage = (ev) => handleLiveEvent(live, ev);
    await invoke('chat', { threadId, text, refs, files, onEvent: channel });
  } catch (e) {
    live.failed = true;
    if (live.typer) live.typer.error(String(e && e.message || e));
    if (!live.finalized && !live.stopped && typeof notifyChat === 'function') {
      notifyChat(live, 'failed', String(e && e.message || e));
    }
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

  if (typeof clearStarters === 'function') clearStarters();
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

