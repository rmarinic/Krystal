/* controls.js   — model/mode pickers, compact/clear/hint, progress overlay
   Part of the chat frontend; shares one global scope (see core.js). */
/* ----------------------- model / clear / compact / hint ------------------ */

/* A small custom dropdown. Unlike a native <select>, the closed control shows
 * only the option's NAME (compact), while the open menu shows name + blurb.
 * `up` opens the menu upward (for the mode picker, which sits near the bottom). */
function createPicker(root, { items, value, tag, up, right, onChange }) {
  let opts = items;
  let current = value;
  root.classList.add('picker');
  if (up) root.classList.add('up');
  if (right) root.classList.add('right');
  root.innerHTML =
    '<button type="button" class="picker-btn">' +
      (tag ? `<span class="picker-tag">${escapeHtml(tag)}</span>` : '') +
      '<span class="picker-val"></span><span class="picker-caret">▼</span>' +
    '</button><ul class="picker-menu" hidden></ul>';
  const btn = root.querySelector('.picker-btn');
  const valEl = root.querySelector('.picker-val');
  const menu = root.querySelector('.picker-menu');

  function paintVal() {
    const it = opts.find((x) => x.value === current);
    valEl.textContent = it ? it.name : (current || '—');
  }
  function renderMenu() {
    menu.innerHTML = opts.map((it) =>
      `<li class="picker-item${it.value === current ? ' sel' : ''}" data-value="${escapeHtml(it.value)}">` +
        `<span class="pi-name">${escapeHtml(it.name)}</span>` +
        (it.blurb ? `<span class="pi-blurb">${escapeHtml(it.blurb)}</span>` : '') +
      '</li>').join('');
  }
  let closeT = null;
  function open() {
    clearTimeout(closeT);
    renderMenu();
    menu.hidden = false;
    root.classList.add('on');
    requestAnimationFrame(() => menu.classList.add('open'));   // trigger the in-transition
  }
  function close() {
    if (menu.hidden) return;
    root.classList.remove('on');
    menu.classList.remove('open');
    clearTimeout(closeT);
    closeT = setTimeout(() => { menu.hidden = true; }, 170);   // hide after the out-transition
  }
  const isOpen = () => menu.classList.contains('open');

  btn.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('.picker-item');
    if (!li) return;
    const v = li.dataset.value;
    close();
    if (v !== current) { current = v; paintVal(); if (onChange) onChange(v); }
  });
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  paintVal();
  return {
    getValue: () => current,
    set(v) { current = v; paintVal(); },
    setItems(next) { opts = next; paintVal(); },
  };
}

let modelSel = null;
let modeSel = null;

// Build (or rebuild) both pickers from the cached config, localizing the tags,
// model blurbs and mode names/blurbs. Rebuilding is how a language switch
// re-translates them; the current selection is preserved.
function buildPickers() {
  const curModel = modelSel ? modelSel.getValue() : ((state.models[0] && state.models[0].id) || '');
  const curMode = modeSel ? modeSel.getValue() : ((state.modes[0] && state.modes[0].id) || 'auto');
  modelSel = createPicker(els.modelPicker, {
    tag: tr('model.tag'),
    items: state.models.map((m) => ({
      value: m.id, name: m.name, blurb: tr('modelblurb.' + m.id, null, m.blurb),
    })),
    value: curModel,
    onChange: async (v) => {
      if (!state.activeId) return;
      await api.setModel(state.activeId, v);
      updateUsage(state.lastUsage, { silent: true });   // re-scale meter to new window
    },
  });
  modeSel = createPicker(els.modePicker, {
    tag: tr('mode.tag'),
    up: true,
    items: state.modes.map((m) => ({
      value: m.id,
      name: tr('mode.' + m.id + '.name', null, m.name),
      blurb: tr('mode.' + m.id + '.blurb', null, m.blurb),
    })),
    value: curMode,
    onChange: async (v) => {
      if (!state.activeId) return;
      await api.setMode(state.activeId, v);
    },
  });
}

async function populatePickers() {
  try {
    const { models, modes } = await api.config();
    state.models = models || [];
    state.modes = modes || [];
    buildPickers();
  } catch {}
}

/* Full-screen "working" overlay used by Compact & Clear — a satisfying little
 * indicator with a progress bar that creeps forward while the backend works,
 * then snaps to 100% and flashes a done message before fading out. */
let procCreep = null;
function showProgressOverlay({ glyph, title, sub }) {
  clearInterval(procCreep);
  els.procGlyph.textContent = glyph;
  els.procTitle.textContent = title;
  els.procSub.textContent = sub;
  els.procOverlay.classList.remove('closing', 'is-done');
  els.procOverlay.hidden = false;
  els.procBarFill.style.transition = 'none';
  els.procBarFill.style.width = '0%';
  // Ease toward ~88% on a decelerating curve so it always feels like progress
  // even though the real duration is unknown.
  void els.procBarFill.offsetWidth;
  els.procBarFill.style.transition = 'width .4s ease';
  let pct = 0;
  procCreep = setInterval(() => {
    pct += Math.max(0.5, (88 - pct) * 0.12);
    els.procBarFill.style.width = Math.min(88, pct) + '%';
  }, 180);
}
function finishProgressOverlay(doneTitle) {
  clearInterval(procCreep); procCreep = null;
  els.procBarFill.style.width = '100%';
  els.procOverlay.classList.add('is-done');
  if (doneTitle) els.procTitle.textContent = doneTitle;
  setTimeout(() => {
    els.procOverlay.classList.add('closing');
    setTimeout(() => { els.procOverlay.hidden = true; els.procOverlay.classList.remove('closing', 'is-done'); }, 320);
  }, 620);
}
function hideProgressOverlay() {
  clearInterval(procCreep); procCreep = null;
  els.procOverlay.hidden = true;
  els.procOverlay.classList.remove('closing', 'is-done');
}

async function doClear(close) {
  if (close) close();
  if (!state.activeId) return;
  if (!confirm(tr('clear.confirm'))) return;
  showProgressOverlay({ glyph: '🗑', title: tr('clear.overlayTitle'), sub: tr('clear.overlaySub') });
  try {
    await api.clear(state.activeId);
    state.tipLevelShown = null;
    await openThread(state.activeId);
    finishProgressOverlay(tr('clear.overlayDone'));
    showTip({ key: 'status', icon: '✨', label: tr('clear.toastLabel'),
      body: tr('clear.toastBody') });
  } catch (e) {
    hideProgressOverlay();
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('clear.toastLabel'),
      body: escapeHtml(String(e.message || e)) });
  }
}

async function doCompact(close) {
  if (close) close();
  if (!state.activeId || state.streaming) return;
  els.compactBtn.disabled = true;
  els.compactBtn.textContent = tr('compact.tidying');
  showProgressOverlay({ glyph: '🧹', title: tr('compact.overlayTitle'), sub: tr('compact.overlaySub') });
  try {
    const r = await api.compact(state.activeId);
    if (r.error) throw new Error(r.error);
    state.tipLevelShown = null;
    await openThread(state.activeId);
    finishProgressOverlay(tr('compact.overlayDone'));
    showTip({ key: 'status', icon: '🧹', label: tr('compact.doneLabel'),
      body: tr('compact.doneBody') });
  } catch (e) {
    hideProgressOverlay();
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('compact.failLabel'),
      body: escapeHtml(String(e.message || e)) });
  } finally {
    els.compactBtn.disabled = false;
    els.compactBtn.textContent = tr('compact.btn');
  }
}

els.clearBtn.onclick = () => doClear();
els.compactBtn.onclick = () => doCompact();

const INSIGHT_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 14.5l.55 1.6 1.6.55-1.6.55-.55 1.6-.55-1.6-1.6-.55 1.6-.55z"/></svg>';

els.hintBtn.onclick = async () => {
  if (!state.activeId || els.hintBtn.disabled) return;
  els.hintBtn.disabled = true;
  els.hintBtn.innerHTML = `<span class="spin"></span><span>${tr('hint.looking')}</span>`;
  try {
    const r = await api.hint(state.activeId);
    if (r.error) throw new Error(r.error);
    if (r.allGood || !r.tip) {
      showTip({ key: 'hint', cls: 'hint', icon: '👍', label: tr('hint.label'),
        body: tr('hint.allGood') });
    } else {
      showTip({ key: 'hint', cls: 'hint', icon: '✨', label: tr('hint.label'),
        body: renderMarkdown(r.tip) });
    }
  } catch (e) {
    showTip({ key: 'hint', cls: 'high', icon: '⚠️', label: tr('hint.label'),
      body: escapeHtml(String(e.message || e)) });
  } finally {
    els.hintBtn.disabled = false;
    els.hintBtn.innerHTML = INSIGHT_SVG + `<span>${tr('hint.label')}</span>`;
  }
};

