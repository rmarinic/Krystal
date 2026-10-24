/* palette.js    — the command palette (Ctrl+K): one box to jump to any chat or
                   project, run an action, or open a setting
   Part of the chat frontend; shares one global scope (see core.js).

   The list is rebuilt each time it opens, from what is true right then: the
   open project's chats, the projects, and only the actions that can run now —
   Compact is not offered mid-turn, Edit instructions not without a chat. An
   action runs by clicking the button it stands for wherever that exists, so the
   palette inherits every guard and confirmation the button already has instead
   of keeping a second copy of them.

   Matching is loose on purpose: the typed letters in order, not necessarily
   side by side ("cmp" finds Compact), ignoring case and diacritics (so "sazmi"
   finds Sažmi). Tighter and earlier matches rank first. With anything typed,
   the last row offers to search every message for it (the sidebar search). */

const palette = { el: null, input: null, list: null, items: [], shown: [], at: 0 };

/* The usable form of a button: present, showing, enabled. */
function paletteBtn(b) { return b && !b.hidden && !b.disabled && b.offsetParent !== null ? b : null; }

function paletteItems() {
  const out = [];
  const add = (group, ico, label, run, extra) => out.push(Object.assign({ group, ico, label, run }, extra));
  const click = (b) => () => b.click();

  // Chats in this project, most recent first (as the sidebar has them).
  if (state.project) {
    for (const t of state.threads || []) {
      add('chats', 'chat', t.title || tr('nav.newChatTitle'), () => openThread(t.id),
        { sub: stampLabel(t.updatedAt), current: t.id === state.activeId });
    }
  }
  // Every project, to jump straight into one.
  for (const p of state.projects || []) {
    if (state.project && p.path === state.project.path) continue;
    add('projects', 'folder', p.name || basename(p.path), () => enterProject(p), { sub: p.path });
  }

  // Actions — each only when its button could be pressed right now.
  if (state.project) add('actions', 'plus', tr('palette.newChat'), () => startNewChat(), { keys: ['Ctrl', 'N'] });
  const chatActions = [
    [els.compactBtn, 'compact', 'palette.compact'],
    [els.clearBtn, 'trash', 'palette.clear'],
    [els.branchBtn, 'branch', 'palette.branch'],
    [els.activityBtn, 'terminal', 'palette.activity'],
    [els.tasksBtn, 'todo', 'palette.tasks'],
    [els.artifactsBtn, 'artifact', 'palette.artifacts'],
    [els.runBtn, 'play', 'palette.run'],
  ];
  for (const [b, ico, key] of chatActions) if (paletteBtn(b)) add('actions', ico, tr(key), click(b));
  if (state.activeId) add('actions', 'doc', tr('palette.instructions'), () => openClaudeEditor());
  if (state.project) add('actions', 'swap', tr('palette.projects'), () => showProjectPicker(), { keys: ['Ctrl', 'W'] });

  // Settings.
  add('settings', 'gear', tr('palette.settings'), () => openSettings());
  add('settings', 'command', tr('palette.shortcuts'), () => openSettings('keys'), { keys: ['Ctrl', 'S'] });
  add('settings', 'chart', tr('palette.usage'), () => openSettings('usage'));
  add('settings', 'monitor', tr('palette.remote'), () => openSettings('remote'));
  add('settings', 'language', tr('palette.language'),
    () => window.I18N.setLang(window.I18N.getLang() === 'en' ? 'hr' : 'en'));
  return out;
}

/* Does `query` match `label`? null if not; else a score (lower is better) and
 * the label as HTML with the matched letters marked. */
function paletteMatch(label, query) {
  if (!query) return { score: 0, html: escapeHtml(label) };
  // Fold one character at a time, remembering which character each folded
  // letter came from, so the marks land on the right letters of the label.
  const chars = [...label];
  let L = '';
  const owner = [];
  chars.forEach((c, k) => { const f = foldText(c); L += f; for (let i = 0; i < f.length; i++) owner.push(k); });
  const Q = foldText(query).replace(/\s+/g, ' ');
  const hit = new Set();
  let from = 0, last = -1, gaps = 0, first = -1;
  for (const ch of Q) {
    if (ch === ' ') continue;
    const j = L.indexOf(ch, from);
    if (j < 0) return null;
    if (first < 0) first = j;
    if (last >= 0) gaps += j - last - 1;
    hit.add(owner[j]); last = j; from = j + 1;
  }
  const word = L.startsWith(Q) ? -100 : (L.includes(Q) ? -50 : 0);
  const html = chars.map((c, k) => (hit.has(k) ? `<mark>${escapeHtml(c)}</mark>` : escapeHtml(c))).join('');
  return { score: word + gaps * 2 + first, html };
}

function buildPalette() {
  const el = document.createElement('div');
  el.className = 'palette-overlay';
  el.hidden = true;
  el.innerHTML =
    `<div class="palette" role="dialog" aria-modal="true" aria-label="${escapeHtml(tr('palette.title'))}">` +
      `<div class="palette-in">${icon('search')}` +
        `<input type="text" class="palette-q" autocomplete="off" spellcheck="false"></div>` +
      `<div class="palette-list" role="listbox"></div>` +
      `<div class="palette-foot"></div>` +
    `</div>`;
  document.body.appendChild(el);
  palette.el = el;
  palette.input = el.querySelector('.palette-q');
  palette.list = el.querySelector('.palette-list');

  palette.input.addEventListener('input', () => { palette.at = 0; renderPalette(); });
  palette.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(palette.at); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); closePalette(); }
  });
  el.addEventListener('mousedown', (e) => { if (e.target === el) closePalette(); });
}

function renderPalette() {
  const query = palette.input.value.trim();
  const shown = [];
  for (const it of palette.items) {
    const m = paletteMatch(it.label, query);
    if (m) shown.push({ it, m });
  }
  if (query) {
    shown.sort((a, b) => a.m.score - b.m.score);
    // …and always, last: look for it in what was said, not just in the names.
    shown.push({
      it: { group: 'search', ico: 'search', label: tr('palette.searchFor', { q: query }), run: () => searchAllChats(query) },
      m: { html: escapeHtml(tr('palette.searchFor', { q: query })) },
    });
  }
  palette.shown = shown;
  palette.at = Math.max(0, Math.min(palette.at, shown.length - 1));

  let html = '', group = null;
  shown.forEach(({ it, m }, k) => {
    if (!query && it.group !== group) {
      group = it.group;
      html += `<div class="palette-group">${escapeHtml(tr('palette.group.' + group))}</div>`;
    }
    const sub = it.sub ? `<span class="palette-sub">${escapeHtml(it.sub)}</span>` : '';
    const keys = it.keys ? `<span class="palette-keys">${it.keys.map((x) => `<kbd>${escapeHtml(x)}</kbd>`).join('')}</span>` : '';
    const here = it.current ? `<span class="palette-here">${escapeHtml(tr('palette.here'))}</span>` : '';
    html += `<div class="palette-item${k === palette.at ? ' on' : ''}" role="option" data-k="${k}">` +
      `${icon(it.ico)}<span class="palette-label">${m.html}</span>${sub}${here}${keys}</div>`;
  });
  if (!shown.length) html = `<div class="palette-empty">${escapeHtml(tr('palette.empty'))}</div>`;
  palette.list.innerHTML = html;
  palette.list.querySelectorAll('.palette-item').forEach((row) => {
    row.onmousemove = () => { const k = +row.dataset.k; if (k !== palette.at) { palette.at = k; paintPaletteAt(); } };
    row.onclick = () => runPaletteItem(+row.dataset.k);
  });
}

function paintPaletteAt() {
  palette.list.querySelectorAll('.palette-item').forEach((row) => row.classList.toggle('on', +row.dataset.k === palette.at));
  const on = palette.list.querySelector('.palette-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function movePalette(dir) {
  if (!palette.shown.length) return;
  palette.at = (palette.at + dir + palette.shown.length) % palette.shown.length;
  paintPaletteAt();
}

function runPaletteItem(k) {
  const x = palette.shown[k];
  if (!x) return;
  closePalette();
  Promise.resolve().then(() => x.it.run()).catch(() => {});
}

/* The sidebar's full-text search, as if typed there. */
function searchAllChats(q) {
  if (!state.project) return;
  els.search.value = q;
  els.search.dispatchEvent(new Event('input'));
  els.search.focus();
}

function openPalette() {
  if (!palette.el) buildPalette();
  palette.input.placeholder = tr('palette.placeholder');
  palette.el.querySelector('.palette-foot').innerHTML = escapeHtml(tr('palette.hint'));
  palette.items = paletteItems();
  palette.input.value = '';
  palette.at = 0;
  renderPalette();
  palette.el.hidden = false;
  requestAnimationFrame(() => palette.el.classList.add('open'));
  palette.input.focus();
}

function closePalette() {
  if (!palette.el || palette.el.hidden) return;
  palette.el.classList.remove('open');
  setTimeout(() => { if (!palette.el.classList.contains('open')) palette.el.hidden = true; }, 160);
  if (state.activeId && els.input && !els.composer.hidden) els.input.focus();
}

function togglePalette() {
  if (palette.el && !palette.el.hidden && palette.el.classList.contains('open')) closePalette();
  else openPalette();
}
