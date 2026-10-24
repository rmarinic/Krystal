/* typer.js      — the typewriter that renders a reply as it streams (text
                 formatted live via livemd.js, a chip per tool action)
   Part of the chat frontend; shares one global scope (see core.js). */

/* Typewriter: decouples network arrival from rendering. Tokens are buffered
 * and revealed at a smooth, adaptive cadence (always ~one breath behind the
 * stream) with a blinking caret. */
/* Renders one assistant turn as an ordered sequence of blocks — text blocks and
 * action chips, each on its own line — built up live as the stream arrives.
 *   • text is formatted as it streams (livemd.js: finished blocks render once,
 *     the one being written re-renders each frame), and the whole block is
 *     rendered once more when it closes (a tool action or the end of the turn);
 *   • each tool action becomes a chip that SPINS until its own result is back;
 *   • one working line under it says what's going on until the reply lands,
 *     however quiet the stream goes (working.js);
 *   • the same segment shapes are persisted server-side, so a reload rebuilds
 *     this exact transcript via renderSegments(). */
function makeTyper(bubble, opts = {}) {
  let pending = '';        // unrevealed tokens for the current text block
  let shown = '';          // revealed text for the current text block
  let textEl = null;       // DOM node of the open (streaming) text block, or null
  let chipEl = null;       // DOM node of the current working tool chip, or null
  let caretEl = null;      // the open text block's caret, after the last thing written
  let liveMd = null;       // the open text block's live markdown (livemd.js)
  let finished = false;
  let quietEnd = false;    // the turn was stopped — no "landed" flourish
  let finalText = null;    // canonical text, used only as a no-stream fallback
  let errMsg = null;
  let raf = null, last = 0;
  const workLine = makeWorkLine(bubble, opts.since);   // "still going" (working.js)

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
      mascotWords(chunk);   // …and move the face's mouth (mascot.js)
    }
    if ((finished || errMsg) && !pending) {
      closeTextBlock();
      settleChip();
      workLine.end();
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
      mascotMode('thinking');
      workLine.set({ phase: 'thinking' });
      maybeFollow();
    },
    push(t, instant) {
      lightMode('streaming');
      mascotMode('streaming');
      workLine.set({ phase: 'writing' });
      workLine.beat();
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
      mascotMode('working');
      const name = seg.name || '';
      // A new call starts its size from nothing; its own second event keeps it.
      const sameCall = seg.id && seg.id === workLine.toolId;
      workLine.set({ phase: 'tool', tool: toolLabel(name), toolId: seg.id || '', ...(sameCall ? {} : { chars: 0 }) });
      workLine.beat();
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
      // Every step is back: Claude is reading what came of it.
      if (workLine.phase === 'tool' && !bubble.querySelector('.action-chip.working')) {
        workLine.set({ phase: 'thinking' });
      }
      workLine.beat();
    },
    // Another stretch of a tool call's input has been written (an artifact, a
    // long file): the working line shows how far it has got.
    toolInput(msg) {
      if (!msg || !msg.id || msg.id !== workLine.toolId) return;
      workLine.set({ chars: msg.chars || 0 });
      workLine.beat();
    },
    // The turn is (or is no longer) stopped on a permission prompt.
    waiting(on) { workLine.set({ waiting: !!on }); },
    // Detach from the render loop without finalizing — the bubble is about to be
    // removed (thread switch); the underlying live turn keeps accumulating.
    stop() {
      if (raf != null) { cancelAnimationFrame(raf); raf = null; }
      workLine.detach();
    },
  };
}
