/* wizard.js     — Initialize wizard + CLAUDE.md editor (analyze→questions→review)
   Part of the chat frontend; shares one global scope (see core.js). */
/* --------------------------- Initialize wizard --------------------------- */
/* A small modal state machine: analyze → questions → (draft) → review → save.
 * All wizard text is localized (see i18n.js); project type and the language
 * Claude writes CLAUDE.md in are still inferred from the project itself. */

const wiz = { brief: '', summary: '', questions: [], sel: {}, markdown: '' };

function setSteps(active) {
  const order = ['brief', 'analyze', 'questions', 'review'];
  const at = order.indexOf(active);
  els.initSteps.innerHTML = order
    .map((s, i) => `<span class="dot ${i === at ? 'on' : i < at ? 'done' : ''}"></span>`).join('');
}

function showInitOverlay() { openOverlay(els.initOverlay); }
function closeInit() {
  closeOverlay(els.initOverlay, () => {
    els.initBody.innerHTML = '';
    els.initFoot.innerHTML = '';
  });
}

function initLoading(title, sub, step) {
  setSteps(step || 'analyze');
  els.initBody.innerHTML =
    `<div class="init-loading"><div class="spin"></div><h3>${escapeHtml(title)}</h3>` +
    `<p>${escapeHtml(sub)}</p></div>`;
  els.initFoot.innerHTML = '';
}

function footBtn(text, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'init-act ' + cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function initError(message, retry) {
  const err = document.createElement('span');
  err.className = 'init-err';
  err.textContent = '⚠ ' + message;
  els.initFoot.innerHTML = '';
  els.initFoot.appendChild(err);
  els.initFoot.appendChild(footBtn(tr('wiz.close'), 'ghost', closeInit));
  if (retry) els.initFoot.appendChild(footBtn(tr('wiz.retry'), 'primary', retry));
}

function openInit() {
  if (!state.activeId || state.streaming) return;
  wiz.brief = ''; wiz.summary = ''; wiz.questions = []; wiz.sel = {}; wiz.markdown = '';
  showInitOverlay();
  els.initTitle.textContent = tr('wiz.title');
  wizRenderBrief();
}

/* "Edit instructions" — open the project's CLAUDE.md directly for editing,
 * instead of re-running the whole wizard. The wizard is still reachable from
 * here via the "Reinitialize" button. */
async function openClaudeEditor() {
  if (!state.activeId || state.streaming) return;
  showInitOverlay();
  els.initTitle.textContent = tr('wiz.editTitle');
  els.initSteps.innerHTML = '';                 // not a wizard — no step dots
  els.initBody.innerHTML =
    `<div class="init-loading"><div class="spin"></div><h3>${tr('wiz.loadingClaude')}</h3></div>`;
  els.initFoot.innerHTML = '';
  try {
    const data = await api.readClaudeMd(state.activeId);
    renderClaudeEditor(data.markdown || '', !!data.exists);
  } catch (e) {
    initError(String(e.message || e), openClaudeEditor);
  }
}

function renderClaudeEditor(md, exists) {
  els.initSteps.innerHTML = '';
  const note = exists ? tr('wiz.editNoteExists') : tr('wiz.editNoteNew');
  els.initBody.innerHTML = `<p class="init-review-note">${escapeHtml(note)}</p>`;
  const ta = document.createElement('textarea');
  ta.className = 'init-review';
  ta.value = md;
  ta.placeholder = tr('wiz.editPlaceholder');
  els.initBody.appendChild(ta);

  els.initFoot.innerHTML = '';
  // Reinitialize sits at the bottom-left; save/cancel stay on the right.
  const reinit = footBtn(tr('wiz.reinit'), 'ghost', reinitFromEditor);
  reinit.title = tr('wiz.reinitTitle');
  reinit.style.marginRight = 'auto';
  els.initFoot.appendChild(reinit);
  els.initFoot.appendChild(footBtn(tr('wiz.cancel'), 'ghost', closeInit));
  els.initFoot.appendChild(footBtn(tr('wiz.save'), 'primary', () => saveClaudeEditor(ta.value)));
}

async function saveClaudeEditor(md) {
  if (!md.trim()) {
    showTip({ key: 'status', cls: 'warn', icon: '✍️', label: tr('wiz.emptyLabel'),
      body: tr('wiz.emptyBody') });
    return;
  }
  const saveBtn = els.initFoot.querySelector('.init-act.primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = tr('wiz.saving'); }
  try {
    const data = await api.initSave(state.activeId, md);
    if (data && data.error) throw new Error(data.error);
    closeInit();
    showTip({ key: 'status', icon: '✨', label: tr('wiz.savedLabel'),
      body: tr('wiz.savedBodyEdit') });
  } catch (e) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = tr('wiz.save'); }
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('wiz.errorLabel'),
      body: escapeHtml(String(e && e.message || e)) });
  }
}

function reinitFromEditor() {
  if (!confirm(tr('wiz.reinitConfirm'))) return;
  openInit();
}

// Step 0: let the user say, in a sentence or two, what the project is about
// BEFORE Claude explores the folder. This is optional but steers the analysis.
function wizRenderBrief() {
  setSteps('brief');
  els.initBody.innerHTML = `<p class="init-intro">${escapeHtml(tr('wiz.briefIntro'))}</p>`;
  const ta = document.createElement('textarea');
  ta.className = 'init-brief';
  ta.rows = 4;
  ta.placeholder = tr('wiz.briefPlaceholder');
  ta.value = wiz.brief;
  ta.oninput = () => { wiz.brief = ta.value.trim(); };
  els.initBody.appendChild(ta);
  setTimeout(() => ta.focus(), 0);

  els.initFoot.innerHTML = '';
  els.initFoot.appendChild(footBtn(tr('wiz.cancel'), 'ghost', closeInit));
  els.initFoot.appendChild(footBtn(tr('wiz.analyzeBtn'), 'primary', runAnalyze));
}

async function runAnalyze() {
  initLoading(tr('wiz.analyzingTitle'), tr('wiz.analyzingSub'), 'analyze');
  try {
    const data = await api.initAnalyze(state.activeId, wiz.brief);
    if (data.error) return initError(data.error, runAnalyze);
    wiz.summary = data.summary || '';
    wiz.questions = Array.isArray(data.questions) ? data.questions : [];
    for (const q of wiz.questions) wiz.sel[q.id] = { opts: new Set(), custom: '' };
    wizRenderQuestions();
  } catch (e) {
    initError(String(e.message || e), runAnalyze);
  }
}

function wizRenderQuestions() {
  setSteps('questions');
  const parts = [];
  if (wiz.summary) parts.push(`<div class="init-summary">${renderMarkdown(wiz.summary)}</div>`);
  parts.push(`<p class="init-intro">${escapeHtml(tr('wiz.questionsIntro'))}</p>`);
  els.initBody.innerHTML = parts.join('');

  for (const q of wiz.questions) {
    const card = document.createElement('div');
    card.className = 'q-card';
    card.innerHTML =
      `<div class="q-text">${escapeHtml(q.question)}</div>` +
      (q.why ? `<div class="q-why">${escapeHtml(q.why)}</div>` : '');
    const opts = document.createElement('div');
    opts.className = 'q-opts';
    for (const opt of (q.options || [])) {
      const b = document.createElement('button');
      b.className = 'q-opt';
      b.textContent = opt;
      b.onclick = () => {
        const sel = wiz.sel[q.id];
        if (sel.opts.has(opt)) sel.opts.delete(opt);
        else {
          if (!q.multi) { sel.opts.clear(); opts.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('sel')); }
          sel.opts.add(opt);
        }
        b.classList.toggle('sel', sel.opts.has(opt));
      };
      opts.appendChild(b);
    }
    card.appendChild(opts);
    if (q.allowCustom !== false) {
      const ta = document.createElement('textarea');
      ta.className = 'q-custom';
      ta.rows = 1;
      ta.placeholder = tr('wiz.questionCustom');
      ta.oninput = () => { wiz.sel[q.id].custom = ta.value; };
      card.appendChild(ta);
    }
    els.initBody.appendChild(card);
  }

  els.initFoot.innerHTML = '';
  els.initFoot.appendChild(footBtn(tr('wiz.cancel'), 'ghost', closeInit));
  els.initFoot.appendChild(footBtn(tr('wiz.writeBtn'), 'primary', generateDraft));
}

function wizCollectAnswers() {
  const out = [];
  for (const q of wiz.questions) {
    const sel = wiz.sel[q.id];
    const ans = [...sel.opts];
    if (sel.custom && sel.custom.trim()) ans.push(sel.custom.trim());
    if (ans.length) out.push({ question: q.question, answer: ans });
  }
  return out;
}

async function generateDraft() {
  const answers = wizCollectAnswers();
  if (!answers.length) {
    showTip({ key: 'status', cls: 'warn', icon: '✍️', label: tr('wiz.moreLabel'),
      body: tr('wiz.moreBody') });
    return;
  }
  initLoading(tr('wiz.writingTitle'), tr('wiz.writingSub'), 'review');
  try {
    const data = await api.initDraft(state.activeId, wiz.summary, answers, wiz.brief);
    if (data.error) { wizRenderQuestions(); return initError(data.error, generateDraft); }
    wiz.markdown = data.markdown || '';
    renderReview();
  } catch (e) {
    wizRenderQuestions();
    initError(String(e.message || e), generateDraft);
  }
}

function renderReview() {
  setSteps('review');
  els.initBody.innerHTML = `<p class="init-review-note">${tr('wiz.reviewNote')}</p>`;
  const ta = document.createElement('textarea');
  ta.className = 'init-review';
  ta.value = wiz.markdown;
  ta.oninput = () => { wiz.markdown = ta.value; };
  els.initBody.appendChild(ta);

  els.initFoot.innerHTML = '';
  els.initFoot.appendChild(footBtn(tr('wiz.backToQuestions'), 'ghost', wizRenderQuestions));
  els.initFoot.appendChild(footBtn(tr('wiz.rewrite'), '', generateDraft));
  els.initFoot.appendChild(footBtn(tr('wiz.acceptSave'), 'primary', acceptDraft));
}

async function acceptDraft() {
  const saveBtn = els.initFoot.querySelector('.init-act.primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = tr('wiz.saving'); }
  try {
    const data = await api.initSave(state.activeId, wiz.markdown);
    if (data.error) throw new Error(data.error);
    closeInit();
    showTip({ key: 'status', icon: '✨', label: tr('wiz.savedLabel'),
      body: tr('wiz.savedBodyAccept') });
  } catch (e) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = tr('wiz.acceptSave'); }
    initError(String(e.message || e), null);
    els.initFoot.appendChild(footBtn(tr('wiz.acceptSave'), 'primary', acceptDraft));
  }
}

els.initBtn.onclick = openClaudeEditor;
els.initClose.onclick = closeInit;

// Close on backdrop click — but ONLY when the press both STARTED and ENDED on
// the backdrop itself. Without this, selecting text in the draft and releasing
// the mouse on the backdrop (or outside the window) would dismiss the modal and
// lose the draft: the browser resolves such a drag to a `click` on the overlay.
// Requiring both endpoints to be the backdrop makes only a real backdrop click
// close it, so dragging out of the textarea is always safe.
let initPressOnBackdrop = false;
els.initOverlay.addEventListener('mousedown', (e) => {
  initPressOnBackdrop = (e.target === els.initOverlay);
});
els.initOverlay.addEventListener('mouseup', (e) => {
  if (initPressOnBackdrop && e.target === els.initOverlay) closeInit();
  initPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.initOverlay.hidden) closeInit();
});

