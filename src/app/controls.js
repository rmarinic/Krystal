/* controls.js   — model/mode pickers, compact/clear, progress overlay
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------- model / clear / compact ---------------------- */

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
let effortSel = null;

// Localized blurb for a model: prefer a per-id string, then a per-tier string,
// then the backend-derived blurb. Dynamic (fetched) models fall through to the
// tier or backend copy since they have no hardcoded per-id entry.
function modelBlurb(m) {
  return tr('modelblurb.' + m.id, null, tr('modeltier.' + (m.tier || ''), null, m.blurb || ''));
}

// Build (or rebuild) both pickers from the cached config, localizing the tags,
// model blurbs and mode names/blurbs. Rebuilding is how a language switch
// re-translates them; the current selection is preserved.
function buildPickers() {
  let curModel = modelSel ? modelSel.getValue() : ((state.models[0] && state.models[0].id) || '');
  // Resilience guard: if the stored selection fell out of the live catalogue
  // (e.g. a live refresh dropped it), snap to the newest model of the same
  // tier rather than let the closed picker show a raw unknown id — createPicker's
  // paintVal() falls back to the raw id when nothing in `opts` matches.
  if (state.models.length && !state.models.some((m) => m.id === curModel)) {
    const tier = curModel.split('-')[1];
    const fallback = state.models.find((m) => m.id.split('-')[1] === tier) || state.models[0];
    if (fallback.id !== curModel) {
      curModel = fallback.id;
      if (state.activeId) api.setModel(state.activeId, curModel).catch(() => {});   // keep the DB in sync
    }
  }
  const curMode = modeSel ? modeSel.getValue() : ((state.modes[0] && state.modes[0].id) || 'auto');
  const curEffort = effortSel ? effortSel.getValue() : (state.defaultEffort || 'high');
  modelSel = createPicker(els.modelPicker, {
    tag: tr('model.tag'),
    items: state.models.map((m) => ({
      value: m.id, name: m.name, blurb: modelBlurb(m),
    })),
    value: curModel,
    onChange: async (v) => {
      if (!state.activeId) return;
      await api.setModel(state.activeId, v);
      if (typeof orchReflectModel === 'function') orchReflectModel(v);  // keep orchestrator popover in step
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
  // How hard Claude thinks before answering. Lives beside the mode picker and,
  // like it, is remembered per chat.
  effortSel = createPicker(els.effortPicker, {
    tag: tr('effort.tag'),
    up: true,
    items: state.efforts.map((e) => ({
      value: e.id,
      name: tr('effort.' + e.id + '.name', null, e.name),
      blurb: tr('effort.' + e.id + '.blurb', null, e.blurb),
    })),
    value: curEffort,
    onChange: async (v) => {
      if (!state.activeId) return;
      await api.setEffort(state.activeId, v);
    },
  });
  if (typeof buildOrchestrator === 'function') buildOrchestrator();   // keep the orchestrator popover in lock-step
}

async function populatePickers() {
  try {
    const { models, modes, efforts } = await api.config();
    state.models = models || [];
    state.modes = modes || [];
    state.efforts = efforts || [];
    buildPickers();
  } catch {}
  // Then pull the latest catalogue from the Models API — and keep trying if that
  // first attempt didn't reach it (see scheduleModelRetry).
  refreshModelsLive().then((live) => { if (!live) scheduleModelRetry(); });
}

// Fetch the live Anthropic model list (backend hits GET /v1/models), adopt it,
// and rebuild the pickers. Silent on failure — the cached/static list already
// populated them, so offline or unauthenticated launches degrade gracefully.
// Resolves true only when the list actually came from the API.
async function refreshModelsLive() {
  try {
    const r = await api.refreshModels();
    if (r && Array.isArray(r.models) && r.models.length) {
      state.models = r.models;
      buildPickers();                                     // preserves the current selection
      if (state.activeId) updateUsage(state.lastUsage, { silent: true });  // re-scale meter
    }
    if (r && r.source === 'live') {
      clearTimeout(modelRetryTimer);
      return true;
    }
  } catch {}
  return false;
}

let modelPollTimer = null;
let modelRetryTimer = null;
const MODEL_POLL_MS = 60 * 60 * 1000;   // models change far less often than usage — hourly is plenty

// A boot-time fetch usually fails for one reason: the Claude Code token on disk
// had expired, and only the CLI can refresh it — which it does the moment a chat
// turn runs. So retry on a short ramp instead of waiting out the hourly poll,
// which would otherwise leave a whole session on last week's model list.
const MODEL_RETRY_MS = [20 * 1000, 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

function scheduleModelRetry(step = 0) {
  clearTimeout(modelRetryTimer);
  if (step >= MODEL_RETRY_MS.length) return;   // give up quietly; the hourly poll carries on
  modelRetryTimer = setTimeout(async () => {
    if (!(await refreshModelsLive())) scheduleModelRetry(step + 1);
  }, MODEL_RETRY_MS[step]);
}

// Keep the model picker current without a restart: poll hourly while the window
// is visible, and refresh immediately when it regains focus (a stale background
// tab shouldn't miss a same-day model release). The initial fetch already
// happened via populatePickers() → refreshModelsLive() at boot.
function startModelRefresh() {
  clearInterval(modelPollTimer);
  modelPollTimer = setInterval(() => { if (!document.hidden) refreshModelsLive(); }, MODEL_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshModelsLive(); });
}

/* Full-screen "working" overlay used by Compact, Clear and Update Claude Code.
 * The bar and the light behind the icon are a work light (worklight.js): they
 * move with what the work reports (`procProgress`, `procKick`) and only creep
 * on time while nothing has been reported yet. A done message, then it fades
 * out. Under the bar sits a quiet meta line: what's been done, and for how long
 * once it's taken a while (the same idea as a slow chip's clock). */
const PROC_CLOCK_AFTER_MS = 3000;
let procLight = null;
let procClock = null;
let procStarted = 0;
let procNote = '';
function procMetaPaint() {
  const secs = Math.floor((Date.now() - procStarted) / 1000);
  const clock = Date.now() - procStarted >= PROC_CLOCK_AFTER_MS
    ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
  els.procMeta.textContent = [procNote, clock].filter(Boolean).join(' · ');
}
/* `crawl`: how far (and how slowly) the bar may creep before any progress is
 * reported — short work gets a quick crawl, long work a patient one. */
function showProgressOverlay({ glyph, title, sub, crawl }) {
  els.procGlyph.innerHTML = iconOrText(glyph);
  els.procTitle.textContent = title;
  els.procSub.textContent = sub;
  els.procOverlay.classList.remove('closing', 'is-done');
  els.procOverlay.hidden = false;
  procLight = procLight || workLight(els.procOverlay, els.procBarFill);
  procLight.start(crawl || { cap: 0.5, tau: 8 });
  procNote = '';
  procStarted = Date.now();
  procMetaPaint();
  clearInterval(procClock);
  procClock = setInterval(procMetaPaint, 1000);
}
/* Real progress (0..1), with an optional note for the meta line. */
function procProgress(frac, note) {
  if (!procLight || els.procOverlay.hidden) return;
  procLight.progress(frac);
  procLight.kick();
  if (note != null && note !== procNote) { procNote = note; procMetaPaint(); }
}
/* Something real happened that can't be measured (a log line): the light answers it. */
function procKick() { if (procLight && !els.procOverlay.hidden) procLight.kick(); }
function finishProgressOverlay(doneTitle) {
  clearInterval(procClock); procClock = null;
  if (procLight) procLight.done();
  els.procOverlay.classList.add('is-done');
  if (doneTitle) els.procTitle.textContent = doneTitle;
  setTimeout(() => {
    els.procOverlay.classList.add('closing');
    setTimeout(() => {
      els.procOverlay.hidden = true;
      els.procOverlay.classList.remove('closing', 'is-done');
      if (procLight) procLight.stop();
    }, 320);
  }, 620);
}
function hideProgressOverlay() {
  clearInterval(procClock); procClock = null;
  if (procLight) procLight.stop();
  els.procOverlay.hidden = true;
  els.procOverlay.classList.remove('closing', 'is-done');
}

/* How far a compact has got, from the summary's characters so far. The first
 * stretch of the bar is the CLI reading the conversation back (no output yet,
 * covered by the crawl); the rest fills as the summary is written, on a curve
 * that slows with length since nobody knows how long the summary will be. */
const COMPACT_READ_SHARE = 0.14;
const COMPACT_TYPICAL_CHARS = 1800;
function compactProgress(chars) {
  return COMPACT_READ_SHARE + (0.95 - COMPACT_READ_SHARE) * (1 - Math.exp(-chars / COMPACT_TYPICAL_CHARS));
}
function compactNote(p) {
  if (!p || !p.chars) return tr('compact.overlayReading');
  const n = Number(p.chars).toLocaleString(window.I18N.getLang() === 'hr' ? 'hr-HR' : 'en-US');
  return tr('compact.overlayWriting', { n });
}

async function doClear(close) {
  if (close) close();
  if (!state.activeId) return;
  if (!confirm(tr('clear.confirm'))) return;
  showProgressOverlay({ glyph: 'trash', title: tr('clear.overlayTitle'), sub: tr('clear.overlaySub'),
    crawl: { cap: 0.7, tau: 0.6 } });
  try {
    await api.clear(state.activeId);
    state.tipLevelShown = null;
    await openThread(state.activeId);
    finishProgressOverlay(tr('clear.overlayDone'));
    showTip({ key: 'status', icon: 'sparkle', label: tr('clear.toastLabel'),
      body: tr('clear.toastBody') });
  } catch (e) {
    hideProgressOverlay();
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('clear.toastLabel'),
      body: escapeHtml(String(e.message || e)) });
  }
}

async function doCompact(close) {
  if (close) close();
  if (!state.activeId || state.streaming) return;
  els.compactBtn.disabled = true;
  els.compactBtn.textContent = tr('compact.tidying');
  showProgressOverlay({ glyph: 'compact', title: tr('compact.overlayTitle'), sub: tr('compact.overlaySub'),
    crawl: { cap: COMPACT_READ_SHARE, tau: 5 } });
  procProgress(0, compactNote(null));
  try {
    const r = await api.compact(state.activeId, (p) => {
      if (p && p.chars) procProgress(compactProgress(p.chars), compactNote(p));
      else procKick();                 // still thinking: no text yet, but work
    });
    if (r.error) throw new Error(r.error);
    state.tipLevelShown = null;
    await openThread(state.activeId);
    finishProgressOverlay(tr('compact.overlayDone'));
    showTip({ key: 'status', icon: 'compact', label: tr('compact.doneLabel'),
      body: tr('compact.doneBody') });
  } catch (e) {
    hideProgressOverlay();
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('compact.failLabel'),
      body: escapeHtml(String(e.message || e)) });
  } finally {
    els.compactBtn.disabled = state.streaming || !state.activeId;
    els.compactBtn.textContent = tr('compact.btn');
  }
}

els.clearBtn.onclick = () => doClear();
els.compactBtn.onclick = () => doCompact();

/* Branch (fork) the conversation: create a copy of the current chat as a new
 * thread — same settings and transcript, its own fresh session, the prior talk
 * kept as context — then switch straight into it. Non-destructive: the original
 * chat is left exactly as it was.
 *
 * Works mid-reply too (streams are per-thread and keep running when you switch
 * away): the branch simply starts from everything before the turn still in
 * flight, which the done-tip spells out.
 *
 * `fromMsg` (a message's own branch button) cuts the copy at that message
 * instead of the end — see `branch_thread`. Branching from one of your own
 * messages stops just before it and puts it back in the composer, so the new
 * branch is that question asked again, differently. */
async function doBranch(fromMsg) {
  if (!state.activeId || els.branchBtn.disabled) return;
  const mid = fromMsg ? Number(fromMsg.dataset.mid) || null : null;
  const midTurn = state.streaming && !mid;
  // Nothing to fork from an empty chat — nudge instead of making a blank copy.
  if (!els.feed.querySelector('.msg')) {
    showTip({ key: 'status', icon: 'branch', label: tr('fork.emptyLabel'), body: tr('fork.emptyBody') });
    return;
  }
  const forkBtn = fromMsg && fromMsg.querySelector('.msg-fork');
  els.branchBtn.disabled = true;
  if (forkBtn) forkBtn.disabled = true;
  else replayClass(els.branchBtn, 'sprouting', 900);   // a gentle "sprout" pulse on press
  els.branchBtn.textContent = tr('fork.working');
  try {
    const t = await api.branch(state.activeId, mid);
    if (!t || !t.id) throw new Error(tr('fork.failBody'));
    branchedThreads.add(t.id);                       // meter labels it "branched", not "compacted"
    justAddedThreadId = t.id;                        // sidebar pops + glows the new row
    if (t.draft) saveDraft(t.id, t.draft);           // openThread puts it in the composer
    await loadThreads();                             // it appears at the top of the list
    await openThread(t.id);                          // switch into the branch…
    replayClass(els.feed, 'branch-switch', 900);     // …with a calm settle of the copied thread
    if (t.draft) {
      const end = els.input.value.length;            // ready to reword: caret at the end
      els.input.setSelectionRange(end, end);
    }
    const body = !mid ? (midTurn ? 'fork.doneBodyLive' : 'fork.doneBody')
      : (t.draft ? 'fork.doneBodyAsk' : 'fork.doneBodyReply');
    showTip({ key: 'status', icon: 'branch', label: tr('fork.doneLabel'), body: tr(body) });
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('fork.failLabel'),
      body: escapeHtml(String(e.message || e)) });
  } finally {
    els.branchBtn.disabled = false;
    els.branchBtn.textContent = tr('fork.btn');
    if (forkBtn) forkBtn.disabled = false;
  }
}
els.branchBtn.onclick = () => doBranch();

