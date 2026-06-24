/* messages.js   — tool action chips, plan/question cards, segment rendering
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------------- sending -------------------------------- */

// Localized human label for a tool (falls back to the raw tool name).
function toolLabel(name) { return tr('tool.' + name, null, name); }

// A small glyph per tool, shown on the action chip for quick visual scanning.
const TOOL_ICON = {
  Read: '📖', Write: '✍️', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '✏️',
  Bash: '⚡', Glob: '🔎', Grep: '🔎', WebSearch: '🌐', WebFetch: '🌐',
  Task: '🧩', TodoWrite: '🗒️', AskUserQuestion: '🗳️', ExitPlanMode: '📋',
};

/* ExitPlanMode (Plan mode): Claude proposes a plan; render its markdown as a
 * readable card rather than a blank chip. */
function renderPlanCard(seg) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.innerHTML = `<span aria-hidden="true">📋</span><span>${escapeHtml(tr('plan.title'))}</span>`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'plan-body';
  body.innerHTML = renderMarkdown(seg.plan || '');
  decorateCode(body);
  card.appendChild(body);
  return card;
}

/* If a tool segment has a rich rendering (a question card, a plan card), build
 * and return it; otherwise return null so the caller falls back to a chip. */
function specialToolCard(seg) {
  if (seg.name === 'AskUserQuestion' && Array.isArray(seg.questions) && seg.questions.length) {
    return renderQuestionCard(seg);
  }
  if ((seg.name === 'ExitPlanMode' || seg.name === 'exit_plan_mode') && seg.plan) {
    return renderPlanCard(seg);
  }
  return null;
}

/* AskUserQuestion: Claude asks the user to choose between options. We render it
 * as an interactive card. In headless `claude -p` the tool itself can't return a
 * choice (it's auto-denied), so the user's pick — a selected option and/or a
 * typed custom answer — is sent as the next message, which `--resume` carries
 * back to Claude. Renders identically live and on reload (persisted segment).
 *
 * The card can appear mid-stream, before the turn ends. Clicking then would be
 * swallowed (we can't send while streaming), so we QUEUE the answer and flush it
 * the moment the current turn finishes — the click is never lost. */
let pendingAnswer = null;
function flushPendingAnswer() {
  if (!pendingAnswer || state.streaming || !state.activeId) return;
  const text = pendingAnswer;
  pendingAnswer = null;
  els.input.value = text;
  autosize();
  send();
}
function sendAnswer(text) {
  if (!text || !text.trim() || !state.activeId) return false;
  pendingAnswer = text.trim();
  flushPendingAnswer();             // sends now if idle, otherwise on turn-end
  return true;
}

function renderQuestionCard(seg) {
  const questions = Array.isArray(seg.questions) ? seg.questions : [];
  const card = document.createElement('div');
  card.className = 'qa-card';

  const intro = document.createElement('div');
  intro.className = 'qa-intro';
  intro.innerHTML = `<span class="qa-ico" aria-hidden="true">🗳️</span><span>${escapeHtml(tr('qa.title'))}</span>`;
  card.appendChild(intro);

  const sel = questions.map(() => new Set());   // selected option labels per question
  const customEls = [];                          // the custom-answer <input> per question
  let sendBtn = null;                            // assigned below; referenced by handlers

  // Nothing sends on its own anymore: you pick (one for single, any for multi),
  // then confirm with the Send button or Enter. The button stays disabled until
  // there's at least one pick or some typed text, so the action is always explicit.
  function anyChosen() {
    return sel.some((s) => s.size) || customEls.some((c) => c && c.value.trim());
  }
  function syncSend() {
    if (sendBtn) sendBtn.disabled = card.classList.contains('answered') || !anyChosen();
  }

  function submit() {
    if (card.classList.contains('answered') || !anyChosen()) return;
    const parts = [];
    questions.forEach((q, qi) => {
      const ans = [...sel[qi]];
      const custom = (customEls[qi] && customEls[qi].value.trim()) || '';
      if (custom) ans.push(custom);
      if (!ans.length) return;
      parts.push(questions.length === 1 ? ans.join(', ') : `${q.header || q.question}: ${ans.join(', ')}`);
    });
    const text = parts.join('\n');
    if (!text.trim()) return;                    // nothing picked or typed yet
    if (!sendAnswer(text)) return;               // only lock the card once accepted
    card.classList.add('answered');
    card.querySelectorAll('.qa-opt, .qa-send, .qa-custom').forEach((el) => { el.disabled = true; });
  }

  questions.forEach((q, qi) => {
    const multi = !!q.multiSelect;
    const block = document.createElement('div');
    // `single` / `multi` drive the marker shape (radio vs checkbox) + the hint.
    block.className = 'qa-q ' + (multi ? 'multi' : 'single');
    let h = '';
    if (q.header) h += `<div class="qa-head">${escapeHtml(q.header)}</div>`;
    if (q.question) h += `<div class="qa-text">${escapeHtml(q.question)}</div>`;
    h += `<div class="qa-hint">${escapeHtml(tr(multi ? 'qa.pickMany' : 'qa.pickOne'))}</div>`;
    block.innerHTML = h;

    const optsWrap = document.createElement('div');
    optsWrap.className = 'qa-opts';
    for (const opt of (q.options || [])) {
      const label = typeof opt === 'string' ? opt : (opt.label || '');
      const desc = typeof opt === 'string' ? '' : (opt.description || '');
      if (!label) continue;
      const b = document.createElement('button');
      b.className = 'qa-opt';
      b.innerHTML =
        '<span class="qa-mark" aria-hidden="true"></span>' +
        `<span class="qa-opt-main"><span class="qa-opt-label">${escapeHtml(label)}</span>` +
        (desc ? `<span class="qa-opt-desc">${escapeHtml(desc)}</span>` : '') + '</span>';
      b.onclick = () => {
        if (card.classList.contains('answered')) return;
        if (sel[qi].has(label) && multi) {
          sel[qi].delete(label);                 // toggle off (multi-select only)
        } else {
          if (!multi) {                          // single-select: replace
            sel[qi].clear();
            optsWrap.querySelectorAll('.qa-opt').forEach((x) => x.classList.remove('sel'));
          }
          sel[qi].add(label);
        }
        b.classList.toggle('sel', sel[qi].has(label));
        syncSend();                              // no auto-send — just update the button
      };
      optsWrap.appendChild(b);
    }
    block.appendChild(optsWrap);

    // Free-text custom answer. Enter submits the whole card.
    const custom = document.createElement('input');
    custom.type = 'text';
    custom.className = 'qa-custom';
    custom.placeholder = tr('qa.customPlaceholder');
    custom.addEventListener('input', syncSend);
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    customEls[qi] = custom;
    block.appendChild(custom);

    card.appendChild(block);
  });

  const foot = document.createElement('div');
  foot.className = 'qa-foot';
  sendBtn = document.createElement('button');
  sendBtn.className = 'qa-send';
  sendBtn.textContent = tr('qa.send');
  sendBtn.onclick = submit;
  foot.appendChild(sendBtn);
  card.appendChild(foot);
  syncSend();                                    // start disabled until something is chosen

  return card;
}

const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

/* Build one "action chip" — the persisted, on-its-own-line record of a tool
 * action. `working` shows a live spinner + glow; otherwise a settled dot.
 * The chip is expandable: clicking it reveals what the tool did — a diff for
 * edits, the written content, or the tool's output. Shared by the live stream
 * and the reload path so they look (and expand) identically. */
function renderActionChip(seg, working) {
  const name = seg.name || '';
  const target = seg.target || '';
  const label = toolLabel(name) + (target ? ' · ' + target : '');
  const el = document.createElement('div');
  el.className = 'action-chip expandable ' + (working ? 'working' : 'done');
  if (seg.id) el.dataset.id = seg.id;
  el._seg = seg;                 // kept so a late tool_result can refill details

  const row = document.createElement('div');
  row.className = 'chip-row';
  row.title = tr('chip.expandTitle');
  row.innerHTML =
    '<span class="chip-status" aria-hidden="true"></span>' +
    `<span class="chip-ico" aria-hidden="true">${TOOL_ICON[name] || '⚙️'}</span>` +
    `<span class="chip-label">${escapeHtml(label)}</span>` +
    '<span class="chip-caret" aria-hidden="true">▸</span>';
  el.appendChild(row);

  const details = document.createElement('div');
  details.className = 'chip-details';
  details.hidden = true;                 // collapsed = removed from layout (clean small pill)
  fillChipDetails(details, seg);
  el.appendChild(details);

  row.onclick = () => toggleChip(el);
  return el;
}

/* Run `cb` once the element's max-height transition ends, with a timeout fallback
 * for the cases where no transition fires (empty panel, reduced motion). */
function onTransitionEndOnce(el, cb) {
  let done = false;
  const finish = () => { if (done) return; done = true; el.removeEventListener('transitionend', onEnd); cb(); };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'max-height') finish(); };
  el.addEventListener('transitionend', onEnd);
  setTimeout(finish, 320);
}

/* Expand / collapse a chip's details with a subtle height + fade slide. Closed,
 * the panel is `hidden` (display:none); we bring it into layout only to animate
 * max-height 0 ↔ its content height, then either let it grow freely (open) or
 * hide it again (closed). */
function toggleChip(el) {
  const details = el.querySelector('.chip-details');
  if (!details) return;
  const open = !el.classList.contains('open');
  if (open) {
    el.classList.add('open');
    loadChipImages(el);                              // fetch any image previews now
    details.hidden = false;
    details.style.maxHeight = '0px';
    void details.offsetHeight;                       // reflow so the next change animates
    details.style.maxHeight = details.scrollHeight + 'px';
    maybeFollow();
    onTransitionEndOnce(details, () => { details.style.maxHeight = 'none'; maybeFollow(); });
  } else {
    details.style.maxHeight = details.scrollHeight + 'px';
    void details.offsetHeight;
    el.classList.remove('open');
    details.style.maxHeight = '0px';
    onTransitionEndOnce(details, () => { details.hidden = true; details.style.maxHeight = ''; });
  }
}

// Tools whose `detail` is a file path — the ones whose target can be an image.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/* An inline image preview for a chip that touched an image file. The actual
 * pixels load lazily (on first expand, via `loadChipImages`) so reading an image
 * doesn't fetch it until the user opens the chip. */
function buildImagePreview(path) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-img';
  wrap.dataset.imgPath = path;                 // cleared once loaded
  const img = document.createElement('img');
  img.alt = basename(path);
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/* Load any not-yet-fetched image previews inside a chip (called on first open).
 * Reads the file through the backend as a data URL — no asset-scope config. */
function loadChipImages(chip) {
  chip.querySelectorAll('.chip-img[data-img-path]').forEach((wrap) => {
    const path = wrap.dataset.imgPath;
    delete wrap.dataset.imgPath;               // load once
    const img = wrap.querySelector('img');
    api.readImage(path).then((src) => {
      if (src) {
        img.onload = () => maybeFollow();
        img.src = src;
        wrap.classList.add('loaded');
      } else {
        wrap.classList.add('failed');
        wrap.textContent = tr('chip.imgFailed');
      }
    }).catch(() => {
      wrap.classList.add('failed');
      wrap.textContent = tr('chip.imgFailed');
    });
  });
}

/* Populate a chip's details from its segment: the full target/command, a diff
 * for edits, the written content, then the tool's captured output. */
function fillChipDetails(details, seg) {
  details.innerHTML = '';
  let any = false;
  if (seg.detail) {
    const d = document.createElement('div');
    d.className = 'chip-detail-line';
    d.textContent = (seg.name === 'Bash' ? '$ ' : '') + seg.detail;
    details.appendChild(d);
    any = true;
  }
  // If this action touched an image file, preview it inline.
  if (FILE_TOOLS.has(seg.name) && isImagePath(seg.detail)) {
    details.appendChild(buildImagePreview(seg.detail));
    any = true;
  }
  if (Array.isArray(seg.edits) && seg.edits.length) {
    details.appendChild(renderDiff(seg.edits));
    any = true;
  }
  if (seg.content != null) {
    const pre = document.createElement('pre');
    pre.className = 'chip-pre';
    pre.textContent = seg.content;
    details.appendChild(pre);
    any = true;
  }
  if (seg.output != null) {
    const head = document.createElement('div');
    head.className = 'chip-out-head';
    head.textContent = tr('chip.outputLabel');
    details.appendChild(head);
    const pre = document.createElement('pre');
    pre.className = 'chip-pre out' + (seg.isError ? ' err' : '');
    pre.textContent = seg.output || tr('chip.noOutput');
    details.appendChild(pre);
    any = true;
  } else if (!seg.edits && seg.content == null) {
    const p = document.createElement('div');
    p.className = 'chip-pending';
    p.textContent = tr('chip.pending');
    details.appendChild(p);
    any = true;
  }
  if (!any) {
    const p = document.createElement('div');
    p.className = 'chip-pending';
    p.textContent = tr('chip.noOutput');
    details.appendChild(p);
  }
}

/* A simple before/after diff: removed lines (red) then added lines (green). */
function renderDiff(edits) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-diff';
  for (const e of edits) {
    if (e.old) for (const ln of String(e.old).split('\n')) {
      const d = document.createElement('div');
      d.className = 'diff-line del';
      d.textContent = '- ' + ln;
      wrap.appendChild(d);
    }
    if (e.new) for (const ln of String(e.new).split('\n')) {
      const d = document.createElement('div');
      d.className = 'diff-line add';
      d.textContent = '+ ' + ln;
      wrap.appendChild(d);
    }
  }
  return wrap;
}

/* A tool's output arrived (tool_result) — fold it into the matching chip and
 * refresh its details, keeping whatever expand state the user set. */
function setChipOutput(chip, output, isError) {
  const seg = chip._seg || (chip._seg = {});
  seg.output = output != null ? output : '';
  if (isError) { seg.isError = true; chip.classList.add('error'); }
  const details = chip.querySelector('.chip-details');
  if (details) fillChipDetails(details, seg);
}

// Transient "thinking" indicator (not persisted) shown before the first token.
function renderThinkingChip() {
  const el = document.createElement('div');
  el.className = 'action-chip working thinking';
  el.innerHTML =
    '<div class="chip-row">' +
    '<span class="chip-status" aria-hidden="true"></span>' +
    `<span class="chip-label">${tr('chip.thinking')}</span>` +
    '</div>';
  return el;
}

/* Render a persisted segment list (text blocks + action chips) into a bubble,
 * in order. Used when reloading a saved conversation. */
function renderSegments(bubble, segs) {
  for (const seg of segs) {
    if (!seg) continue;
    if (seg.type === 'tool') {
      bubble.appendChild(specialToolCard(seg) || renderActionChip(seg, false));
    } else if (seg.type === 'text') {
      const d = document.createElement('div');
      d.className = 'seg-text';
      d.innerHTML = renderMarkdown(seg.text || '');
      decorateCode(d);
      bubble.appendChild(d);
    }
  }
}

