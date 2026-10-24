/* notifications.js — the bell, its panel, toasts, and the project cards' live mark
   Part of the chat frontend; shares one global scope (see core.js). */

/* Turns run whether or not their chat is on screen — in another chat, in another
 * project, behind the project list. Until now the only trace of one landing was a
 * dot in a sidebar you might not be looking at. So anything that happens in a chat
 * you *can't see* becomes a notification: a reply finished, a reply failed, Claude
 * stopped to ask a question or for permission, a queue was left on hold.
 *
 * A notification is two things: a **toast** that slides in under the bell and
 * leaves on its own, and a row in the **bell's panel** that stays until you deal
 * with it. Opening the chat is dealing with it — the row goes, wherever you
 * opened the chat from — so the list is only ever what you haven't looked at yet.
 * One row per chat: a newer event in the same chat replaces the older one.
 *
 * Nothing is raised for the chat on screen; you are already looking at it (and if
 * the window itself is in the background, the desktop notification covers that —
 * see `notifyAway` in stream.js).
 *
 * Also here, because it answers the same question from the other side: the
 * project list marks every project that has a turn in flight right now. */

const NOTIFS_KEY = 'krystal.notifications';
const NOTIFS_MAX = 40;          // rows kept; older ones fall off the end
const TOAST_MS = 6500;          // how long a toast stays
const TOAST_ASK_MS = 12000;     // …one that is holding a turn up stays longer
const TOAST_MAX = 4;            // on screen at once

/* What each kind looks like. The wording lives in i18n (`notif.kind.*`). */
const NOTIF_KINDS = {
  done:     { icon: '✓', tone: 'ok' },
  question: { icon: '?', tone: 'warn' },   // ended on an AskUserQuestion card
  plan:     { icon: '☰', tone: 'warn' },   // ended on a plan to approve
  ask:      { icon: '!', tone: 'warn' },   // stopped mid-turn on a permission prompt
  held:     { icon: '‖', tone: 'warn' },   // queued messages left unsent
  failed:   { icon: '×', tone: 'high' },
};

const BELL_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

let notifs = (function loadNotifs() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTIFS_KEY)) || [];
    // A permission prompt dies with its turn, and no turn survives a restart.
    return saved.filter((n) => n && n.id && n.kind !== 'ask');
  } catch (_) { return []; }
})();
let notifSeq = Date.now();
const toastClosers = new Map();   // notification id -> close()

function persistNotifs() {
  try { localStorage.setItem(NOTIFS_KEY, JSON.stringify(notifs)); } catch (_) {}
}

function notifProjectName(path) {
  const p = (state.projects || []).find((x) => x.path === path);
  return (p && p.name) || (path ? basename(path) : '');
}

/* One readable line out of a reply: whitespace collapsed, the loudest markdown
 * marks dropped, cut to length. */
function notifSnippet(text) {
  const s = String(text || '').replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

/* ------------------------------ raising them ------------------------------ */

/* A turn began. Note which project it belongs to and what its chat is called —
 * the turn may end long after you've left that project, when `state.threads` no
 * longer has the chat to look them up in. */
async function liveTurnStarted(live) {
  const t = (state.threads || []).find((x) => x.id === live.threadId);
  if (t) {
    live.cwd = t.cwd;
    live.title = t.title;
  } else {
    try {
      const full = await api.thread(live.threadId);
      live.cwd = full.cwd;
      live.title = full.title;
    } catch (_) {}
  }
  paintProjectActivity();
}

/* How a finished turn left things: plainly done, or waiting on an answer to a
 * question / plan card it ended on. */
function turnEndKind(live) {
  for (const ev of live.events || []) {
    if (ev.type !== 'tool') continue;
    if (ev.name === 'AskUserQuestion' && Array.isArray(ev.questions) && ev.questions.length) return 'question';
    if ((ev.name === 'ExitPlanMode' || ev.name === 'exit_plan_mode') && ev.plan) return 'plan';
  }
  return 'done';
}

/* Something happened in `live`'s chat. Raised only if that chat isn't the one on
 * screen. `title` overrides the chat name noted when the turn began (a first turn
 * names its chat as it ends). */
async function notifyChat(live, kind, text, title) {
  const threadId = live.threadId;
  if (threadId === state.activeId) return;
  let cwd = live.cwd;
  let name = title || live.title;
  if (!cwd) {
    try {
      const t = await api.thread(threadId);
      cwd = t.cwd;
      name = name || t.title;
    } catch (_) {}
    // That took a moment: the chat may have been opened, or the question answered.
    if (threadId === state.activeId) return;
    if (kind === 'ask' && typeof threadAwaitsPermission === 'function' && !threadAwaitsPermission(threadId)) return;
  }

  dropNotifications(threadId);   // one row per chat
  const n = {
    id: String(++notifSeq), threadId, kind,
    project: cwd || '', title: name || '',
    text: notifSnippet(text), at: new Date().toISOString(),
  };
  notifs.unshift(n);
  if (notifs.length > NOTIFS_MAX) notifs.length = NOTIFS_MAX;
  persistNotifs();
  paintBell(true);
  renderNotifPanel();
  // With the panel open the new row is already in front of you.
  if (els.notifPop.hidden && settingOn('toasts')) showToast(n);
}

/* A chat was renamed by its first turn after the notification went up. */
function notificationRetitled(threadId, title) {
  if (!title) return;
  let changed = false;
  for (const n of notifs) {
    if (n.threadId === threadId && n.title !== title) { n.title = title; changed = true; }
  }
  if (!changed) return;
  persistNotifs();
  renderNotifPanel();
}

/* ------------------------------ settling them ----------------------------- */

/* Forget what was raised for a chat — all of it, or just one kind (a permission
 * prompt that has been answered). Called when the chat is opened. */
function dropNotifications(threadId, kind) {
  const gone = notifs.filter((n) => n.threadId === threadId && (!kind || n.kind === kind));
  if (!gone.length) return;
  forgetNotifs(gone);
}

function dropNotification(id) {
  forgetNotifs(notifs.filter((n) => n.id === id));
}

function forgetNotifs(gone) {
  if (!gone.length) return;
  for (const n of gone) {
    const close = toastClosers.get(n.id);
    if (close) close();
  }
  notifs = notifs.filter((n) => !gone.includes(n));
  persistNotifs();
  paintBell();
  renderNotifPanel();
}

/* Go to the chat a notification is about — entering its project first if that
 * isn't the one open. `openThread` clears the notification on the way in. */
async function openNotification(n) {
  closeNotifPanel();
  try {
    if (!state.project || state.project.path !== n.project) {
      let p = (state.projects || []).find((x) => x.path === n.project);
      if (!p) {
        const r = await api.projects();
        p = ((r && r.projects) || []).find((x) => x.path === n.project);
      }
      if (!p) throw new Error('project gone');
      await enterProject(p);
    }
    await openThread(n.threadId);
  } catch (_) {
    dropNotification(n.id);   // the chat (or its project) no longer exists
  }
}

/* --------------------------------- the bell ------------------------------- */

function paintBell(rang) {
  const count = notifs.length;
  document.querySelectorAll('.notif-toggle').forEach((b) => {
    if (!b.firstChild) b.innerHTML = BELL_SVG + '<span class="notif-badge" hidden></span>';
    const badge = b.querySelector('.notif-badge');
    // A count already showing rolls to the new one; "9+" and a fresh badge just appear.
    if (badge.hidden || count > 9) badge._rollAt = null;
    if (count > 9) badge.textContent = '9+';
    else rollNumber(badge, count);
    badge.hidden = !count;
    b.classList.toggle('has', count > 0);
    b.title = count ? tr('notif.bellTitleN', { n: count }) : tr('notif.bellTitle');
    if (rang) replayClass(b, 'ring', 700);
  });
}

/* What a notification says on its second line: the project, and when. */
function notifWhere(n) {
  const project = notifProjectName(n.project);
  const when = timeLabel(n.at);
  return project ? `${project} · ${when}` : when;
}

function renderNotifPanel() {
  const el = els.notifPop;
  if (!el || el.hidden) return;
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'notif-head';
  const title = document.createElement('span');
  title.className = 'notif-heading';
  title.textContent = tr('notif.title');
  head.appendChild(title);
  if (notifs.length) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'notif-clear';
    clear.textContent = tr('notif.clearAll');
    clear.onclick = () => forgetNotifs(notifs.slice());
    head.appendChild(clear);
  }
  el.appendChild(head);

  if (!notifs.length) {
    const empty = document.createElement('div');
    empty.className = 'notif-empty';
    empty.textContent = tr('notif.empty');
    el.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'notif-list';
  for (const n of notifs) {
    const li = document.createElement('li');
    li.className = 'notif-row';
    li.appendChild(notifBody(n));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'notif-x';
    x.textContent = '×';
    x.title = tr('notif.dismiss');
    x.setAttribute('aria-label', tr('notif.dismiss'));
    x.onclick = () => dropNotification(n.id);
    li.appendChild(x);
    list.appendChild(li);
  }
  el.appendChild(list);
}

/* The clickable part of a notification — the same in a toast and in the panel:
 * what happened, in which chat, in which project, and a line of the reply. */
function notifBody(n) {
  const kind = NOTIF_KINDS[n.kind] || NOTIF_KINDS.done;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'notif-open tone-' + kind.tone;
  b.title = tr('notif.openTitle');
  b.innerHTML =
    `<span class="notif-ico" aria-hidden="true">${kind.icon}</span>` +
    '<span class="notif-text">' +
      `<span class="notif-kind">${escapeHtml(tr('notif.kind.' + n.kind))}</span>` +
      `<span class="notif-chat">${escapeHtml(n.title || tr('nav.newChatTitle'))}</span>` +
      `<span class="notif-where">${escapeHtml(notifWhere(n))}</span>` +
      (n.text ? `<span class="notif-snip">${escapeHtml(n.text)}</span>` : '') +
    '</span>';
  b.onclick = () => openNotification(n);
  return b;
}

function openNotifPanel(anchor) {
  const el = els.notifPop;
  // The panel is the full list — whatever was still sliding about is in it.
  for (const close of [...toastClosers.values()]) close();
  el.hidden = false;
  renderNotifPanel();
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.round(r.bottom + 8) + 'px';
  el.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + 'px';
  requestAnimationFrame(() => el.classList.add('open'));
}

function closeNotifPanel() {
  const el = els.notifPop;
  if (!el || el.hidden) return;
  el.classList.remove('open');
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 180);
}

/* --------------------------------- toasts --------------------------------- */

function showToast(n) {
  const host = els.toasts;
  if (!host) return;
  // Newest on top; past the limit the oldest leaves early.
  const open = [...toastClosers.values()];
  if (open.length >= TOAST_MAX) open[0]();

  const card = document.createElement('div');
  card.className = 'toast';
  card.appendChild(notifBody(n));
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'notif-x';
  x.textContent = '×';
  x.title = tr('notif.hide');
  x.setAttribute('aria-label', tr('notif.hide'));
  card.appendChild(x);
  const bar = document.createElement('span');
  bar.className = 'toast-bar';
  card.appendChild(bar);

  const ms = n.kind === 'ask' ? TOAST_ASK_MS : TOAST_MS;
  bar.style.animationDuration = ms + 'ms';
  let timer = null;
  let closed = false;
  // Leaving is a slide out, then the gap it leaves closes — so the toasts under
  // it move up rather than jump.
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    toastClosers.delete(n.id);
    card.style.height = card.offsetHeight + 'px';
    void card.offsetWidth;
    card.classList.add('out');
    card.style.height = '0px';
    setTimeout(() => card.remove(), 360);
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(close, ms); };
  // Reading it holds it: the countdown starts over when the pointer leaves.
  card.addEventListener('mouseenter', () => { clearTimeout(timer); card.classList.add('held'); });
  card.addEventListener('mouseleave', () => {
    if (closed) return;
    card.classList.remove('held');
    replayClass(bar, 'draining');
    arm();
  });
  x.onclick = close;   // hides the toast only — the bell still has it

  toastClosers.set(n.id, close);
  host.prepend(card);
  requestAnimationFrame(() => { card.classList.add('show'); bar.classList.add('draining'); });
  arm();
}

/* ------------------------- projects with work going ----------------------- */

/* Mark each card on the project list whose project has a turn in flight (amber
 * if one of them is stopped on a permission prompt). The mark takes the place of
 * "last used …" on the card's last line, so a card never changes size. */
function paintProjectActivity() {
  if (!els.projectList || els.projectScreen.hidden) return;
  const busy = new Map();   // project path -> { n, asking }
  for (const live of state.live.values()) {
    if (!live.cwd) continue;
    const b = busy.get(live.cwd) || { n: 0, asking: false };
    b.n += 1;
    if (live.permissions && live.permissions.length) b.asking = true;
    busy.set(live.cwd, b);
  }
  for (const li of els.projectList.querySelectorAll('.project-card')) {
    const p = (state.projects || []).find((x) => String(x.id) === li.dataset.pid);
    const b = p && busy.get(p.path);
    const idle = li.querySelector('.proj-meta-idle');
    const liveEl = li.querySelector('.proj-meta-live');
    if (!idle || !liveEl) continue;
    li.classList.toggle('active', !!b);
    li.classList.toggle('needs-you', !!(b && b.asking));
    idle.hidden = !!b;
    liveEl.hidden = !b;
    if (!b) continue;
    const label = b.asking ? tr('project.liveAsk')
      : b.n > 1 ? tr('project.liveMany', { n: b.n }) : tr('project.live');
    const n = p.chatCount || 0;
    const chats = n === 1 ? tr('word.chat.one') : tr('word.chat.many');
    liveEl.innerHTML =
      '<span class="live-dot" aria-hidden="true"></span>' +
      `<span class="proj-live-label">${escapeHtml(label)}</span>` +
      `<span class="proj-live-rest"> · ${n} ${escapeHtml(chats)}</span>`;
  }
}

/* --------------------------------- wiring --------------------------------- */

document.querySelectorAll('.notif-toggle').forEach((b) => {
  b.onclick = () => {
    if (els.notifPop.hidden || !els.notifPop.classList.contains('open')) openNotifPanel(b);
    else closeNotifPanel();
  };
});
// Click anywhere else, or Escape, to put the panel away.
document.addEventListener('mousedown', (e) => {
  if (els.notifPop.hidden) return;
  if (e.target.closest('#notif-pop, .notif-toggle')) return;
  closeNotifPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNotifPanel();
});
document.addEventListener('i18n:changed', () => {
  paintBell();
  renderNotifPanel();
  paintProjectActivity();
});
paintBell();
