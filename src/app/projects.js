/* projects.js   — project picker (entry screen), new chat, welcome Initialize
   Part of the chat frontend; shares one global scope (see core.js). */
/* -------------------------------- projects ------------------------------- */
/* The project picker is the entry screen: you must select (or initialize) a
 * project folder before the chat UI is shown. Each project scopes its chats. */

async function showProjectPicker() {
  state.project = null;
  if (typeof renderPins === 'function') renderPins();     // no project → no rail
  state.activeId = null;
  state.view = 'threads';
  // Back at the picker there's no chat to queue for — park what each one holds.
  if (typeof setAttachmentThread === 'function') setAttachmentThread(null);
  if (typeof setRefsThread === 'function') setRefsThread(null);
  showTasksBtn(false);
  showRemoteBtn(false);
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
  if (remoteBlocks(tr('remote.blocked.moveProject'))) return;
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
  if (typeof refreshPins === 'function') refreshPins();   // this project's pinned files
  if (typeof refreshSkills === 'function') refreshSkills();   // its `/` skills
  refreshProjectDirs();                                       // and its extra folders
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
  if (remoteBlocks(tr('remote.blocked.newProject'))) return;
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


/* ------------------------- folders Claude can use ------------------------- *
 * A project is one folder, which is the right default and the wrong limit: the
 * brand assets, the shared notes, the second repo all live somewhere else, and
 * the only way to include them used to be to make one of them the project.
 *
 * Extra folders are granted per project and reach the CLI as `--add-dir`, so
 * they're a permission list rather than a bookmark list — Claude can read and
 * write in them exactly as it does in the project folder. They're also part of
 * the session key, so granting or revoking one retires the warm process and the
 * next message starts a session that can (or can no longer) see the folder;
 * the panel says so rather than letting it be a surprise.
 *
 * The way in is the folder path already under the chat title — the one place a
 * user is looking when they wonder where Claude can reach. */

let projectDirs = [];

const DIR_ERRORS = {
  'not-a-folder': 'dirs.errMissing',
  'already-included': 'dirs.errInside',
};

/* Load this project's extra folders and update the count beside the path. */
async function refreshProjectDirs() {
  if (!state.project) { projectDirs = []; paintDirBadge(); return; }
  try {
    const r = await api.listProjectDirs(state.project.path);
    projectDirs = (r && r.dirs) || [];
  } catch { projectDirs = []; }
  paintDirBadge();
  if (els.dirsOverlay && !els.dirsOverlay.hidden) renderDirsPanel();
}

/* "+2 folders" next to the project path — quiet, and only when there are any. */
function paintDirBadge() {
  const el = els.cwdExtra;
  if (!el) return;
  const n = projectDirs.length;
  el.textContent = n ? tr('dirs.badge', { n }) : '';
  el.hidden = !n;
}

function renderDirsPanel() {
  const body = els.dirsBody;
  if (!body || !state.project) return;
  const rows = [
    // The project folder itself: always there, never removable — showing it is
    // what makes the list an answer to "where can Claude reach?".
    `<li class="dir-row home">` +
      `<span class="dir-ico" aria-hidden="true">🏠</span>` +
      `<span class="dir-text">` +
        `<span class="dir-path">${escapeHtml(state.project.path)}</span>` +
        `<span class="dir-tag">${escapeHtml(tr('dirs.projectFolder'))}</span>` +
      `</span>` +
    `</li>`,
  ];
  for (const d of projectDirs) {
    rows.push(
      `<li class="dir-row" data-id="${d.id}">` +
        `<span class="dir-ico" aria-hidden="true">📁</span>` +
        `<span class="dir-text"><span class="dir-path">${escapeHtml(d.path)}</span></span>` +
        `<button type="button" class="dir-x" title="${escapeHtml(tr('dirs.remove'))}" ` +
          `aria-label="${escapeHtml(tr('dirs.remove'))}">×</button>` +
      `</li>`
    );
  }
  body.innerHTML =
    `<p class="dirs-sub">${escapeHtml(tr('dirs.sub'))}</p>` +
    `<ul class="dirs-list">${rows.join('')}</ul>`;
  for (const li of body.querySelectorAll('.dir-row[data-id]')) {
    const x = li.querySelector('.dir-x');
    if (x) x.onclick = () => removeProjectFolder(Number(li.dataset.id));
  }
}

function openDirsPanel() {
  if (!state.project) return;
  renderDirsPanel();
  openOverlay(els.dirsOverlay);
  refreshProjectDirs();   // re-read in case another window changed them
}

function closeDirsPanel() {
  closeOverlay(els.dirsOverlay, () => { els.dirsBody.innerHTML = ''; });
}

async function addProjectFolder() {
  if (!state.project) return;
  if (remoteBlocks(tr('remote.blocked.addFolder'))) return;
  let path;
  try {
    path = await dialog.open({
      directory: true,
      multiple: false,
      defaultPath: state.project.path || undefined,
      title: tr('dirs.dialogTitle'),
    });
  } catch (e) {
    return alert(tr('dialog.pickerError', { err: (e && e.message) || e }));
  }
  if (!path) return;                                  // cancelled
  try {
    const r = await api.addProjectDir(state.project.path, path);
    if (r && r.dirs) projectDirs = r.dirs;
  } catch (e) {
    const err = String((e && e.message) || e);
    return alert(tr(DIR_ERRORS[err] || 'dirs.errFailed', { err }));
  }
  paintDirBadge();
  renderDirsPanel();
  // Settle a quiet ring on the row that just landed.
  const rows = els.dirsBody.querySelectorAll('.dir-row[data-id]');
  if (rows.length) replayClass(rows[rows.length - 1], 'added', 700);
}

async function removeProjectFolder(id) {
  if (!state.project) return;
  try {
    const r = await api.removeProjectDir(state.project.path, id);
    if (r && r.dirs) projectDirs = r.dirs;
  } catch {}
  paintDirBadge();
  renderDirsPanel();
}

if (els.cwdBtn) els.cwdBtn.onclick = openDirsPanel;
if (els.dirsAdd) els.dirsAdd.onclick = addProjectFolder;
if (els.dirsClose) els.dirsClose.onclick = closeDirsPanel;
if (els.dirsOverlay) {
  // Click the backdrop (not the panel) to dismiss.
  els.dirsOverlay.addEventListener('mousedown', (e) => {
    if (e.target === els.dirsOverlay) closeDirsPanel();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.dirsOverlay && !els.dirsOverlay.hidden) closeDirsPanel();
});

// The panel's labels are localized; re-render if it's open on a language switch.
window.addEventListener('i18n:changed', () => {
  paintDirBadge();
  if (els.dirsOverlay && !els.dirsOverlay.hidden) renderDirsPanel();
});
