/* git.js        — git status line + branch picker (switch/create/fetch/pull/push)
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ git status ------------------------------- */
/* A tiny line under the composer: current branch + working-tree line changes.
 * Auto-hidden when the feature is off or the project folder isn't a git repo. */

async function refreshGit() {
  const el = els.gitStatus;
  if (!el) return;
  if (!settingOn('gitStatus') || !state.project || !state.activeId) { el.hidden = true; return; }
  try {
    const r = await api.gitStatus(state.project.path);
    if (!r || !r.isRepo) { el.hidden = true; return; }
    const parts = [`<span class="git-branch">${escapeHtml(r.branch)}</span>`];
    if (r.added) parts.push(`<span class="git-add">+${r.added}</span>`);
    if (r.deleted) parts.push(`<span class="git-del">−${r.deleted}</span>`);
    if (!r.added && !r.deleted) parts.push(`<span class="git-clean">${escapeHtml(tr('git.clean'))}</span>`);
    el.innerHTML = parts.join('');
    el.hidden = false;
    const br = el.querySelector('.git-branch');
    if (br) {
      br.title = tr('branch.pickTitle');
      br.onclick = () => openBranchPicker(br);
    }
  } catch (_) { el.hidden = true; }
}

/* ------------------------------ branch picker ---------------------------- */
/* Clicking the branch name in the git status line opens a small searchable
 * popover for working with git directly: switch between local & remote branches,
 * create a branch, and fetch / pull / push — without leaving the app. */

let branchPop = null;
let branchAnchor = null;

function closeBranchPicker() {
  if (!branchPop) return;
  branchPop.remove();
  branchPop = null;
  branchAnchor = null;
  document.removeEventListener('mousedown', onBranchOutside, true);
}
function onBranchOutside(e) {
  if (branchPop && !branchPop.contains(e.target) && !e.target.closest('.git-branch')) closeBranchPicker();
}

// Keep the popover pinned just above the branch label (it lives at the bottom).
function positionBranchPop() {
  if (!branchPop || !branchAnchor) return;
  const r = branchAnchor.getBoundingClientRect();
  branchPop.style.left = Math.round(r.left) + 'px';
  branchPop.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
}

const gitCwd = () => state.project && state.project.path;

async function openBranchPicker(anchor) {
  if (branchPop) { closeBranchPicker(); return; }   // toggle off
  if (!gitCwd()) return;
  branchAnchor = anchor;
  const pop = document.createElement('div');
  pop.className = 'branch-pop';
  document.body.appendChild(pop);
  branchPop = pop;
  await renderBranchPicker();
  if (branchPop) replayClass(branchPop, 'pop-in');   // spring up now content is in & positioned
  setTimeout(() => { document.addEventListener('mousedown', onBranchOutside, true); }, 0);
}

// Fetch the branch list and (re)draw the picker's main (list) view.
async function renderBranchPicker() {
  if (!branchPop) return;
  let data;
  try { data = await api.gitBranches(gitCwd()); } catch (_) { return closeBranchPicker(); }
  if (!data || !data.isRepo) return closeBranchPicker();

  const local = data.local || [];
  const remote = data.remote || [];      // [{ full, short, remote }]
  const current = data.current;

  branchPop.innerHTML =
    `<input class="branch-search" type="search" autocomplete="off" spellcheck="false" ` +
      `placeholder="${escapeHtml(tr('branch.search'))}">` +
    `<ul class="branch-list"></ul>` +
    `<div class="branch-actions">` +
      `<button class="branch-act" data-act="new" title="${escapeHtml(tr('branch.newTitle'))}">${escapeHtml(tr('branch.new'))}</button>` +
      `<button class="branch-act" data-act="fetch" title="${escapeHtml(tr('branch.fetchTitle'))}">${escapeHtml(tr('branch.fetch'))}</button>` +
      `<button class="branch-act" data-act="pull" title="${escapeHtml(tr('branch.pullTitle'))}">${escapeHtml(tr('branch.pull'))}</button>` +
      `<button class="branch-act" data-act="push" title="${escapeHtml(tr('branch.pushTitle'))}">${escapeHtml(tr('branch.push'))}</button>` +
    `</div>`;
  positionBranchPop();

  const listEl = branchPop.querySelector('.branch-list');
  const searchEl = branchPop.querySelector('.branch-search');

  function renderList(filter) {
    const f = (filter || '').toLowerCase();
    const locals = local.filter((b) => b.toLowerCase().includes(f));
    const remotes = remote.filter((r) => r.full.toLowerCase().includes(f));
    listEl.innerHTML = '';
    if (!locals.length && !remotes.length) {
      listEl.innerHTML = `<li class="branch-empty">${escapeHtml(tr('branch.none'))}</li>`;
      return;
    }
    if (locals.length) {
      listEl.insertAdjacentHTML('beforeend', `<li class="branch-section">${escapeHtml(tr('branch.local'))}</li>`);
      for (const b of locals) {
        const isCur = b === current;
        const li = document.createElement('li');
        li.className = 'branch-item' + (isCur ? ' current' : '');
        li.innerHTML = `<span class="branch-name">${escapeHtml(b)}</span>` +
          (isCur ? `<span class="branch-badge">${escapeHtml(tr('branch.current'))}</span>` : '');
        if (!isCur) li.onclick = () => switchBranch(b);
        listEl.appendChild(li);
      }
    }
    if (remotes.length) {
      listEl.insertAdjacentHTML('beforeend', `<li class="branch-section">${escapeHtml(tr('branch.remote'))}</li>`);
      for (const r of remotes) {
        const li = document.createElement('li');
        li.className = 'branch-item remote';
        li.innerHTML = `<span class="branch-name">${escapeHtml(r.full)}</span>`;
        li.onclick = () => switchBranch(r.short);   // git creates a local tracking branch
        listEl.appendChild(li);
      }
    }
  }
  renderList('');

  searchEl.addEventListener('input', () => renderList(searchEl.value));
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = listEl.querySelector('.branch-item:not(.current)');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeBranchPicker();
    }
  });

  branchPop.querySelectorAll('.branch-act').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'new') renderBranchCreate(searchEl.value.trim());
      else if (act === 'fetch') runGitAction(() => api.gitFetch(gitCwd()), 'branch.fetchedLabel', 'branch.fetchFailLabel', { icon: '⟳', reload: true });
      else if (act === 'pull') runGitAction(() => api.gitPull(gitCwd()), 'branch.pulledLabel', 'branch.pullFailLabel', { icon: '↓', refreshGit: true });
      else if (act === 'push') runGitAction(() => api.gitPush(gitCwd()), 'branch.pushedLabel', 'branch.pushFailLabel', { icon: '↑' });
    };
  });

  setTimeout(() => searchEl.focus(), 0);
}

// The "new branch" sub-view: name it, Create switches to it.
function renderBranchCreate(prefill) {
  if (!branchPop) return;
  branchPop.innerHTML =
    `<div class="branch-create">` +
      `<div class="branch-create-title">${escapeHtml(tr('branch.newTitle'))}</div>` +
      `<input class="branch-search branch-new-name" type="text" autocomplete="off" spellcheck="false" ` +
        `placeholder="${escapeHtml(tr('branch.newName'))}">` +
      `<div class="branch-create-row">` +
        `<button class="branch-act" data-act="cancel">${escapeHtml(tr('branch.cancel'))}</button>` +
        `<button class="branch-act primary" data-act="create">${escapeHtml(tr('branch.create'))}</button>` +
      `</div>` +
    `</div>`;
  positionBranchPop();
  const input = branchPop.querySelector('.branch-new-name');
  input.value = prefill || '';
  const create = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    runGitAction(() => api.gitCreateBranch(gitCwd(), name), 'branch.createdLabel', 'branch.createFailLabel',
      { icon: '⎇', close: true, refreshGit: true });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); create(); }
    else if (e.key === 'Escape') { e.stopPropagation(); renderBranchPicker(); }
  });
  branchPop.querySelector('[data-act="create"]').onclick = create;
  branchPop.querySelector('[data-act="cancel"]').onclick = () => renderBranchPicker();
  setTimeout(() => input.focus(), 0);
}

async function switchBranch(branch) {
  closeBranchPicker();
  if (!gitCwd()) return;
  try {
    const r = await api.gitCheckout(gitCwd(), branch);
    if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
    refreshGit();
    showTip({ key: 'status', icon: '⎇', label: tr('branch.switchedLabel'),
      body: tr('branch.switchedBody', { branch: escapeHtml(branch) }) });
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('branch.switchFailLabel'),
      body: escapeHtml(String(e.message || e)) });
  }
}

/* Run a git action (fetch/pull/push/create), show its result as a tip, and
 * optionally refresh the status line / reload the picker / close it. */
async function runGitAction(call, okLabel, failLabel, opts = {}) {
  try {
    const r = await call();
    if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
    if (opts.close) closeBranchPicker();
    if (opts.refreshGit) refreshGit();
    if (opts.reload && branchPop) await renderBranchPicker();
    showTip({ key: 'status', icon: opts.icon || '⎇', label: tr(okLabel),
      body: r.output ? escapeHtml(r.output) : tr('branch.actionDone') });
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr(failLabel),
      body: escapeHtml(String(e.message || e)) });
  }
}

