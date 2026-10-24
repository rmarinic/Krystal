/* git.js        — git status line + branch picker (switch/create/fetch/pull/push)
                    + the GitHub Actions build chip and its recent-runs popover
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ git status ------------------------------- */
/* A tiny line under the composer: current branch + working-tree line changes.
 * Auto-hidden when the feature is off or the project folder isn't a git repo.
 * When a turn changes the counts, they roll from the old ones (`gitShown`). */
let gitShown = null;   // { path, added, deleted } last painted

async function refreshGit() {
  const el = els.gitStatus;
  if (!el) return;
  if (!settingOn('gitStatus') || !state.project || !state.activeId) { el.hidden = true; return; }
  try {
    const r = await api.gitStatus(state.project.path);
    if (!r || !r.isRepo) { el.hidden = true; return; }
    const parts = [`<span class="git-branch">${escapeHtml(r.branch)}</span>`];
    if (r.added) parts.push(`<span class="git-add">+<span class="git-n">${r.added}</span></span>`);
    if (r.deleted) parts.push(`<span class="git-del">−<span class="git-n">${r.deleted}</span></span>`);
    if (!r.added && !r.deleted) parts.push(`<span class="git-clean">${escapeHtml(tr('git.clean'))}</span>`);
    el.innerHTML = parts.join('');
    const prev = gitShown && gitShown.path === state.project.path && !el.hidden ? gitShown : null;
    if (prev) {
      if (r.added && prev.added) rollNumber(el.querySelector('.git-add .git-n'), r.added, prev.added);
      if (r.deleted && prev.deleted) rollNumber(el.querySelector('.git-del .git-n'), r.deleted, prev.deleted);
    }
    gitShown = { path: state.project.path, added: r.added, deleted: r.deleted };
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
 * else the latest at all). Clicking it lists the recent runs; a run opens in
 * the run panel further down. The backend asks the GitHub CLI (`ci_runs`), so the chip simply isn't
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

// "4m 12s" between two timestamps; nothing when either is missing.
function ciTook(from, to) {
  const s = Math.round((new Date(to) - new Date(from)) / 1000);
  return !(s > 0) ? '' : s < 60 ? s + 's' : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// When it started if it is still going; when it landed and how long it took if not.
function ciWhen(run) {
  if (ciState(run) === 'run') return ciAgo(run.createdAt);
  return [ciAgo(run.updatedAt), ciTook(run.createdAt, run.updatedAt)].filter(Boolean).join(' · ');
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
    key: 'ci', cls: st === 'fail' ? 'high' : '', icon: st === 'ok' ? 'check' : st === 'fail' ? 'alert' : 'stop',
    label: tr('ci.tipLabel', { workflow: run.workflow || tr('ci.build'), state: ciStateLabel(run) }),
    body: escapeHtml(run.title || run.branch),
    actions: [{ text: tr('ci.details'), run: (close) => { openCiRun(run); close(); } }],
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
    li.title = tr('ci.viewRun');
    li.onclick = () => openCiRun(run);
  });
  // Every run's address is <repo>/actions/runs/<id>; the list lives one level up.
  branchPop.querySelector('[data-act="all"]').onclick =
    () => ciOpen(String(ci.runs[0].url).replace(/\/runs\/\d+.*$/, ''));
}

/* -------------------------------- run panel ------------------------------ */
/* One run, opened from a row of the list above: its jobs and their steps, each
 * with how long it took, and — for a run that failed — the end of the failed
 * step's log, which is usually the whole answer. Kept fresh while the run is
 * still going. `ci_run` asks the GitHub CLI, like the list does.
 *
 * It opens at once on what the list already knows (title, state, timing) and
 * fills in the steps when they arrive: the log of a failure is a slow fetch. */

let ciView = null;   // { path, run, logs, loaded, error, timer }

function openCiRun(run) {
  closeBranchPicker();
  if (ciView) clearTimeout(ciView.timer);
  ciView = { path: gitCwd(), run, logs: [], loaded: false, error: false, timer: null };
  renderCiRun(false);
  openOverlay(els.ciOverlay);
  els.ciBody.scrollTop = 0;
  loadCiRun();
}

function closeCiRun() {
  if (ciView) clearTimeout(ciView.timer);
  ciView = null;
  closeOverlay(els.ciOverlay);
}

async function loadCiRun() {
  const mine = ciView;
  if (!mine) return;
  clearTimeout(mine.timer);
  if (document.hidden) { mine.timer = setTimeout(loadCiRun, CI_POLL_ACTIVE_MS); return; }
  let r = null;
  try { r = await api.ciRun(mine.path, mine.run.id); } catch (_) {}
  if (ciView !== mine) return;                 // closed, or another run opened, while we asked
  const first = !mine.loaded;
  if (r && r.available && r.run) {
    Object.assign(mine, { run: r.run, logs: r.logs || [], loaded: true, error: false });
  } else if (first) {
    mine.error = true;
  }
  renderCiRun(first && mine.loaded);
  if (mine.loaded && ciState(mine.run) === 'run') mine.timer = setTimeout(loadCiRun, CI_POLL_ACTIVE_MS);
}

/* `enter` plays the rows in — only when the steps first arrive, never on a refresh. */
function renderCiRun(enter) {
  const v = ciView;
  if (!v) return;
  const run = v.run;
  const st = ciState(run);
  els.ciTitle.textContent = run.title || run.workflow || tr('ci.build');
  els.ciSub.textContent = [
    run.workflow, run.branch, run.sha && String(run.sha).slice(0, 7), run.event,
    run.number ? '#' + run.number : '', run.attempt > 1 ? tr('ci.attempt', { n: run.attempt }) : '',
  ].filter(Boolean).join(' · ');
  els.ciStatus.className = 'agent-status' + (st === 'run' ? ' running' : st === 'fail' ? ' error' : st === 'ok' ? ' ok' : '');
  els.ciStatus.innerHTML = (st === 'run' ? '<span class="agent-live-dot"></span>' : '') + escapeHtml(ciStateLabel(run));
  els.ciHint.textContent = ciWhen(run);
  els.ciFix.hidden = !(v.loaded && st === 'fail' && state.activeId);

  const body = els.ciBody;
  const scroll = body.scrollTop;
  body.innerHTML = '';
  const jobs = (v.loaded && run.jobs) || [];
  if (!jobs.length) {
    const note = document.createElement('div');
    note.className = 'ci-empty';
    note.textContent = tr(v.error ? 'ci.loadFail' : v.loaded ? 'ci.noJobs' : 'ci.loading');
    body.appendChild(note);
    return;
  }
  for (const job of jobs) body.appendChild(ciJobEl(job, v.logs.filter((l) => l.job === job.name), enter));
  body.scrollTop = scroll;
}

function ciRowParts(item, running) {
  const dot = document.createElement('i');
  dot.className = 'ci-dot';
  const name = document.createElement('span');
  name.className = 'ci-name';
  name.textContent = item.name;
  name.title = item.name;
  const took = document.createElement('span');
  took.className = 'ci-took';
  took.textContent = ciTook(item.startedAt, running ? new Date().toISOString() : item.completedAt);
  return [dot, name, took];
}

function ciLogEl(log) {
  const d = document.createElement('details');
  d.className = 'ag-out err';
  d.open = true;
  const sum = document.createElement('summary');
  sum.textContent = tr(log.cut ? 'ci.logCut' : 'ci.log');
  const pre = document.createElement('pre');
  pre.textContent = log.text;
  d.append(sum, pre);
  return d;
}

function ciJobEl(job, logs, enter) {
  const box = document.createElement('section');
  box.className = 'ci-job' + (enter ? ' enter' : '');
  // The state class sits on each row, not the box: `.ci-fail .ci-dot` would
  // otherwise paint every step of a failed job red.
  const head = document.createElement('header');
  head.className = 'ci-job-head ci-' + ciState(job);
  head.append(...ciRowParts(job, ciState(job) === 'run' && !!job.startedAt));
  box.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'ci-steps';
  const loose = logs.slice();
  for (const step of (job.steps || [])) {
    const st = ciState(step);
    const li = document.createElement('li');
    li.className = 'ci-step ci-' + (st === 'run' && step.status !== 'in_progress' ? 'off' : st);
    li.append(...ciRowParts(step, step.status === 'in_progress'));
    const at = loose.findIndex((l) => l.step === step.name);
    if (at >= 0) li.appendChild(ciLogEl(loose.splice(at, 1)[0]));
    list.appendChild(li);
  }
  // Log lines gh couldn't pin to a step still belong to this job.
  for (const log of loose) {
    const li = document.createElement('li');
    li.className = 'ci-step ci-fail';
    li.append(...ciRowParts({ name: log.step }, false), ciLogEl(log));
    list.appendChild(li);
  }
  if (list.children.length) box.appendChild(list);
  return box;
}

/* What "Ask Claude to fix it" sends: which run, what failed, and the log ends. */
function ciFixMessage(v) {
  const run = v.run;
  const parts = [
    tr('ci.fixHead', { title: run.title || run.workflow, workflow: run.workflow || '—', branch: run.branch || '—' }),
    run.url,
  ];
  for (const l of v.logs) {
    parts.push('', tr('ci.fixStep', { job: l.job, step: l.step }), '```', l.text, '```');
  }
  if (!v.logs.length) {
    for (const job of (run.jobs || [])) {
      for (const step of (job.steps || [])) {
        if (ciState(step) === 'fail') parts.push(tr('ci.fixFailed', { job: job.name, step: step.name }));
      }
    }
  }
  parts.push('', tr('ci.fixAsk'));
  return parts.join('\n');
}

function sendCiFix() {
  const threadId = state.activeId;
  if (!ciView || !threadId) return;
  const msg = { text: ciFixMessage(ciView), files: [], refs: [] };
  closeCiRun();
  if (state.live.has(threadId) && typeof enqueueMessage === 'function') enqueueMessage(threadId, msg);
  else startTurn(threadId, msg, { follow: true });
}

els.ciClose.onclick = closeCiRun;
els.ciDone.onclick = closeCiRun;
els.ciWeb.onclick = () => { if (ciView) ciOpen(ciView.run.url); };
els.ciFix.onclick = sendCiFix;

// Backdrop click closes — unless the release just ended a text drag-select
// (same guard as the agent inspector): a log is something you select from.
let ciPressOnBackdrop = false;
els.ciOverlay.addEventListener('mousedown', (e) => { ciPressOnBackdrop = (e.target === els.ciOverlay); });
els.ciOverlay.addEventListener('mouseup', (e) => {
  if (ciPressOnBackdrop && e.target === els.ciOverlay) closeCiRun();
  ciPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.ciOverlay.hidden) closeCiRun();
});

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
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('branch.switchFailLabel'),
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
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr(failLabel),
      body: escapeHtml(String(e.message || e)) });
  }
}

