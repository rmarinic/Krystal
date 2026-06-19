/* sidebar.js    — thread list, inline rename, search/saved results rendering
   Part of the chat frontend; shares one global scope (see core.js). */
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
    if (t.id === justAddedThreadId) { li.classList.add('just-added'); justAddedThreadId = null; }
    li.innerHTML = `
      <a>
        <span class="time">${timeLabel(t.updatedAt)}</span>
        <span class="sum">${escapeHtml(t.title || tr('nav.newChatTitle'))}</span>
        <span class="cwd">${escapeHtml(t.cwd)}</span>
      </a>
      <button class="rename" title="${tr('sidebar.renameTitle')}">✎</button>
      <button class="del" title="${tr('sidebar.deleteTitle')}">×</button>`;
    li.querySelector('a').onclick = () => openThread(t.id);
    li.querySelector('.rename').onclick = (e) => {
      e.stopPropagation();
      beginRename(li, t);
    };
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(tr('sidebar.deleteConfirm'))) return;
      // Collapse the row away before the list re-renders — a tidy, deliberate exit.
      li.classList.add('removing');
      await api.remove(t.id);
      if (state.activeId === t.id) { state.activeId = null; showEmpty(); }
      setTimeout(loadThreads, 220);
    };
    els.threadList.appendChild(li);
  }
}

/* Rename a chat inline. Swaps the title line for a text input; Enter/blur saves,
 * Escape cancels. Shared shape for the sidebar row and the header title. */
async function commitRename(id, title, fallback) {
  const next = (title || '').trim();
  if (!next || next === fallback) return false;
  try {
    const r = await api.rename(id, next);
    const saved = (r && r.title) || next;
    // Reflect the new name everywhere it shows.
    state.threads = state.threads.map((t) => t.id === id ? { ...t, title: saved } : t);
    if (id === state.activeId) els.title.textContent = saved;
    if (state.view === 'threads') renderSidebar();
    return true;
  } catch (_) { return false; }
}

function beginRename(li, t) {
  const sum = li.querySelector('.sum');
  if (!sum || li.querySelector('.rename-input')) return;
  const cur = t.title || tr('nav.newChatTitle');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = cur;
  input.placeholder = tr('rename.placeholder');
  sum.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    if (save) await commitRename(t.id, input.value, cur);
    if (state.view === 'threads') renderSidebar();   // restore the row either way
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
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

/* Close a modal overlay with its exit animation: add `.closing` (CSS plays the
 * fade/scale-out), then hide and run an optional cleanup once it's done. */
function closeOverlay(overlay, after) {
  if (!overlay || overlay.hidden) { if (after) after(); return; }
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('closing');
    if (after) after();
  }, 190);
}
/* Show an overlay, cancelling any in-flight close animation. */
function openOverlay(overlay) {
  overlay.classList.remove('closing');
  overlay.hidden = false;
}

/* Replay a one-shot CSS animation on an element (restart-safe): drop the class,
 * force a reflow, re-add it. Used for tab/status crossfades and small pulses. */
function replayClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (ms) setTimeout(() => el.classList.remove(cls), ms);
}

