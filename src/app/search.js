/* search.js     — sidebar search + Saved (favorites) toggle
   Part of the chat frontend; shares one global scope (see core.js). */
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
    await loadThreads();
  } else {
    els.search.value = '';
    state.view = 'saved';
    els.savedToggle.classList.add('active');
    await refreshSaved();
  }
  replayClass(els.threadList, 'list-swap');   // crossfade between the two views
};

