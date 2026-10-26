/* messages.js   — tool labels, plan/question cards, segment rendering (the
   action chips themselves are chips.js)
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------------- sending -------------------------------- */

// Localized human label for a tool. An MCP tool reads "Cloudflare API · Execute"
// (mcp.js); anything else unknown falls back to the raw tool name.
function toolLabel(name) {
  const mcp = mcpParts(name);
  return tr('tool.' + name, null, mcp ? `${mcp.server} · ${mcp.tool}` : name);
}

// A small glyph per tool, shown on the action chip for quick visual scanning.
// Which icon (icons.js) each tool's chip wears; anything unlisted gets `tool`.
const TOOL_ICON = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'terminal', PowerShell: 'terminal', Glob: 'search', Grep: 'search', WebSearch: 'globe', WebFetch: 'globe',
  Agent: 'agent', Task: 'agent', TodoWrite: 'todo', AskUserQuestion: 'ask', ExitPlanMode: 'plan',
  mcp__krystal__artifact: 'artifact',
};
const toolIcon = (name) => icon(TOOL_ICON[name] || (mcpParts(name) ? 'plug' : 'tool'));

/* ExitPlanMode (Plan mode): Claude proposes a plan; render its markdown as a
 * readable card rather than a blank chip. */
function renderPlanCard(seg) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.innerHTML = `${icon('plan')}<span>${escapeHtml(tr('plan.title'))}</span>`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'plan-body';
  body.innerHTML = renderMarkdown(seg.plan || '');
  decorateCode(body);
  card.appendChild(body);
  return card;
}

/* A direct shell run (the composer's `$` escape hatch): the command line + its
 * captured output, rendered as a self-contained terminal-style card. Persisted
 * as a `{type:'shell'}` segment so it reloads identically. */
function renderShellCard(seg) {
  const err = seg.code != null && seg.code !== 0;
  const card = document.createElement('div');
  card.className = 'shell-card' + (err ? ' err' : '');

  const head = document.createElement('div');
  head.className = 'shell-head';
  head.innerHTML = '<span class="shell-ico" aria-hidden="true">›_</span><span class="shell-cmd"></span>';
  head.querySelector('.shell-cmd').textContent = seg.command || '';
  card.appendChild(head);

  const pre = document.createElement('pre');
  pre.className = 'shell-out' + (err ? ' err' : '');
  pre.textContent = (seg.output && seg.output.length) ? seg.output : tr('shell.noOutput');
  addCopyButton(pre);
  card.appendChild(pre);

  if (err) {
    const code = document.createElement('div');
    code.className = 'shell-code';
    code.textContent = tr('shell.exit', { code: seg.code });
    card.appendChild(code);
  }
  return card;
}

/* True if a message is purely shell runs (so it renders as terminal output, not
 * a "Claude" reply — no star, no Claude label). */
function isShellSegments(segs) {
  return !!(segs && segs.length && segs.every((s) => s && s.type === 'shell'));
}

/* If a tool segment has a rich rendering (a question card, a plan card), build
 * and return it; otherwise return null so the caller falls back to a chip. */
function specialToolCard(seg) {
  // An artifact isn't an action to inspect — it's a thing to open. Handled here
  // so the live stream and a reloaded transcript render it identically.
  if (seg.artifact && typeof renderArtifactCard === 'function') {
    return renderArtifactCard(seg);
  }
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
  intro.innerHTML = `<span class="qa-ico" aria-hidden="true">${icon('ask')}</span><span>${escapeHtml(tr('qa.title'))}</span>`;
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

// Transient "thinking" indicator (not persisted) shown before the first token.
/* What the Copy button on a reply puts on the clipboard: what Claude *wrote*, as
 * the markdown it wrote it in, without the action chips between the paragraphs.
 * Takes saved segments (`text` = one block each) or a live turn's events
 * (`token` = a piece of the block being written); a tool (an action, an
 * artifact) ends the block it interrupts. A direct shell run copies its
 * command and output. `fallback` is the saved text, for replies from before
 * segments existed. */
function replyCopyText(items, fallback) {
  const blocks = [];
  let cur = '';
  const close = () => { if (cur.trim()) blocks.push(cur.trim()); cur = ''; };
  for (const it of (items || [])) {
    if (!it) continue;
    if (it.type === 'token') cur += it.text || '';
    else if (it.type === 'text') { close(); cur = it.text || ''; close(); }
    else if (it.type === 'shell') {
      close();
      blocks.push([it.command || '', it.output || ''].filter((x) => x.trim()).join('\n\n').trim());
    } else if (it.type === 'tool') close();   // progress ticks etc. don't split a paragraph
  }
  close();
  const out = blocks.filter(Boolean).join('\n\n');
  return out || String(fallback || '').trim();
}

/* Render a persisted segment list (text blocks + action chips) into a bubble,
 * in order. Used when reloading a saved conversation. */
function renderSegments(bubble, segs) {
  for (const seg of segs) {
    if (!seg) continue;
    if (seg.type === 'shell') {
      bubble.appendChild(renderShellCard(seg));
    } else if (seg.type === 'tool') {
      const el = specialToolCard(seg) || renderActionChip(seg, false);
      bubble.appendChild(el);
      foldMcpRun(el, false);                 // a run of calls to one server folds (mcp.js)
    } else if (seg.type === 'text') {
      const d = document.createElement('div');
      d.className = 'seg-text';
      d.innerHTML = renderMarkdown(seg.text || '');
      decorateCode(d);
      bubble.appendChild(d);
    }
  }
}

