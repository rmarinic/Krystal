/* projects.js   — project picker (entry screen), new chat, welcome Initialize
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------------- projects ------------------------------- */
/* The project picker is the entry screen: you must select (or initialize) a
 * project folder before the chat UI is shown. Each project scopes its chats. */

async function showProjectPicker() {
  state.project = null;
  state.activeId = null;
  state.view = 'threads';
  els.projectScreen.classList.remove('leaving');
  els.projectScreen.hidden = false;
  syncDiscordProject();
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
  syncDiscordProject();
  els.cpName.textContent = project.name || basename(project.path);
  els.cpName.title = project.path || '';
  // Ease the picker out of the way rather than cutting to the chat.
  const screen = els.projectScreen;
  screen.classList.add('leaving');
  setTimeout(() => { screen.hidden = true; screen.classList.remove('leaving'); }, 240);
  playLogoIntro(document.querySelector('aside.sidebar'));   // greet from the sidebar logo
  state.view = 'threads';
  els.search.value = '';
  els.savedToggle.classList.remove('active');
  await loadThreads();
  // Always land on the welcome screen: the chats live in the sidebar to pick
  // from, and the empty state offers "new chat" / "Initialize" — so the project
  // entry feels intentional rather than dumping you mid-conversation.
  showEmpty();
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
  await enterProject(project);   // lands on the welcome screen; user starts a chat / Initializes
};

/* -------------------------------- new chat ------------------------------- */

// The id of a just-created chat, so renderSidebar can play its entrance once.
let justAddedThreadId = null;

async function startNewChat() {
  if (!state.project) return;                     // no folder prompt — uses the open project
  const t = await api.create(state.project.path);
  justAddedThreadId = t.id;                        // pops in when the sidebar redraws
  await loadThreads();
  await openThread(t.id);
  replayClass(els.composer, 'fresh', 700);        // gentle "fresh chat" settle
  return t;
}
els.newChat.onclick = startNewChat;

/* Welcome-screen Initialize button. When the project already has a CLAUDE.md it
 * reads "Reinitialize" and warns before overwriting that memory. */
let welcomeHasMemory = false;
function applyWelcomeInitLabel() {
  els.emptyInit.textContent = tr(welcomeHasMemory ? 'empty.reinitBtn' : 'empty.initBtn');
}
async function refreshWelcomeInit() {
  if (!state.project) return;
  try {
    const r = await api.claudeMdExists(state.project.path);
    welcomeHasMemory = !!(r && r.exists);
  } catch (_) { welcomeHasMemory = false; }
  applyWelcomeInitLabel();
}

els.emptyNewChat.onclick = startNewChat;
els.emptyInit.onclick = async () => {
  if (!state.project) return;
  // Reinitialize overwrites the existing memory — confirm first.
  if (welcomeHasMemory && !confirm(tr('empty.reinitConfirm'))) return;
  if (!state.activeId) await startNewChat();   // the wizard needs a chat (cwd + model)
  openInit();
};

