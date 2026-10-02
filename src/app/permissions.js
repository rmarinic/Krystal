/* permissions.js — Ask mode: the permission prompt above the composer
   Part of the chat frontend; shares one global scope (see core.js). */

/* In Auto mode Claude never asks. In **Ask** mode it behaves as it does in a
 * terminal: reading is free, and anything that would change a file or run a
 * command stops for a yes or no. The CLI decides *what* needs asking (its own
 * rules, plus whatever the user has allowed in `.claude/settings*.json`); the
 * backend forwards each question as a `permission` event and takes it back with
 * `permission_gone` — when it is answered, from here or from another view of the
 * same turn, or withdrawn because the turn was stopped.
 *
 * The prompt docks above the composer rather than sitting in the transcript: a
 * turn is *waiting on it*, so it must not scroll out of sight, and it is not part
 * of what was said — nothing about it is saved.
 *
 * A turn can be waiting on several at once (parallel tool calls, sub-agents), so
 * each live turn keeps a queue (`live.permissions`) and the card shows the front
 * of it. The queue lives on the liveTurn like everything else about a turn in
 * flight, so it survives switching chats and a turn mirrored from the phone gets
 * it for free. */

function permissionQueue(live) { return live.permissions || (live.permissions = []); }

/* Is this chat's turn stopped on a question? (The sidebar marks it.) */
function threadAwaitsPermission(threadId) {
  const live = state.live.get(threadId);
  return !!(live && live.permissions && live.permissions.length);
}

/* A new question arrived for `live`. */
function permissionAsked(live, msg) {
  if (!msg || !msg.id) return;
  const queue = permissionQueue(live);
  if (queue.some((p) => p.id === msg.id)) return;
  queue.push(msg);
  if (live.threadId === state.activeId) renderPermission();
  else if (queue.length === 1) tipPermission(live);   // it's waiting in a chat you can't see
  if (state.view === 'threads') renderSidebar();
}

/* A question is settled or withdrawn. */
function permissionGone(live, id) {
  const queue = live.permissions;
  if (!queue || !queue.length) return;
  const at = queue.findIndex((p) => p.id === id);
  if (at < 0) return;
  queue.splice(at, 1);
  if (!queue.length) dropPermissionTip(live.threadId);
  if (live.threadId === state.activeId) renderPermission();
  if (state.view === 'threads') renderSidebar();
}

/* The turn is over — whatever it was still asking can't be answered any more. */
function permissionsTurnEnded(live) {
  if (live.permissions) live.permissions.length = 0;
  dropPermissionTip(live.threadId);
  if (live.threadId === state.activeId) renderPermission();
}

/* ------------------------------- the wording ------------------------------ */

const PERMISSION_TITLES = {
  Bash: 'perm.title.run',
  Edit: 'perm.title.edit', MultiEdit: 'perm.title.edit', NotebookEdit: 'perm.title.edit',
  Write: 'perm.title.write',
  Read: 'perm.title.read',
  WebFetch: 'perm.title.fetch',
  WebSearch: 'perm.title.search',
};

/* `mcp__server__tool` → "tool (server)"; anything else as it is. */
function permissionToolName(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  return m ? `${m[2]} (${m[1]})` : (tool || '');
}

function permissionTitle(p) {
  const key = PERMISSION_TITLES[p.tool];
  return key ? tr(key) : tr('perm.title.tool', { tool: permissionToolName(p.tool) });
}

/* What the "always" button would do, in words. The CLI proposes the rule itself
 * (see `permission_always` in claude.rs); we only describe it, so the button says
 * what it is agreeing to — the terminal's "Yes, and don't ask again for …".
 * Returns null when the CLI offered nothing to make permanent. */
function permissionAlways(p) {
  const items = Array.isArray(p.always) ? p.always : [];
  if (!items.length) return null;

  const short = (s) => (s.length > 34 ? s.slice(0, 33) + '…' : s);
  const rules = items.filter((a) => a.kind === 'rule');
  const dirs = items.filter((a) => a.kind === 'dir');
  let label;
  if (items.some((a) => a.kind === 'mode' && a.text === 'acceptEdits')) {
    label = tr('perm.always.edits');
  } else if (rules.length) {
    const first = rules[0].text || permissionToolName(rules[0].tool);
    label = tr('perm.always.rule', { rule: short(first) }) + (rules.length > 1 ? ` +${rules.length - 1}` : '');
  } else if (dirs.length) {
    label = tr('perm.always.dir', { dir: short(basename(dirs[0].text)) });
  } else {
    label = tr('perm.always.generic');
  }

  // The tooltip spells out every part of it, and where each one is remembered.
  const title = items.map((a) => {
    const what =
      a.kind === 'rule' ? (a.text ? `${permissionToolName(a.tool)}: ${a.text}` : permissionToolName(a.tool))
      : a.kind === 'mode' ? tr('perm.does.edits')
      : a.kind === 'dir' ? tr('perm.does.dir', { dir: a.text })
      : tr('perm.always.generic');
    const where = tr('perm.scope.' + a.scope, null, '');
    return where ? `${what} — ${where}` : what;
  }).join('\n');

  return { label, title };
}

/* -------------------------------- the card -------------------------------- */

/* Paint the front of the on-screen chat's queue (or hide the strip). Rebuilds
 * only when the question on show actually changes, so a second one queueing up
 * behind it doesn't reset a diff the user has scrolled. `force` repaints anyway
 * (language switch). */
function renderPermission(force) {
  const el = els.composerPerm;
  if (!el) return;
  const live = state.activeId ? state.live.get(state.activeId) : null;
  const queue = (live && live.permissions) || [];
  const p = queue[0];
  if (!p) {
    el.hidden = true;
    el.innerHTML = '';
    delete el.dataset.pid;
    return;
  }
  const more = queue.length - 1;
  if (!force && !el.hidden && el.dataset.pid === p.id) {
    paintPermissionMore(el, more);
    return;
  }

  el.innerHTML = '';
  el.dataset.pid = p.id;
  const card = document.createElement('div');
  card.className = 'perm-card';

  const head = document.createElement('div');
  head.className = 'perm-head';
  head.innerHTML =
    '<span class="perm-ico" aria-hidden="true">🛡</span>' +
    `<span class="perm-title">${escapeHtml(permissionTitle(p))}</span>` +
    '<span class="perm-more" hidden></span>';
  card.appendChild(head);

  // A shell command's own one-line account of itself.
  if (p.why) {
    const why = document.createElement('div');
    why.className = 'perm-why';
    why.textContent = p.why;
    card.appendChild(why);
  }

  // Exactly what is being agreed to: the command, or the file and its change.
  const hasChange = (Array.isArray(p.edits) && p.edits.length) || p.content != null;
  if (p.detail) {
    const what = document.createElement(hasChange ? 'div' : 'pre');
    what.className = hasChange ? 'perm-path' : 'perm-what';
    what.textContent = (p.tool === 'Bash' ? '$ ' : '') + p.detail;
    card.appendChild(what);
  }
  if (Array.isArray(p.edits) && p.edits.length) {
    const diff = renderDiff(p.edits);
    diff.classList.add('perm-diff');
    card.appendChild(diff);
  } else if (p.content != null) {
    const pre = document.createElement('pre');
    pre.className = 'perm-what';
    pre.textContent = p.content;
    card.appendChild(pre);
  }

  const acts = document.createElement('div');
  acts.className = 'perm-acts';
  const threadId = live.threadId;
  const button = (cls, text, decision, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'perm-btn ' + cls;
    b.textContent = text;
    if (title) b.title = title;
    b.onclick = () => answerPermission(threadId, p.id, decision, acts);
    acts.appendChild(b);
  };
  button('allow', tr('perm.allow'), 'allow');
  const always = permissionAlways(p);
  if (always) button('always', always.label, 'always', always.title);
  button('deny', tr('perm.deny'), 'deny', tr('perm.denyTitle'));
  card.appendChild(acts);

  el.appendChild(card);
  paintPermissionMore(el, more);
  el.hidden = false;
  replayClass(el, 'in');
}

function paintPermissionMore(el, more) {
  const tag = el.querySelector('.perm-more');
  if (!tag) return;
  tag.hidden = more <= 0;
  tag.textContent = more > 0 ? tr('perm.more', { n: more }) : '';
}

/* Send the decision. The turn confirms with `permission_gone` (which is how a
 * second view of this turn learns of it), but the card goes as soon as the
 * backend has taken the answer — no reason to leave live buttons on screen. */
async function answerPermission(threadId, id, decision, acts) {
  const buttons = acts ? [...acts.querySelectorAll('button')] : [];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await api.answerPermission(threadId, id, decision);
  } catch (e) {
    buttons.forEach((b) => { b.disabled = false; });
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('perm.failed'),
      body: escapeHtml(String((e && e.message) || e)) });
    return;
  }
  const live = state.live.get(threadId);
  if (live) permissionGone(live, id);
}

/* ------------------------- a question you can't see ----------------------- */
/* The turn is waiting in a chat that isn't on screen. The sidebar marks it, but
 * a turn that has silently stopped is worth saying out loud, once. */
const permissionTips = new Map();   // threadId -> close()

function tipPermission(live) {
  dropPermissionTip(live.threadId);
  const thread = state.threads.find((t) => t.id === live.threadId);
  const title = (thread && thread.title) || tr('nav.newChatTitle');
  const close = showTip({
    key: 'perm-' + live.threadId, cls: 'warn', icon: '🛡', label: tr('perm.tipLabel'),
    body: escapeHtml(tr('perm.tipBody', { title })),
    actions: [{ text: tr('perm.tipOpen'), run: (done) => { done(); openThread(live.threadId); } }],
  });
  permissionTips.set(live.threadId, close);
}

function dropPermissionTip(threadId) {
  const close = permissionTips.get(threadId);
  if (!close) return;
  permissionTips.delete(threadId);
  close();
}

/* Opening a chat: show what its turn is waiting on (and it no longer needs a
 * tip pointing at it). Called from `openThread`. */
function syncPermission() {
  if (state.activeId) dropPermissionTip(state.activeId);
  renderPermission();
}

window.addEventListener('i18n:changed', () => renderPermission(true));
