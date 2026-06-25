/* tasks.js      — per-project to-do list (manual + Claude-generated)
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------- tasks ----------------------------------- */
/* A small to-do list that belongs to the open PROJECT (not a single chat), so
 * it's reachable from the sidebar foot at any time. You can add/rename/complete/
 * delete tasks by hand, or describe what you want and have Claude break it into
 * clear tasks — asking a few clarifying questions first when it needs to. The
 * panel is a tiny state machine: list ⇄ generate-brief → (questions) → list. */

const taskUI = {
  tasks: [],          // current project's tasks (source of truth while open)
  view: 'list',       // 'list' | 'brief' | 'questions'
  brief: '',          // the description being turned into tasks
  questions: [],      // clarifying questions Claude returned
  sel: {},            // answers, keyed by question id (mirrors the wizard)
  newIds: new Set(),  // tasks just added, for a one-shot highlight
  busy: false,
};

const TASK_CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

function projectPath() { return state.project && state.project.path; }
function openTaskCount() { return taskUI.tasks.filter((t) => !t.done).length; }

/* The sidebar-foot button shows how many tasks are still open. */
function setTaskBadge(n) {
  if (!els.tasksCount) return;
  if (n > 0) { els.tasksCount.textContent = String(n); els.tasksCount.hidden = false; }
  else els.tasksCount.hidden = true;
}

/* Refresh just the badge (cheap backend count) — called when a project opens,
 * without needing the panel to have been opened yet. */
async function refreshTaskCount() {
  const path = projectPath();
  if (!path) return setTaskBadge(0);
  try {
    const { open } = await api.taskCount(path);
    setTaskBadge(open || 0);
  } catch (_) { /* leave the badge as-is on failure */ }
}

function showTasksBtn(show) {
  if (!els.tasksBtn) return;
  els.tasksBtn.hidden = !show;
  if (show) refreshTaskCount();
}

/* ------------------------------ open / close ----------------------------- */

async function openTasks() {
  if (!projectPath()) return;
  taskUI.view = 'list';
  openOverlay(els.tasksOverlay);
  els.tasksBody.innerHTML =
    `<div class="init-loading"><div class="spin"></div><h3>${escapeHtml(tr('tasks.loading'))}</h3></div>`;
  els.tasksFoot.innerHTML = '';
  await loadTasks();
}

function closeTasks() {
  closeOverlay(els.tasksOverlay, () => {
    els.tasksBody.innerHTML = '';
    els.tasksFoot.innerHTML = '';
  });
}

async function loadTasks() {
  const path = projectPath();
  if (!path) return;
  try {
    const { tasks } = await api.tasks(path);
    taskUI.tasks = Array.isArray(tasks) ? tasks : [];
  } catch (_) { taskUI.tasks = []; }
  setTaskBadge(openTaskCount());
  renderTaskList();
}

/* -------------------------------- list view ------------------------------ */

function renderTaskList() {
  taskUI.view = 'list';
  const done = taskUI.tasks.filter((t) => t.done).length;
  const body = els.tasksBody;
  body.innerHTML = '';

  // Add-a-task row.
  const add = document.createElement('div');
  add.className = 'task-add';
  add.innerHTML =
    `<input class="task-add-input" type="text" maxlength="300" ` +
      `placeholder="${escapeHtml(tr('tasks.addPlaceholder'))}" autocomplete="off" spellcheck="false">` +
    `<button class="task-add-btn" title="${escapeHtml(tr('tasks.addBtn'))}">＋</button>`;
  const addInput = add.querySelector('.task-add-input');
  const addBtn = add.querySelector('.task-add-btn');
  const submitAdd = () => addTask(addInput.value);
  addBtn.onclick = submitAdd;
  addInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } };
  body.appendChild(add);

  // "Let Claude build it" entry point.
  const gen = document.createElement('button');
  gen.className = 'task-gen-btn';
  gen.innerHTML = `<span aria-hidden="true">✨</span> ${escapeHtml(tr('tasks.genBtn'))}`;
  gen.onclick = renderBrief;
  body.appendChild(gen);

  // The list (or empty state).
  if (!taskUI.tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = tr('tasks.empty');
    body.appendChild(empty);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    for (const t of taskUI.tasks) ul.appendChild(taskItem(t));
    body.appendChild(ul);
    replayClass(ul, 'list-swap');
  }
  taskUI.newIds.clear();

  // Foot: Clear completed (left) · Close (right).
  els.tasksFoot.innerHTML = '';
  if (done > 0) {
    const clear = footBtn(tr('tasks.clearDone', { n: done }), 'ghost', clearDone);
    clear.style.marginRight = 'auto';
    els.tasksFoot.appendChild(clear);
  }
  els.tasksFoot.appendChild(footBtn(tr('tasks.close'), 'ghost', closeTasks));

  setTimeout(() => addInput && addInput.focus(), 0);
}

function taskItem(t) {
  const li = document.createElement('li');
  li.className = 'task-item' + (t.done ? ' done' : '') + (taskUI.newIds.has(t.id) ? ' fresh' : '');
  li.dataset.id = t.id;

  const check = document.createElement('button');
  check.className = 'task-check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(!!t.done));
  check.title = tr(t.done ? 'tasks.markOpen' : 'tasks.markDone');
  check.innerHTML = t.done ? TASK_CHECK_SVG : '';
  check.onclick = () => toggleTask(t);

  const main = document.createElement('div');
  main.className = 'task-main';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = t.title;
  title.title = tr('tasks.editTitle');
  title.ondblclick = () => beginEdit(li, t);
  main.appendChild(title);
  if (t.note) {
    const note = document.createElement('div');
    note.className = 'task-note';
    note.textContent = t.note;
    main.appendChild(note);
  }

  const edit = document.createElement('button');
  edit.className = 'task-icon task-edit';
  edit.title = tr('tasks.editTitle');
  edit.innerHTML = '✎';
  edit.onclick = () => beginEdit(li, t);

  const del = document.createElement('button');
  del.className = 'task-icon task-del';
  del.title = tr('tasks.delTitle');
  del.innerHTML = '×';
  del.onclick = () => deleteTask(li, t);

  li.appendChild(check);
  li.appendChild(main);
  li.appendChild(edit);
  li.appendChild(del);
  return li;
}

/* Swap a task's title for an inline editor. Enter / blur saves, Escape reverts. */
function beginEdit(li, t) {
  if (li.querySelector('.task-edit-input')) return;
  const main = li.querySelector('.task-main');
  const titleEl = main.querySelector('.task-title');
  const input = document.createElement('input');
  input.className = 'task-edit-input';
  input.type = 'text';
  input.maxLength = 300;
  input.value = t.title;
  titleEl.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let settled = false;
  const cancel = () => { if (!settled) { settled = true; renderTaskList(); } };
  const save = async () => {
    if (settled) return;
    const next = input.value.trim();
    if (!next || next === t.title) return cancel();
    settled = true;
    try {
      const updated = await api.updateTask(t.id, next, null);
      Object.assign(t, updated);
    } catch (_) {}
    renderTaskList();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  input.onblur = save;
}

async function addTask(raw) {
  const title = (raw || '').trim();
  if (!title || taskUI.busy || !projectPath()) return;
  try {
    const t = await api.addTask(projectPath(), title, null);
    taskUI.tasks.push(t);
    taskUI.newIds.add(t.id);
    setTaskBadge(openTaskCount());
    renderTaskList();
  } catch (_) {}
}

async function toggleTask(t) {
  const next = !t.done;
  // Optimistic flip — the row restyles immediately, then we persist.
  t.done = next;
  setTaskBadge(openTaskCount());
  const li = els.tasksBody.querySelector(`.task-item[data-id="${t.id}"]`);
  if (li) {
    li.classList.toggle('done', next);
    const check = li.querySelector('.task-check');
    if (check) {
      check.setAttribute('aria-checked', String(next));
      check.innerHTML = next ? TASK_CHECK_SVG : '';
      check.title = tr(next ? 'tasks.markOpen' : 'tasks.markDone');
    }
  }
  try { await api.updateTask(t.id, null, next); } catch (_) {}
  // Refresh the foot so "Clear completed" appears/disappears in step.
  renderClearDoneFoot();
}

function renderClearDoneFoot() {
  const done = taskUI.tasks.filter((t) => t.done).length;
  els.tasksFoot.innerHTML = '';
  if (done > 0) {
    const clear = footBtn(tr('tasks.clearDone', { n: done }), 'ghost', clearDone);
    clear.style.marginRight = 'auto';
    els.tasksFoot.appendChild(clear);
  }
  els.tasksFoot.appendChild(footBtn(tr('tasks.close'), 'ghost', closeTasks));
}

async function deleteTask(li, t) {
  li.classList.add('removing');
  setTimeout(async () => {
    try { await api.deleteTask(t.id); } catch (_) {}
    taskUI.tasks = taskUI.tasks.filter((x) => x.id !== t.id);
    setTaskBadge(openTaskCount());
    renderTaskList();
  }, 180);
}

async function clearDone() {
  const path = projectPath();
  if (!path) return;
  try { await api.clearDoneTasks(path); } catch (_) {}
  taskUI.tasks = taskUI.tasks.filter((t) => !t.done);
  setTaskBadge(openTaskCount());
  renderTaskList();
}

/* --------------------------- generate from a brief ----------------------- */

function renderBrief() {
  taskUI.view = 'brief';
  taskUI.questions = [];
  taskUI.sel = {};
  els.tasksBody.innerHTML = `<p class="init-intro">${escapeHtml(tr('tasks.briefIntro'))}</p>`;
  const ta = document.createElement('textarea');
  ta.className = 'init-brief';
  ta.rows = 5;
  ta.placeholder = tr('tasks.briefPlaceholder');
  ta.value = taskUI.brief;
  ta.oninput = () => { taskUI.brief = ta.value; };
  els.tasksBody.appendChild(ta);
  setTimeout(() => ta.focus(), 0);

  els.tasksFoot.innerHTML = '';
  els.tasksFoot.appendChild(footBtn(tr('tasks.back'), 'ghost', renderTaskList));
  els.tasksFoot.appendChild(footBtn(tr('tasks.generate'), 'primary', () => runGenerate(null)));
}

function genLoading(title) {
  els.tasksBody.innerHTML =
    `<div class="init-loading"><div class="spin"></div><h3>${escapeHtml(title)}</h3>` +
    `<p>${escapeHtml(tr('tasks.genWait'))}</p></div>`;
  els.tasksFoot.innerHTML = '';
}

function genError(message, retry) {
  els.tasksFoot.innerHTML = '';
  const err = document.createElement('span');
  err.className = 'init-err';
  err.textContent = '⚠ ' + message;
  els.tasksFoot.appendChild(err);
  els.tasksFoot.appendChild(footBtn(tr('tasks.back'), 'ghost', renderBrief));
  if (retry) els.tasksFoot.appendChild(footBtn(tr('tasks.retry'), 'primary', retry));
}

async function runGenerate(answers) {
  const brief = (taskUI.brief || '').trim();
  if (!brief) {
    showTip({ key: 'status', cls: 'warn', icon: '✍️', label: tr('tasks.needBriefLabel'),
      body: tr('tasks.needBriefBody') });
    return;
  }
  genLoading(answers ? tr('tasks.creatingTitle') : tr('tasks.thinkingTitle'));
  try {
    const data = await api.generateTasks(projectPath(), brief, answers || []);
    if (data.error) return genError(data.error, () => runGenerate(answers));
    if (Array.isArray(data.tasks)) return applyGenerated(data.tasks);
    if (Array.isArray(data.questions) && data.questions.length) {
      taskUI.questions = data.questions;
      taskUI.sel = {};
      for (const q of taskUI.questions) taskUI.sel[q.id] = { opts: new Set(), custom: '' };
      return renderQuestions();
    }
    genError(tr('tasks.genEmpty'), () => runGenerate(answers));
  } catch (e) {
    genError(String((e && e.message) || e), () => runGenerate(answers));
  }
}

function renderQuestions() {
  taskUI.view = 'questions';
  els.tasksBody.innerHTML = `<p class="init-intro">${escapeHtml(tr('tasks.questionsIntro'))}</p>`;
  for (const q of taskUI.questions) {
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
        const sel = taskUI.sel[q.id];
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
      ta.placeholder = tr('tasks.questionCustom');
      ta.oninput = () => { taskUI.sel[q.id].custom = ta.value; };
      card.appendChild(ta);
    }
    els.tasksBody.appendChild(card);
  }

  els.tasksFoot.innerHTML = '';
  els.tasksFoot.appendChild(footBtn(tr('tasks.back'), 'ghost', renderBrief));
  els.tasksFoot.appendChild(footBtn(tr('tasks.createTasks'), 'primary', () => runGenerate(collectAnswers())));
}

function collectAnswers() {
  const out = [];
  for (const q of taskUI.questions) {
    const sel = taskUI.sel[q.id];
    const ans = [...sel.opts];
    if (sel.custom && sel.custom.trim()) ans.push(sel.custom.trim());
    if (ans.length) out.push({ question: q.question, answer: ans });
  }
  return out;
}

/* Persist Claude's tasks (in order), then drop back to the list with the fresh
 * ones briefly highlighted. */
async function applyGenerated(tasks) {
  const path = projectPath();
  const clean = tasks
    .map((t) => ({ title: String((t && t.title) || '').trim(), note: String((t && t.note) || '').trim() }))
    .filter((t) => t.title);
  if (!path || !clean.length) return genError(tr('tasks.genEmpty'), renderBrief);

  genLoading(tr('tasks.creatingTitle'));
  taskUI.newIds.clear();
  for (const t of clean) {
    try {
      const saved = await api.addTask(path, t.title, t.note || null);
      taskUI.tasks.push(saved);
      taskUI.newIds.add(saved.id);
    } catch (_) {}
  }
  taskUI.brief = '';
  setTaskBadge(openTaskCount());
  renderTaskList();
  showTip({ key: 'status', icon: '✨', label: tr('tasks.addedLabel'),
    body: escapeHtml(tr('tasks.addedBody', { n: clean.length })) });
}

/* Re-render the open panel after a language switch (keeps the current view). */
function relocalizeTasks() {
  if (els.tasksOverlay.hidden) return;
  if (taskUI.view === 'brief') renderBrief();
  else if (taskUI.view === 'questions') renderQuestions();
  else renderTaskList();
}

/* -------------------------------- wiring --------------------------------- */

els.tasksBtn.onclick = openTasks;
els.tasksClose.onclick = closeTasks;

// Backdrop click closes (same press-start-and-end guard as the other modals).
let tasksPressOnBackdrop = false;
els.tasksOverlay.addEventListener('mousedown', (e) => { tasksPressOnBackdrop = (e.target === els.tasksOverlay); });
els.tasksOverlay.addEventListener('mouseup', (e) => {
  if (tasksPressOnBackdrop && e.target === els.tasksOverlay) closeTasks();
  tasksPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.tasksOverlay.hidden) closeTasks();
});
