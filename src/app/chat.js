/* chat.js       — thread view, usage meter + context tips, message bubbles
   Part of the chat frontend; shares one global scope (see core.js). */
/* ----------------------------- thread view ------------------------------- */

function showEmpty() {
  els.composer.hidden = true;
  els.chatTools.hidden = true;
  els.meterRow.hidden = true;
  els.hintBtn.hidden = true;
  els.activityBtn.hidden = true;
  els.title.textContent = tr('header.noConversation');
  els.cwd.textContent = '';
  els.feed.innerHTML = '';
  els.feed.appendChild(els.empty);
  els.empty.hidden = false;
  state.activeId = null;
  replayClass(els.empty, 'enter');   // gentle entrance so the welcome feels intentional
  refreshWelcomeInit();              // sets the Initialize / Reinitialize label
}

async function openThread(id, focusMid) {
  const t = await api.thread(id);

  // Leaving a streaming thread: stop painting its bubble (we're about to wipe the
  // feed), but keep its liveTurn accumulating in the background.
  detachLiveTyper(state.live.get(state.activeId));

  state.activeId = id;
  state.tipLevelShown = null;
  if (state.view === 'threads') renderSidebar();

  els.empty.hidden = true;
  els.composer.hidden = false;
  els.chatTools.hidden = false;
  els.meterRow.hidden = false;
  els.hintBtn.hidden = false;
  els.title.textContent = t.title || tr('nav.newChatTitle');
  els.cwd.textContent = t.cwd;
  if (modelSel) modelSel.set(t.model || (state.models[0] && state.models[0].id) || '');
  if (modeSel) modeSel.set(t.mode || (state.modes[0] && state.modes[0].id) || 'auto');
  els.feed.innerHTML = '';
  for (const m of t.messages) appendMessage(m.role, m.text, m.files, m);
  updateUsage(t.usage, { silent: true });   // set meter without popping a tip on open

  // If this thread has a turn in flight, re-render its not-yet-saved user message
  // and re-attach a typewriter that replays everything buffered so far, then keeps
  // animating live. Its activity list already includes this turn's tools.
  const live = state.live.get(id);
  if (live) {
    appendMessage('user', live.userText, live.userFiles, null);
    attachLiveTyper(live);
    state.activity = live.activity;
  } else {
    // Rebuild the Activity log (shells & sub-agents) from the saved transcript so
    // it's populated on reload, not just during a live turn.
    state.activity = activityFromSegments(t.messages);
  }
  els.activityBtn.hidden = false;
  syncComposer();
  refreshGit();
  activityMinH = 0;                 // new chat → re-measure the activity panel size
  if (!els.activityOverlay.hidden) refreshActivityPanel();

  if (focusMid) {
    const el = els.feed.querySelector(`[data-mid="${focusMid}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1700);
    }
  } else {
    scrollFeed();
  }
  els.input.focus();
}

/* Double-click the header title to rename the active chat in place. */
function beginRenameHeader() {
  if (!state.activeId || els.title.querySelector('.rename-input')) return;
  const cur = els.title.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input head';
  input.value = cur === tr('header.noConversation') ? '' : cur;
  input.placeholder = tr('rename.placeholder');
  els.title.textContent = '';
  els.title.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const id = state.activeId;
    if (save) await commitRename(id, input.value, cur);
    // Restore the plain title (commitRename already set it on success).
    if (els.title.querySelector('.rename-input')) {
      els.title.textContent = (state.threads.find((t) => t.id === id) || {}).title || cur;
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}
els.title.title = tr('rename.headerTitle');
els.title.addEventListener('dblclick', beginRenameHeader);

/* ------------------------- usage meter + context tips -------------------- */

function fmtK(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0); }
function fmtCost(n) { return '$' + (n || 0).toFixed(n < 0.1 ? 3 : 2); }

// Context window of the currently-selected model.
function currentWindow() {
  const id = modelSel ? modelSel.getValue() : (state.models[0] && state.models[0].id);
  const m = state.models.find((x) => x.id === id);
  return (m && m.ctx) || DEFAULT_WINDOW;
}

let lastMeterPct = 0;
function updateUsage(usage, opts = {}) {
  state.lastUsage = usage || null;          // cache so a model switch can re-scale
  const ctx = (usage && usage.context) || 0;
  const cost = (usage && usage.costUsd) || 0;
  const win = currentWindow();
  const pct = Math.min(100, Math.round((ctx / win) * 100));
  const level = ctx >= win * CTX_HIGH_FRAC ? 'high'
    : ctx >= win * CTX_WARN_FRAC ? 'warn' : 'ok';

  els.meterFill.style.width = pct + '%';
  els.meterFill.className = 'meter-fill lvl-' + level;
  // A subtle sheen flicks across the fill when context actually grew (a turn
  // completing), not on silent loads/model switches.
  if (!opts.silent && pct > lastMeterPct && pct > 0) replayClass(els.meterFill, 'grew', 1000);
  lastMeterPct = pct;
  els.meterLabel.innerHTML = ctx
    ? tr('meter.used', { ctx: fmtK(ctx), win: fmtK(win), cost: fmtCost(cost) })
    : tr('meter.new', { win: fmtK(win) });

  if (!opts.silent && level !== 'ok' && state.tipLevelShown !== level) {
    state.tipLevelShown = level;
    showContextTip(level);
  }
}

function showContextTip(level) {
  if (level === 'warn') {
    showTip({
      key: 'ctx', cls: 'warn', icon: '⏳', label: tr('ctx.warnLabel'),
      body: tr('ctx.warnBody'),
      actions: [
        { text: tr('ctx.compactNow'), run: doCompact },
        { text: tr('ctx.gotIt'), ghost: true, run: (close) => close() },
      ],
    });
  } else {
    showTip({
      key: 'ctx', cls: 'high', icon: '⚠️', label: tr('ctx.highLabel'),
      body: tr('ctx.highBody'),
      actions: [
        { text: tr('ctx.compact'), run: doCompact },
        { text: tr('ctx.clear'), run: doClear },
        { text: tr('ctx.later'), ghost: true, run: (close) => close() },
      ],
    });
  }
}

/* Generic side-tip card. `key` de-dupes: a new tip with the same key replaces
 * the old one instead of stacking. */
function showTip({ key, cls = '', icon = '💡', label = 'Tip', body = '', actions = [] }) {
  if (key) els.tips.querySelectorAll(`[data-key="${key}"]`).forEach((n) => n.remove());
  const card = document.createElement('div');
  card.className = 'tip ' + cls;
  if (key) card.dataset.key = key;
  const close = () => { card.classList.remove('show'); setTimeout(() => card.remove(), 280); };

  const head = document.createElement('div');
  head.className = 'tip-head';
  head.innerHTML = `<span class="ico">${icon}</span><span>${escapeHtml(label)}</span>`;
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.onclick = close;
  head.appendChild(x);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'tip-body'; bodyEl.innerHTML = body;

  card.appendChild(head);
  card.appendChild(bodyEl);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'tip-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'tip-act' + (a.ghost ? ' ghost' : '');
      b.textContent = a.text;
      b.onclick = () => a.run(close);
      row.appendChild(b);
    }
    card.appendChild(row);
  }

  els.tips.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));
  return close;
}

function appendMessage(role, text, files, meta) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (meta && meta.id) div.dataset.mid = meta.id;
  const roleLabel = role === 'user' ? tr('msg.you') : tr('msg.claude');
  let chips = '';
  if (files && files.length) {
    chips = '<div class="file-chips">' + files.map((f) =>
      `<span class="file-chip"><span class="name">${escapeHtml(basename(f))}</span></span>`).join('') + '</div>';
  }
  const star = role === 'assistant'
    ? `<button class="star${meta && meta.favorite ? ' on' : ''}"${meta && meta.id ? '' : ' disabled'} title="${tr('msg.saveReply')}">★</button>`
    : '';
  div.innerHTML = `<div class="role">${roleLabel}${star}</div>${chips}<div class="bubble"></div>`;
  const bubble = div.querySelector('.bubble');
  if (role === 'assistant') {
    const segs = meta && Array.isArray(meta.segments) ? meta.segments : null;
    if (segs && segs.length) {
      renderSegments(bubble, segs);           // full transcript: text + action chips
    } else if (text) {
      bubble.innerHTML = renderMarkdown(text); // older messages saved before chips
      if (window.hljs) bubble.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
    }
    const starBtn = div.querySelector('.star');
    if (starBtn) starBtn.onclick = () => toggleStar(div, starBtn);
  } else {
    bubble.textContent = text;
  }
  els.feed.appendChild(div);
  return div;
}

async function toggleStar(div, btn) {
  const mid = div.dataset.mid;
  if (!mid) return;
  const r = await api.toggleFav(Number(mid));
  if (r && typeof r.favorite === 'boolean') {
    btn.classList.toggle('on', r.favorite);
    if (r.favorite) replayClass(btn, 'pop', 600);   // pop + sparkle when freshly saved
  }
  if (state.view === 'saved') refreshSaved();   // keep the Saved list live
}

