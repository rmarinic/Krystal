/* app.js — chat frontend for the Tauri build.
 *
 * Talks to the Rust backend over Tauri IPC instead of HTTP:
 *   invoke('command', args)         ← was fetch('/api/…')
 *   Channel + invoke('chat', …)     ← was the SSE stream
 *   dialog.open({directory:true})   ← was the native PowerShell picker
 * The UI, rendering and behaviour are otherwise identical to the web version.
 */

const { invoke, Channel } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

const $ = (sel) => document.querySelector(sel);

/* Localized string lookup. Named `tr` (not `t`) because `t` is used widely as a
 * local variable across this file (threads, tokens, timestamps). */
const tr = (key, vars, fallback) => window.I18N.t(key, vars, fallback);

const els = {
  threadList: $('#thread-list'),
  newChat: $('#new-chat'),
  title: $('#chat-title'),
  cwd: $('#chat-cwd'),
  feed: $('#feed'),
  empty: $('#empty-state'),
  composer: $('#composer'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  chatTools: $('#chat-tools'),
  modelPicker: $('#model-picker'),
  modePicker: $('#mode-picker'),
  compactBtn: $('#compact-btn'),
  clearBtn: $('#clear-btn'),
  meterRow: $('#meter-row'),
  meterFill: $('#meter-fill'),
  meterLabel: $('#meter-label'),
  tips: $('#tips'),
  hintBtn: $('#hint-btn'),
  activityBtn: $('#activity-btn'),
  activityOverlay: $('#activity-overlay'),
  activityBody: $('#activity-body'),
  activityClose: $('#activity-close'),
  activityFilters: $('#activity-filters'),
  search: $('#search'),
  savedToggle: $('#saved-toggle'),
  listHeading: $('#list-heading'),
  initBtn: $('#init-btn'),
  initOverlay: $('#init-overlay'),
  initBody: $('#init-body'),
  initFoot: $('#init-foot'),
  initSteps: $('#init-steps'),
  initTitle: $('#init-modal-title'),
  initClose: $('#init-close'),
  projectScreen: $('#project-screen'),
  projectList: $('#project-list'),
  newProjectBtn: $('#new-project-btn'),
  toProjects: $('#to-projects'),
  cpName: $('#cp-name'),
};

let state = {
  project: null,         // currently-open project { id, path, name, … }
  projects: [],          // project-picker list
  threads: [],
  activeId: null,
  streaming: false,
  models: [],
  modes: [],
  activity: [],          // this chat's shells & sub-agents (for the Activity panel)
  activityFilter: 'all', // Activity panel filter: 'all' | 'active' | 'done'
  tipLevelShown: null,   // which context-rot tip level we've already shown
  view: 'threads',       // 'threads' | 'search' | 'saved'
  results: [],           // current search/favorite results
  lastUsage: null,       // most recent usage, for re-scaling the meter
};

/* Context-rot thresholds as a FRACTION of the active model's context window
 * (Opus/Sonnet/Fable = 1M, Haiku = 200K). Nudge gently, not nag. */
const CTX_WARN_FRAC = 0.60;   // amber
const CTX_HIGH_FRAC = 0.85;   // red
const DEFAULT_WINDOW = 1000000;

/* ------------------------------ utilities -------------------------------- */
/* Each method maps to a #[tauri::command] in the Rust backend. The returned
 * shapes match the old HTTP JSON exactly, so the rest of the app is unchanged. */

const api = {
  projects() { return invoke('list_projects'); },
  createProject(path) { return invoke('create_project', { path }); },
  selectProject(id) { return invoke('select_project', { id }); },
  deleteProject(id) { return invoke('delete_project', { id }); },
  threads(project) { return invoke('list_threads', { project }); },
  thread(id) { return invoke('get_thread', { id }); },
  create(cwd) { return invoke('create_thread', { cwd }); },
  remove(id) { return invoke('delete_thread', { id }); },
  config() { return invoke('get_config'); },
  setModel(id, model) { return invoke('set_model', { id, model }); },
  setMode(id, mode) { return invoke('set_mode', { id, mode }); },
  clear(id) { return invoke('clear_thread', { id }); },
  compact(id) { return invoke('compact_thread', { id }); },
  hint(id) { return invoke('hint_thread', { id }); },
  initAnalyze(id, brief) { return invoke('init_analyze', { id, brief }); },
  initDraft(id, summary, answers, brief) { return invoke('init_draft', { id, summary, answers, brief }); },
  initSave(id, markdown) { return invoke('init_save', { id, markdown }); },
  readClaudeMd(id) { return invoke('read_claude_md', { id }); },
  search(q, project) { return invoke('search_messages', { q, project }); },
  favorites(project) { return invoke('list_favorites', { project }); },
  toggleFav(mid) { return invoke('toggle_favorite', { messageId: mid }); },
};

function basename(p) { return p.split(/[\\/]/).pop(); }
function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function renderMarkdown(md) {
  const html = window.marked ? marked.parse(md || '') : (md || '');
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
function scrollFeed() { els.feed.scrollTop = els.feed.scrollHeight; }

/* ------------------------------- sidebar --------------------------------- */

async function loadThreads(retries = 10) {
  if (!state.project) return;
  try {
    const { threads } = await api.threads(state.project.path);
    state.threads = threads || [];
    if (state.view === 'threads') renderSidebar();
  } catch (e) {
    // backend may still be coming up on the very first frame — retry briefly.
    if (retries > 0) {
      els.threadList.innerHTML = `<li class="sidebar-empty">${tr('sidebar.connecting')}</li>`;
      setTimeout(() => loadThreads(retries - 1), 500);
    }
  }
}

function renderSidebar() {
  if (state.view === 'search') return renderResults(tr('sidebar.noMatches'));
  if (state.view === 'saved') return renderResults(tr('sidebar.noSaved'));

  els.listHeading.textContent = tr('list.conversations');
  els.threadList.innerHTML = '';
  if (!state.threads.length) {
    els.threadList.innerHTML = `<li class="sidebar-empty">${tr('sidebar.noChats')}</li>`;
    return;
  }
  for (const t of state.threads) {
    const li = document.createElement('li');
    if (t.id === state.activeId) li.className = 'current';
    li.innerHTML = `
      <a>
        <span class="time">${timeLabel(t.updatedAt)}</span>
        <span class="sum">${escapeHtml(t.title || tr('nav.newChatTitle'))}</span>
        <span class="cwd">${escapeHtml(t.cwd)}</span>
      </a>
      <button class="del" title="${tr('sidebar.deleteTitle')}">×</button>`;
    li.querySelector('a').onclick = () => openThread(t.id);
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(tr('sidebar.deleteConfirm'))) return;
      await api.remove(t.id);
      if (state.activeId === t.id) { state.activeId = null; showEmpty(); }
      loadThreads();
    };
    els.threadList.appendChild(li);
  }
}

// Renders search hits or favorites into the same list.
function renderResults(emptyMsg) {
  els.listHeading.textContent = state.view === 'saved' ? tr('list.savedReplies') : tr('list.searchResults');
  els.threadList.innerHTML = '';
  if (!state.results.length) {
    els.threadList.innerHTML = `<li class="sidebar-empty">${escapeHtml(emptyMsg)}</li>`;
    return;
  }
  for (const r of state.results) {
    const li = document.createElement('li');
    li.className = 'result';
    const badge = state.view === 'saved' ? tr('result.saved')
      : (r.role === 'user' ? tr('result.you') : tr('result.claude'));
    li.innerHTML = `
      <a>
        <span class="badge">${escapeHtml(badge)}</span>
        <span class="snippet">${escapeHtml(r.text || '')}</span>
        <span class="in">${escapeHtml(tr('result.in', { title: r.threadTitle || tr('result.chat') }))}</span>
      </a>`;
    li.querySelector('a').onclick = () => openThread(r.threadId, r.messageId);
    els.threadList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
}

async function openThread(id, focusMid) {
  const t = await api.thread(id);
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

  // Rebuild the Activity log (shells & sub-agents) from the saved transcript so
  // it's populated on reload, not just during a live turn.
  state.activity = activityFromSegments(t.messages);
  els.activityBtn.hidden = false;
  refreshActivityBtn();
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

/* ------------------------- usage meter + context tips -------------------- */

function fmtK(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0); }
function fmtCost(n) { return '$' + (n || 0).toFixed(n < 0.1 ? 3 : 2); }

// Context window of the currently-selected model.
function currentWindow() {
  const id = modelSel ? modelSel.getValue() : (state.models[0] && state.models[0].id);
  const m = state.models.find((x) => x.id === id);
  return (m && m.ctx) || DEFAULT_WINDOW;
}

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
  if (r && typeof r.favorite === 'boolean') btn.classList.toggle('on', r.favorite);
  if (state.view === 'saved') refreshSaved();   // keep the Saved list live
}

/* -------------------------------- projects ------------------------------- */
/* The project picker is the entry screen: you must select (or initialize) a
 * project folder before the chat UI is shown. Each project scopes its chats. */

async function showProjectPicker() {
  state.project = null;
  state.activeId = null;
  state.view = 'threads';
  els.projectScreen.hidden = false;
  await renderProjects();
}

async function renderProjects() {
  let projects = [];
  try { ({ projects } = await api.projects()); } catch {}
  state.projects = projects || [];
  els.projectList.innerHTML = '';
  if (!state.projects.length) {
    els.projectList.innerHTML =
      `<li class="project-empty">${tr('project.none')}</li>`;
    return;
  }
  for (const p of state.projects) {
    const n = p.chatCount || 0;
    const when = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—';
    const chats = n === 1 ? tr('word.chat.one') : tr('word.chat.many');
    const li = document.createElement('li');
    li.className = 'project-card';
    li.innerHTML = `
      <button class="project-open">
        <span class="proj-name">${escapeHtml(p.name || basename(p.path))}</span>
        <span class="proj-path">${escapeHtml(p.path || '')}</span>
        <span class="proj-meta">${escapeHtml(tr('project.meta', { n, chats, when }))}</span>
      </button>
      <button class="proj-del" title="${tr('project.removeTitle')}">×</button>`;
    li.querySelector('.project-open').onclick = () => enterProject(p);
    li.querySelector('.proj-del').onclick = async (e) => {
      e.stopPropagation();
      const label = p.name || basename(p.path);
      if (!confirm(tr('project.removeConfirm', { label, n, chats }))) return;
      await api.deleteProject(p.id);
      renderProjects();
    };
    els.projectList.appendChild(li);
  }
}

async function enterProject(project) {
  try { project = (await api.selectProject(project.id)) || project; } catch {}
  state.project = project;
  els.cpName.textContent = project.name || basename(project.path);
  els.cpName.title = project.path || '';
  els.projectScreen.hidden = true;
  playLogoIntro(document.querySelector('aside.sidebar'));   // greet from the sidebar logo
  state.view = 'threads';
  els.search.value = '';
  els.savedToggle.classList.remove('active');
  await loadThreads();
  // Land on the most recent chat if there is one; otherwise the empty state.
  if (state.threads.length) openThread(state.threads[0].id);
  else showEmpty();
}

els.toProjects.onclick = () => showProjectPicker();

els.newProjectBtn.onclick = async () => {
  let path;
  try {
    path = await dialog.open({
      directory: true,
      multiple: false,
      title: tr('dialog.chooseFolder'),
    });
  } catch (e) {
    return alert(tr('dialog.pickerError', { err: (e && e.message) || e }));
  }
  if (!path) return;                              // cancelled
  const project = await api.createProject(path);  // creates, or re-opens if it exists
  await renderProjects();
  await enterProject(project);
  // A brand-new project has no chats yet — start one so the setup wizard has a
  // folder + model to work in, then launch it immediately.
  if (!state.activeId) {
    const t = await api.create(project.path);
    await loadThreads();
    await openThread(t.id);
  }
  openInit();
};

/* -------------------------------- new chat ------------------------------- */

els.newChat.onclick = async () => {
  if (!state.project) return;                     // no folder prompt — uses the open project
  const t = await api.create(state.project.path);
  await loadThreads();
  openThread(t.id);
};

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
  function open() { renderMenu(); menu.hidden = false; root.classList.add('on'); }
  function close() { menu.hidden = true; root.classList.remove('on'); }

  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
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

async function doClear(close) {
  if (close) close();
  if (!state.activeId) return;
  if (!confirm(tr('clear.confirm'))) return;
  await api.clear(state.activeId);
  state.tipLevelShown = null;
  await openThread(state.activeId);
  showTip({ key: 'status', icon: '✨', label: tr('clear.toastLabel'),
    body: tr('clear.toastBody') });
}

async function doCompact(close) {
  if (close) close();
  if (!state.activeId || state.streaming) return;
  els.compactBtn.disabled = true;
  els.compactBtn.textContent = tr('compact.tidying');
  try {
    const r = await api.compact(state.activeId);
    if (r.error) throw new Error(r.error);
    state.tipLevelShown = null;
    await openThread(state.activeId);
    showTip({ key: 'status', icon: '🧹', label: tr('compact.doneLabel'),
      body: tr('compact.doneBody') });
  } catch (e) {
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

/* --------------------- Activity: shells & sub-agents --------------------- */
/* The Activity button stays disabled until Claude runs a shell (Bash) or
 * launches a sub-agent (Task). Each such action is tracked here with its
 * command/description and — once the CLI reports it back — its output, so the
 * panel doubles as a live log of what Claude is doing under the hood (e.g. an
 * app it started). Entries persist with the chat via the saved segments. */

const ACTIVITY_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
const ACTIVITY_TOOLS = new Set(['Bash', 'Task']);   // shells & sub-agents
const ACT_ICON = { Bash: '⚡', Task: '🧩' };
const isActivityTool = (name) => ACTIVITY_TOOLS.has(name);

// Rebuild the activity list from a thread's saved messages (tool segments).
function activityFromSegments(messages) {
  const list = [];
  for (const m of (messages || [])) {
    if (m.role !== 'assistant' || !Array.isArray(m.segments)) continue;
    for (const s of m.segments) {
      if (s && s.type === 'tool' && isActivityTool(s.name)) {
        list.push({
          id: s.id || null, name: s.name, target: s.target || '', detail: s.detail || '',
          output: (s.output != null ? s.output : null), isError: !!s.isError, running: false,
        });
      }
    }
  }
  return list;
}

// Fold a streamed tool / tool_result event into state.activity.
function trackTool(msg) {
  if (msg.type === 'tool_result') {
    const it = msg.id && state.activity.find((a) => a.id === msg.id);
    if (it) { it.output = msg.output || ''; it.isError = !!msg.isError; it.running = false; }
  } else {
    if (!isActivityTool(msg.name)) return;
    let it = msg.id ? state.activity.find((a) => a.id === msg.id) : null;
    if (it) {                          // refine the same action (start → stop)
      if (msg.target) it.target = msg.target;
      if (msg.detail) it.detail = msg.detail;
      it.running = true;
    } else {
      state.activity.push({
        id: msg.id || ('t' + state.activity.length), name: msg.name,
        target: msg.target || '', detail: msg.detail || '',
        output: null, isError: false, running: true,
      });
    }
  }
  refreshActivityBtn();
  refreshActivityPanel();
}

function stopActivitySpinners() {
  let changed = false;
  for (const a of state.activity) if (a.running) { a.running = false; changed = true; }
  if (changed) { refreshActivityBtn(); refreshActivityPanel(); }
}

function refreshActivityBtn() {
  const n = state.activity.length;
  els.activityBtn.disabled = n === 0;
  const running = state.streaming && state.activity.some((a) => a.running);
  els.activityBtn.classList.toggle('live', running);
  const count = n ? `<span class="act-count">${n}</span>` : '';
  els.activityBtn.innerHTML = ACTIVITY_SVG + `<span>${running ? tr('activity.working') : tr('activity.label')}</span>` + count;
}

const ACT_FILTERS = ['all', 'active', 'done'];
function activityMatches(a, f) {
  return f === 'active' ? a.running : f === 'done' ? !a.running : true;
}
function renderActivityFilters() {
  const counts = {
    all: state.activity.length,
    active: state.activity.filter((a) => a.running).length,
    done: state.activity.filter((a) => !a.running).length,
  };
  els.activityFilters.innerHTML = ACT_FILTERS.map((f) =>
    `<button class="activity-filter${state.activityFilter === f ? ' on' : ''}" data-f="${f}">` +
    `${tr('activity.filter.' + f)} ${counts[f]}</button>`).join('');
}

function refreshActivityPanel() {
  if (els.activityOverlay.hidden) return;
  renderActivityFilters();
  const body = els.activityBody;
  if (!state.activity.length) {
    body.innerHTML = `<div class="activity-empty">${tr('activity.empty')}</div>`;
    return;
  }
  const list = state.activity.filter((a) => activityMatches(a, state.activityFilter));
  if (!list.length) {
    const msg = state.activityFilter === 'active' ? tr('activity.emptyActive') : tr('activity.emptyClosed');
    body.innerHTML = `<div class="activity-empty">${msg}</div>`;
    return;
  }
  body.innerHTML = '';
  for (const a of list) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    const cls = a.isError ? 'error' : (a.running ? 'running' : 'done');
    const stateLbl = tr('activity.state.' + cls);
    const kind = a.name === 'Task' ? tr('activity.kindAgent') : tr('activity.kindShell');
    const head = document.createElement('div');
    head.className = 'activity-item-head';
    head.innerHTML =
      `<span class="activity-ico" aria-hidden="true">${ACT_ICON[a.name] || '⚙️'}</span>` +
      `<span class="activity-name">${escapeHtml(kind)}</span>` +
      `<span class="activity-target">${escapeHtml(a.target || '')}</span>` +
      `<span class="activity-state ${cls}">${a.running ? '<span class="activity-spin"></span>' : ''}${escapeHtml(stateLbl)}</span>`;
    item.appendChild(head);
    if (a.detail) {
      const c = document.createElement('div');
      c.className = 'activity-cmd';
      c.textContent = (a.name === 'Bash' ? '$ ' : '') + a.detail;
      item.appendChild(c);
    }
    const pre = document.createElement('pre');
    pre.className = 'activity-out' + (a.isError ? ' err' : '');
    pre.textContent = a.output != null
      ? (a.output || tr('activity.noOutput'))
      : (a.running ? tr('activity.running') : tr('activity.noCapture'));
    item.appendChild(pre);
    body.appendChild(item);
  }
}

function openActivity() {
  if (els.activityBtn.disabled) return;
  els.activityOverlay.hidden = false;
  refreshActivityPanel();
}
function closeActivity() { els.activityOverlay.hidden = true; }

els.activityBtn.onclick = openActivity;
els.activityClose.onclick = closeActivity;
els.activityFilters.onclick = (e) => {
  const b = e.target.closest('.activity-filter');
  if (!b) return;
  state.activityFilter = b.dataset.f;
  refreshActivityPanel();
};

// Close on a genuine backdrop click, but not when a text drag-select happens to
// release over the backdrop (mirrors the Initialize/CLAUDE.md modal guard).
let actPressOnBackdrop = false;
els.activityOverlay.addEventListener('mousedown', (e) => { actPressOnBackdrop = (e.target === els.activityOverlay); });
els.activityOverlay.addEventListener('mouseup', (e) => {
  if (actPressOnBackdrop && e.target === els.activityOverlay) closeActivity();
  actPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.activityOverlay.hidden) closeActivity();
});

/* ----------------------------- search + saved ---------------------------- */

let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = els.search.value.trim();
  if (!q) {                          // cleared → back to conversations
    state.view = 'threads';
    els.savedToggle.classList.remove('active');
    loadThreads();
    return;
  }
  searchTimer = setTimeout(async () => {
    const { results } = await api.search(q, state.project && state.project.path);
    state.view = 'search';
    state.results = results || [];
    els.savedToggle.classList.remove('active');
    renderSidebar();
  }, 200);
});

async function refreshSaved() {
  const { favorites } = await api.favorites(state.project && state.project.path);
  state.results = favorites || [];
  renderSidebar();
}

els.savedToggle.onclick = async () => {
  if (state.view === 'saved') {       // toggle off → conversations
    state.view = 'threads';
    els.savedToggle.classList.remove('active');
    loadThreads();
  } else {
    els.search.value = '';
    state.view = 'saved';
    els.savedToggle.classList.add('active');
    await refreshSaved();
  }
};

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
  body.querySelectorAll('pre code').forEach((b) => window.hljs && hljs.highlightElement(b));
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
 * as an interactive card; since each turn is one-shot, picking an option (or
 * submitting a multi-select) sends the answer as the next message, which lets
 * Claude continue. Renders identically live and on reload (persisted segment). */
function sendAnswer(text) {
  if (!text || !text.trim() || state.streaming || !state.activeId) return;
  els.input.value = text;
  autosize();
  send();
}

function renderQuestionCard(seg) {
  const questions = Array.isArray(seg.questions) ? seg.questions : [];
  const card = document.createElement('div');
  card.className = 'qa-card';

  const intro = document.createElement('div');
  intro.className = 'qa-intro';
  intro.innerHTML = `<span class="qa-ico" aria-hidden="true">🗳️</span><span>${escapeHtml(tr('qa.title'))}</span>`;
  card.appendChild(intro);

  // Per-question selection sets. Single-question single-select sends on click.
  const sel = questions.map(() => new Set());
  const single = questions.length === 1 && !questions[0].multiSelect;

  function submit(forced) {
    if (card.classList.contains('answered')) return;
    const chosen = forced || sel.map((s) => [...s]);
    const parts = [];
    questions.forEach((q, qi) => {
      const ans = chosen[qi] || [];
      if (!ans.length) return;
      parts.push(questions.length === 1 ? ans.join(', ') : `${q.header || q.question}: ${ans.join(', ')}`);
    });
    const text = parts.join('\n');
    if (!text.trim()) return;
    card.classList.add('answered');
    card.querySelectorAll('.qa-opt, .qa-send').forEach((el) => { el.disabled = true; });
    sendAnswer(text);
  }

  questions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'qa-q';
    let h = '';
    if (q.header) h += `<div class="qa-head">${escapeHtml(q.header)}</div>`;
    if (q.question) h += `<div class="qa-text">${escapeHtml(q.question)}</div>`;
    block.innerHTML = h;
    const optsWrap = document.createElement('div');
    optsWrap.className = 'qa-opts';
    for (const opt of (q.options || [])) {
      const label = typeof opt === 'string' ? opt : (opt.label || '');
      const desc = typeof opt === 'string' ? '' : (opt.description || '');
      if (!label) continue;
      const b = document.createElement('button');
      b.className = 'qa-opt';
      b.innerHTML = `<span class="qa-opt-label">${escapeHtml(label)}</span>` +
        (desc ? `<span class="qa-opt-desc">${escapeHtml(desc)}</span>` : '');
      b.onclick = () => {
        if (card.classList.contains('answered')) return;
        if (single) { submit([[label]]); return; }
        if (sel[qi].has(label)) { sel[qi].delete(label); }
        else {
          if (!q.multiSelect) {
            sel[qi].clear();
            optsWrap.querySelectorAll('.qa-opt').forEach((x) => x.classList.remove('sel'));
          }
          sel[qi].add(label);
        }
        b.classList.toggle('sel', sel[qi].has(label));
      };
      optsWrap.appendChild(b);
    }
    block.appendChild(optsWrap);
    card.appendChild(block);
  });

  if (!single && questions.length) {
    const foot = document.createElement('div');
    foot.className = 'qa-foot';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'qa-send';
    sendBtn.textContent = tr('qa.send');
    sendBtn.onclick = () => submit(null);
    foot.appendChild(sendBtn);
    card.appendChild(foot);
  }
  return card;
}

/* Build one "action chip" — the persisted, on-its-own-line record of a tool
 * action. `working` shows a live spinner + glow; otherwise a settled dot.
 * Shared by the live stream and the reload path so they look identical. */
function renderActionChip(seg, working) {
  const name = seg.name || '';
  const target = seg.target || '';
  const label = toolLabel(name) + (target ? ' · ' + target : '');
  const summary = toolSummary(name, target, seg.detail);
  const el = document.createElement('div');
  el.className = 'action-chip ' + (working ? 'working' : 'done');
  if (summary) el.title = summary;
  el.innerHTML =
    '<span class="chip-status" aria-hidden="true"></span>' +
    `<span class="chip-ico" aria-hidden="true">${TOOL_ICON[name] || '⚙️'}</span>` +
    `<span class="chip-label">${escapeHtml(label)}</span>`;
  return el;
}

// Transient "thinking" indicator (not persisted) shown before the first token.
function renderThinkingChip() {
  const el = document.createElement('div');
  el.className = 'action-chip working thinking';
  el.innerHTML =
    '<span class="chip-status" aria-hidden="true"></span>' +
    `<span class="chip-label">${tr('chip.thinking')}</span>`;
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
      d.querySelectorAll('pre code').forEach((b) => window.hljs && hljs.highlightElement(b));
      bubble.appendChild(d);
    }
  }
}

/* A plain-language, one-sentence description of exactly what a tool call is
 * doing — shown as the tooltip when you hover the activity chip. Uses the full
 * (untruncated) detail so the hover reveals more than the chip's short label. */
function toolSummary(name, target, detail) {
  const d = (detail || target || '').trim();
  const label = toolLabel(name);
  return d ? `${label}: ${d}` : label;
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
els.sendBtn.onclick = send;

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
      textEl.querySelectorAll('pre code').forEach((b) => window.hljs && hljs.highlightElement(b));
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
        d.querySelectorAll('pre code').forEach((b) => window.hljs && hljs.highlightElement(b));
        bubble.appendChild(d);
      }
      if (errMsg) {
        const d = document.createElement('div');
        d.className = 'action-chip error';
        d.textContent = '⚠ ' + errMsg;
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
    push(t) {
      clearThinking();
      if (!textEl) openTextBlock();   // text after a chip starts a fresh block
      pending += t;
      run();
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
  };
}

async function send() {
  const text = els.input.value.trim();
  if (!text || state.streaming || !state.activeId) return;

  // render the user message + clear composer. Sending re-engages auto-follow
  // (you want to watch the new reply), even if you'd scrolled up earlier.
  stickToBottom = true;
  appendMessage('user', text, null);
  els.input.value = '';
  autosize();
  scrollFeed();

  // assistant placeholder + typewriter
  const aDiv = appendMessage('assistant', '', null);
  const typer = makeTyper(aDiv.querySelector('.bubble'));
  typer.thinking();
  scrollFeed();

  state.streaming = true;
  els.sendBtn.disabled = true;

  try {
    // A Channel carries the streamed events from the Rust `chat` command,
    // exactly as the SSE stream did over HTTP.
    const channel = new Channel();
    channel.onmessage = (msg) => {
      const event = msg.type;
      if (event === 'token') typer.push(msg.text);
      else if (event === 'tool') { typer.setTool(msg); trackTool(msg); }
      else if (event === 'tool_result') trackTool(msg);
      else if (event === 'done') {
        typer.finish(msg.text);
        stopActivitySpinners();
        if (msg.title) els.title.textContent = msg.title;
        if (msg.usage) updateUsage(msg.usage);
        if (msg.assistantId) {        // make the fresh reply starrable right away
          aDiv.dataset.mid = msg.assistantId;
          const sb = aDiv.querySelector('.star');
          if (sb) { sb.disabled = false; sb.onclick = () => toggleStar(aDiv, sb); }
        }
        if (state.view === 'threads') loadThreads();
      } else if (event === 'error') { typer.error(msg.message || 'error'); stopActivitySpinners(); }
    };

    await invoke('chat', { threadId: state.activeId, text, onEvent: channel });
  } catch (e) {
    typer.error(String(e && e.message || e));
  } finally {
    state.streaming = false;
    els.sendBtn.disabled = false;
    els.input.focus();
    stopActivitySpinners();   // clear any lingering spinner if the stream ended abruptly
    refreshActivityBtn();     // drop the "live" pulse now that streaming is over
  }
}

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

function showInitOverlay() { els.initOverlay.hidden = false; }
function closeInit() {
  els.initOverlay.hidden = true;
  els.initBody.innerHTML = '';
  els.initFoot.innerHTML = '';
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
  renderBrief();
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
function renderBrief() {
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
    renderQuestions();
  } catch (e) {
    initError(String(e.message || e), runAnalyze);
  }
}

function renderQuestions() {
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

function collectAnswers() {
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
  const answers = collectAnswers();
  if (!answers.length) {
    showTip({ key: 'status', cls: 'warn', icon: '✍️', label: tr('wiz.moreLabel'),
      body: tr('wiz.moreBody') });
    return;
  }
  initLoading(tr('wiz.writingTitle'), tr('wiz.writingSub'), 'review');
  try {
    const data = await api.initDraft(state.activeId, wiz.summary, answers, wiz.brief);
    if (data.error) { renderQuestions(); return initError(data.error, generateDraft); }
    wiz.markdown = data.markdown || '';
    renderReview();
  } catch (e) {
    renderQuestions();
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
  els.initFoot.appendChild(footBtn(tr('wiz.backToQuestions'), 'ghost', renderQuestions));
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

/* ------------------------------ localization ----------------------------- */
/* The flag toggle (top-right) flips between English and Hrvatski. i18n.js
 * re-translates the static DOM and fires 'i18n:changed'; we then re-render the
 * dynamic surfaces (pickers, sidebar, open thread) so nothing is left stale. */

const FLAG_SVG = {
  en:
    '<svg class="flag" viewBox="0 0 24 16" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect width="24" height="16" fill="#b22234"/>' +
    '<rect y="1.23" width="24" height="1.23" fill="#fff"/><rect y="3.69" width="24" height="1.23" fill="#fff"/>' +
    '<rect y="6.15" width="24" height="1.23" fill="#fff"/><rect y="8.62" width="24" height="1.23" fill="#fff"/>' +
    '<rect y="11.08" width="24" height="1.23" fill="#fff"/><rect y="13.54" width="24" height="1.23" fill="#fff"/>' +
    '<rect width="10" height="8.62" fill="#3c3b6e"/></svg>',
  hr:
    '<svg class="flag" viewBox="0 0 24 16" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect width="24" height="5.33" fill="#ff0000"/><rect y="5.33" width="24" height="5.34" fill="#fff"/>' +
    '<rect y="10.67" width="24" height="5.33" fill="#171796"/>' +
    '<rect x="10" y="4" width="4" height="8" fill="#fff" stroke="#ff0000" stroke-width="0.4"/>' +
    '<rect x="10" y="4" width="2" height="2" fill="#ff0000"/><rect x="12" y="6" width="2" height="2" fill="#ff0000"/>' +
    '<rect x="10" y="8" width="2" height="2" fill="#ff0000"/><rect x="12" y="10" width="2" height="2" fill="#ff0000"/></svg>',
};
const LANG_CODE = { en: 'EN', hr: 'HR' };

function updateLangBtn() {
  const cur = window.I18N.getLang();
  const html = FLAG_SVG[cur] + `<span class="lang-code">${LANG_CODE[cur]}</span>`;
  document.querySelectorAll('.lang-toggle').forEach((b) => { b.innerHTML = html; });
}

function relocalizeDynamic() {
  buildPickers();                          // re-translate model/mode (keeps selection)
  // The Insight button's label can lose its data-i18n span after use — refresh it.
  if (!els.hintBtn.disabled) {
    els.hintBtn.innerHTML = INSIGHT_SVG + `<span data-i18n="hint.label">${tr('hint.label')}</span>`;
  }
  if (!state.project) { renderProjects(); return; }
  if (state.view === 'saved') refreshSaved();
  else renderSidebar();                    // threads / search use cached data
  if (state.activeId) openThread(state.activeId);
  else showEmpty();
}

document.querySelectorAll('.lang-toggle').forEach((b) => {
  b.onclick = () => window.I18N.setLang(window.I18N.getLang() === 'en' ? 'hr' : 'en');
});
document.addEventListener('i18n:changed', () => {
  updateLangBtn();
  relocalizeDynamic();
});

/* Split each "RYSTAL" wordmark into per-letter spans so the hover glow can
 * ripple across them (staggered animation-delay). Done once at startup. */
function enhanceLogos() {
  document.querySelectorAll('.logo-rest').forEach((el) => {
    if (el.dataset.split) return;
    const text = el.textContent;
    el.textContent = '';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ltr';
      s.textContent = ch;
      s.style.animationDelay = (i * 0.07) + 's';
      el.appendChild(s);
    });
    el.dataset.split = '1';
  });
}

/* Play the logo intro (K pulse + RYSTAL glow wave) once. The `boot` class is
 * stripped afterwards so the hover animations work normally. */
function playLogoIntro(root) {
  (root || document).querySelectorAll('.logo').forEach((logo) => {
    logo.classList.remove('boot');
    void logo.offsetWidth;            // reflow so the animation can restart
    logo.classList.add('boot');
    setTimeout(() => logo.classList.remove('boot'), 3400);
  });
}

/* --------------------------------- init ---------------------------------- */
/* Every launch starts on the project picker — you choose a project to enter. */

enhanceLogos();
playLogoIntro();
updateLangBtn();
populatePickers();
showProjectPicker();
