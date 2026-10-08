/* git.js        — git status line + branch picker (switch/create/fetch/pull/push)
                    + the GitHub Actions build chip and its recent-runs popover
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
    ci.branch = r.branch;
    renderCiChip();   // what we already know, straight away…
    refreshCi();      // …then whatever GitHub says now
  } catch (_) { el.hidden = true; }
}

/* ----------------------------- GitHub Actions ---------------------------- */
/* A build chip at the end of the git status line: a coloured dot + the workflow
 * that matters right now (one that is running, else the latest on this branch,
 * else the latest at all). Clicking it lists the recent runs; a run opens on
 * GitHub. The backend asks the GitHub CLI (`ci_runs`), so the chip simply isn't
 * there when `gh` is missing or the folder isn't a GitHub repository.
 *
 * Polled — quickly while something is running, lazily otherwise, not at all
 * while the window is hidden — and a run seen in flight raises a tip when it
 * lands, so a deploy can be left to get on with it. */

const CI_POLL_ACTIVE_MS = 12000;     // something is queued or running
const CI_POLL_IDLE_MS = 90000;       // everything has landed
const CI_POLL_ABSENT_MS = 600000;    // gh had nothing to say for this folder
const CI_MIN_GAP_MS = 5000;          // refreshGit fires often; GitHub needn't hear each one
const CI_AFTER_PUSH_MS = 4000;       // GitHub takes a moment to register a pushed run

const ci = {
  path: null,        // the project `runs` belongs to
  branch: '',        // current branch, from refreshGit
  runs: [],
  live: new Set(),   // ids seen in flight — the ones worth announcing when they land
  at: 0,             // when we last asked
  gap: CI_MIN_GAP_MS,
  busy: false,
  timer: null,
};

function ciWanted() {
  return settingOn('gitStatus') && settingOn('ciStatus') && !!gitCwd() && !!state.activeId;
}

// 'run' (queued or in progress) | 'ok' | 'fail' | 'off' (cancelled, skipped, …)
function ciState(run) {
  if (run.status !== 'completed') return 'run';
  if (run.conclusion === 'success') return 'ok';
  if (['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) return 'fail';
  return 'off';
}

function ciStateLabel(run) {
  const st = ciState(run);
  if (st === 'run') return tr(run.status === 'in_progress' ? 'ci.running' : 'ci.queued');
  if (st === 'ok') return tr('ci.passed');
  if (st === 'fail') return tr('ci.failed');
  if (run.conclusion === 'cancelled') return tr('ci.cancelled');
  if (run.conclusion === 'skipped') return tr('ci.skipped');
  return run.conclusion || '—';
}

// "5 min. ago" in the app's language.
function ciAgo(iso) {
  const secs = Math.abs(Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (isNaN(secs)) return '';
  const rtf = new Intl.RelativeTimeFormat(window.I18N ? window.I18N.getLang() : 'en',
    { numeric: 'auto', style: 'short' });
  if (secs < 60) return rtf.format(0, 'second');
  if (secs < 3600) return rtf.format(-Math.round(secs / 60), 'minute');
  if (secs < 86400) return rtf.format(-Math.round(secs / 3600), 'hour');
  return rtf.format(-Math.round(secs / 86400), 'day');
}

// When it started if it is still going; when it landed and how long it took if not.
function ciWhen(run) {
  if (ciState(run) === 'run') return ciAgo(run.createdAt);
  const s = Math.round((new Date(run.updatedAt) - new Date(run.createdAt)) / 1000);
  const took = !(s > 0) ? '' : s < 60 ? s + 's' : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return [ciAgo(run.updatedAt), took].filter(Boolean).join(' · ');
}

// The one run the chip stands for.
function ciHeadline() {
  if (!ciWanted() || ci.path !== gitCwd() || !ci.runs.length) return null;
  return ci.runs.find((r) => ciState(r) === 'run')
    || ci.runs.find((r) => r.branch === ci.branch)
    || ci.runs[0];
}

function renderCiChip() {
  const el = els.gitStatus;
  if (!el || el.hidden) return;
  const old = el.querySelector('.git-ci');
  if (old) old.remove();
  const run = ciHeadline();
  if (!run) return;
  const chip = document.createElement('span');
  chip.className = 'git-ci ci-' + ciState(run);
  chip.innerHTML = `<i class="ci-dot"></i>${escapeHtml(run.workflow || run.title)}`;
  chip.title = tr('ci.chipTitle', { state: ciStateLabel(run), when: ciWhen(run) });
  chip.onclick = () => openCiPop(chip);
  el.appendChild(chip);
  if (ciPopOpen()) branchAnchor = chip;   // the old chip is gone; keep the popover's anchor real
}

/* Ask GitHub for the runs and redraw. `force` skips the politeness gap (the
 * user opened the list, or just pushed). Re-arms its own timer. */
async function refreshCi(force) {
  clearTimeout(ci.timer);
  ci.timer = null;
  const path = gitCwd();
  if (!ciWanted()) { renderCiChip(); return; }
  if (ci.path !== path) {
    Object.assign(ci, { path, runs: [], live: new Set(), at: 0, gap: CI_MIN_GAP_MS });
    renderCiChip();
  }
  if (ci.busy) return;                       // the call in flight re-arms the timer
  const wait = ci.at + ci.gap - Date.now();
  if (!force && wait > 0) { ci.timer = setTimeout(pollCi, wait); return; }

  ci.busy = true;
  let r = null;
  try { r = await api.ciRuns(path); } catch (_) {}
  ci.busy = false;
  if (path !== gitCwd()) { refreshCi(); return; }   // the project changed while we waited

  const ok = !!(r && r.available);
  const runs = (ok && r.runs) || [];
  for (const run of runs) {
    if (ciState(run) === 'run') ci.live.add(run.id);
    else if (ci.live.delete(run.id)) announceCi(run);
  }
  ci.runs = runs;
  ci.at = Date.now();
  ci.gap = ok ? CI_MIN_GAP_MS : CI_POLL_ABSENT_MS;
  renderCiChip();
  if (ciPopOpen()) renderCiPop();
  clearTimeout(ci.timer);
  ci.timer = setTimeout(pollCi,
    !ok ? CI_POLL_ABSENT_MS : ci.live.size ? CI_POLL_ACTIVE_MS : CI_POLL_IDLE_MS);
}

// A hidden window stops asking; coming back to it asks at once.
function pollCi() { if (!document.hidden) refreshCi(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && ciWanted()) refreshCi(); });

function ciOpen(url) {
  if (url) openExternalUrl(url);
}

// A run we watched has landed: say so, wherever the user is in the app.
function announceCi(run) {
  const st = ciState(run);
  showTip({
    key: 'ci', cls: st === 'fail' ? 'high' : '', icon: st === 'ok' ? '✅' : st === 'fail' ? '⚠️' : '⏹',
    label: tr('ci.tipLabel', { workflow: run.workflow || tr('ci.build'), state: ciStateLabel(run) }),
    body: escapeHtml(run.title || run.branch),
    actions: [{ text: tr('ci.open'), run: (close) => { ciOpen(run.url); close(); } }],
  });
}

/* The recent-runs popover. It borrows the branch picker's shell (one popover at
 * a time down there, same outside-click and positioning), with its own rows. */
function ciPopOpen() { return !!branchPop && branchPop.classList.contains('ci-pop'); }

function openCiPop(anchor) {
  if (branchPop) { closeBranchPicker(); return; }   // toggle off
  branchAnchor = anchor;
  const pop = document.createElement('div');
  pop.className = 'branch-pop ci-pop';
  document.body.appendChild(pop);
  branchPop = pop;
  renderCiPop();
  if (!branchPop) return;
  replayClass(pop, 'pop-in');
  setTimeout(() => { document.addEventListener('mousedown', onBranchOutside, true); }, 0);
  refreshCi(true);
}

function renderCiPop() {
  if (!ciPopOpen()) return;
  if (!ciHeadline()) { closeBranchPicker(); return; }
  const was = branchPop.querySelector('.branch-list');
  const scroll = was ? was.scrollTop : 0;
  const rows = ci.runs.map((run, i) => {
    const meta = [run.workflow, run.branch, ciWhen(run)].filter(Boolean).join(' · ');
    return `<li class="branch-item ci-item ci-${ciState(run)}" data-i="${i}">` +
      `<i class="ci-dot"></i>` +
      `<span class="ci-text"><span class="branch-name">${escapeHtml(run.title || run.workflow)}</span>` +
        `<span class="ci-meta">${escapeHtml(meta)}</span></span>` +
      `<span class="ci-state">${escapeHtml(ciStateLabel(run))}</span>` +
    `</li>`;
  });
  branchPop.innerHTML =
    `<ul class="branch-list"><li class="branch-section">${escapeHtml(tr('ci.recent'))}</li>${rows.join('')}</ul>` +
    `<div class="branch-actions">` +
      `<button class="branch-act" data-act="all">${escapeHtml(tr('ci.openAll'))}</button>` +
    `</div>`;
  positionBranchPop();
  const list = branchPop.querySelector('.branch-list');
  list.scrollTop = scroll;
  list.querySelectorAll('.ci-item').forEach((li) => {
    const run = ci.runs[Number(li.dataset.i)];
    li.title = tr('ci.openRun');
    li.onclick = () => ciOpen(run.url);
  });
  // Every run's address is <repo>/actions/runs/<id>; the list lives one level up.
  branchPop.querySelector('[data-act="all"]').onclick =
    () => ciOpen(String(ci.runs[0].url).replace(/\/runs\/\d+.*$/, ''));
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
  if (branchPop && !branchPop.contains(e.target) && !e.target.closest('.git-branch, .git-ci')) closeBranchPicker();
}

// Keep the popover pinned just above its label (it lives at the bottom), and
// inside the window — the runs popover is wider than the branch one.
function positionBranchPop() {
  if (!branchPop || !branchAnchor) return;
  const r = branchAnchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - branchPop.offsetWidth - 8);
  branchPop.style.left = Math.round(Math.max(8, left)) + 'px';
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
      else if (act === 'push') runGitAction(() => api.gitPush(gitCwd()), 'branch.pushedLabel', 'branch.pushFailLabel', { icon: '↑', ci: true });
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
    if (opts.ci) setTimeout(() => refreshCi(true), CI_AFTER_PUSH_MS);   // a push is what starts a build
    showTip({ key: 'status', icon: opts.icon || '⎇', label: tr(okLabel),
      body: r.output ? escapeHtml(r.output) : tr('branch.actionDone') });
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr(failLabel),
      body: escapeHtml(String(e.message || e)) });
  }
}

