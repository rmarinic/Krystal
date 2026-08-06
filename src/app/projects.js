/* projects.js   — project picker (entry screen), new chat, welcome Initialize
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------------- projects ------------------------------- */
/* The project picker is the entry screen: you must select (or initialize) a
 * project folder before the chat UI is shown. Each project scopes its chats. */

async function showProjectPicker() {
  state.project = null;
  state.activeId = null;
  state.view = 'threads';
  // Back at the picker there's no chat to queue for — park what each one holds.
  if (typeof setAttachmentThread === 'function') setAttachmentThread(null);
  if (typeof setRefsThread === 'function') setRefsThread(null);
  showTasksBtn(false);
  setRunBtn(false);
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
    li.dataset.pid = p.id;
    li.innerHTML = `
      <button class="project-open">
        <span class="proj-name">${escapeHtml(p.name || basename(p.path))}</span>
        <span class="proj-path">${escapeHtml(p.path || '')}</span>
        <span class="proj-meta">${escapeHtml(tr('project.meta', { n, chats, when }))}</span>
      </button>
      <button class="proj-move" title="${escapeHtml(tr('project.moveTitle'))}">📁</button>
      <button class="proj-del" title="${tr('project.removeTitle')}">×</button>`;
    li.querySelector('.project-open').onclick = () => enterProject(p);
    li.querySelector('.proj-move').onclick = (e) => {
      e.stopPropagation();
      moveProjectFolder(p);
    };
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

/* Point a project at a different folder — you moved or renamed it on disk, or the
 * same work lives somewhere else now. The project keeps its identity: its chats,
 * tasks and run command all follow it (the backend re-keys them). What doesn't
 * follow is Claude's own session per chat — that store is keyed by folder, so the
 * next message starts a fresh one. The confirmation says so out loud. */
const MOVE_ERRORS = {
  'not-a-folder': 'project.moveErrMissing',
  'folder-taken': 'project.moveErrTaken',
  'run-in-flight': 'project.moveErrRunning',
};

async function moveProjectFolder(p) {
  let path;
  try {
    path = await dialog.open({
      directory: true,
      multiple: false,
      defaultPath: p.path || undefined,
      title: tr('dialog.chooseNewFolder'),
    });
  } catch (e) {
    return alert(tr('dialog.pickerError', { err: (e && e.message) || e }));
  }
  if (!path || path === p.path) return;            // cancelled, or the same folder
  const n = p.chatCount || 0;
  const chats = n === 1 ? tr('word.chat.one') : tr('word.chat.many');
  const label = p.name || basename(p.path);
  if (!confirm(tr('project.moveConfirm', { label, from: p.path || '—', to: path, n, chats }))) return;

  try {
    await api.moveProject(p.id, path);
  } catch (e) {
    const err = String((e && e.message) || e);
    return alert(tr(MOVE_ERRORS[err] || 'project.moveErrFailed', { err }));
  }
  await renderProjects();
  // Settle a quiet ring on the card that just changed folder.
  const card = els.projectList.querySelector(`[data-pid="${cssEsc(p.id)}"]`);
  if (card) replayClass(card, 'moved', 700);
}

async function enterProject(project) {
  try { project = (await api.selectProject(project.id)) || project; } catch {}
  state.project = project;
  syncDiscordProject();
  els.cpName.textContent = project.name || basename(project.path);
  els.cpName.title = project.path || '';
  refreshRunBtn();   // a run may already be in flight for this folder
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

