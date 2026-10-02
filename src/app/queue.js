/* queue.js      — queued messages: type while Claude works, sent when it's done
   Part of the chat frontend; shares one global scope (see core.js). */

/* A running turn used to leave two choices: wait for it, or stop it. Now a
 * message sent while the chat's turn is still running is **queued** instead. It
 * waits in a strip above the composer and goes out the moment that turn
 * finishes — one message per turn, in the order they were typed.
 *
 * The queue is the frontend's alone. The backend still sees one ordinary `chat`
 * call per message; `finishLive` (stream.js) hands over to `queueTurnEnded`,
 * which starts the next one through the same `startTurn` a typed message uses.
 * So a queued message is saved, streamed, mirrored and stopped exactly like any
 * other — and it goes out whether or not its chat is the one on screen.
 *
 * Queues are per chat, like the composer draft, and kept in localStorage so
 * closing the app doesn't swallow what was typed.
 *
 * **On hold.** Only a turn that *finished* pulls the next message. One that was
 * stopped or failed leaves the queue where it is: you stopped Claude for a
 * reason, and "now commit it" firing straight after is not what you meant. The
 * strip then says so and offers "Send now". Nothing records that state — a queue
 * with no turn running *is* a queue on hold, which also covers one left over
 * from a session the app was closed in the middle of. */

const QUEUE_KEY = 'krystal.queue';
let queues = (function loadQueues() {   // threadId -> [{ id, text, files, refs }]
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || {}; } catch (_) { return {}; }
})();
function persistQueues() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queues)); } catch (_) {}
}
let queueSeq = Date.now();   // item ids — unique across restarts, since queues outlive one

function queueFor(id) {
  const q = id && queues[id];
  return Array.isArray(q) ? q : [];
}
/* How many messages a chat has waiting. (The sidebar marks it.) */
function queuedCount(id) { return queueFor(id).length; }

/* The queue of `threadId` changed: save it and repaint what shows it. `freshId`
 * is the item that was just added, so only that row plays its entrance. */
function queueChanged(threadId, freshId) {
  if (!queueFor(threadId).length) delete queues[threadId];
  persistQueues();
  if (threadId === state.activeId) renderQueue(freshId);
  if (state.view === 'threads') renderSidebar();
}

/* Add a message ({ text, files, refs } — the shape `startTurn` takes) to the end
 * of a chat's queue. Called by `send()` when that chat's turn is still running. */
function enqueueMessage(threadId, msg) {
  if (!threadId) return;
  const item = { id: ++queueSeq, text: msg.text || '', files: msg.files || [], refs: msg.refs || [] };
  queues[threadId] = queueFor(threadId).concat(item);
  queueChanged(threadId, item.id);
}

/* Take one message back out of a queue (to drop it, or to edit it). */
function takeQueued(threadId, itemId) {
  const q = queueFor(threadId);
  const at = q.findIndex((m) => m.id === itemId);
  if (at < 0) return null;
  const item = q.splice(at, 1)[0];
  queueChanged(threadId);
  return item;
}

/* Forget a chat's queue entirely (the chat was deleted). */
function dropQueue(threadId) {
  if (!threadId || !queues[threadId]) return;
  delete queues[threadId];
  persistQueues();
}

/* Send the message at the front of a chat's queue, if nothing is running there. */
function sendNextQueued(threadId, opts) {
  if (state.live.has(threadId)) return;
  const q = queueFor(threadId);
  if (!q.length) return;
  const item = q.shift();
  if (!q.length) delete queues[threadId];
  persistQueues();
  startTurn(threadId, item, opts);   // repaints the strip and the sidebar itself
}

/* A turn ended (called from `finishLive`, after the liveTurn is gone). */
function queueTurnEnded(live) {
  const threadId = live.threadId;
  if (!queuedCount(threadId)) return;
  const onScreen = threadId === state.activeId;
  // Stopped or failed: hold. On screen the strip already says so (syncComposer
  // repainted it); a chat you can't see is worth a word.
  if (live.stopped || live.failed) {
    if (!onScreen) tipQueueHeld(threadId);
    return;
  }
  // An answer picked on a question card belongs to the turn that just asked it,
  // so it goes first (see `flushPendingAnswer`); the queue follows that turn.
  if (onScreen && pendingAnswer) return;
  sendNextQueued(threadId, { activity: live.activity });
}

/* -------------------------------- the strip ------------------------------- */

const QUEUE_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 12h11M4 18h6"/><path d="M18 15v6M15 18h6"/></svg>';

/* What a queued message looks like on one line: its text, or — for one that is
 * only attachments — the names of the files. */
function queuedSummary(item) {
  const text = (item.text || '').replace(/\s+/g, ' ').trim();
  return text || (item.files || []).map(basename).join(', ');
}

/* Paint the on-screen chat's queue above the composer (or hide the strip). */
function renderQueue(freshId) {
  const el = els.composerQueue;
  if (!el) return;
  const threadId = state.activeId;
  const q = queueFor(threadId);
  if (!q.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const held = !state.live.has(threadId);
  el.innerHTML = '';
  el.classList.toggle('held', held);

  const head = document.createElement('div');
  head.className = 'queue-head';
  const label = document.createElement('span');
  label.className = 'queue-label';
  label.textContent = tr(held ? 'queue.held' : 'queue.waiting');
  head.appendChild(label);
  if (held) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'queue-go';
    go.textContent = tr('queue.sendNow');
    go.onclick = () => sendNextQueued(threadId, { follow: true });
    head.appendChild(go);
  }
  el.appendChild(head);

  const list = document.createElement('div');
  list.className = 'queue-list';
  q.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item' + (item.id === freshId ? ' in' : '');
    const add = (tag, cls, text) => {
      const node = document.createElement(tag);
      node.className = cls;
      node.textContent = text;
      row.appendChild(node);
      return node;
    };
    add('span', 'queue-num', String(i + 1));
    add('span', 'queue-text', queuedSummary(item)).title = item.text || '';
    const files = (item.files || []).length;
    if (files && item.text) add('span', 'queue-files', '📎 ' + files);
    const action = (cls, glyph, label, run) => {
      const b = add('button', 'queue-act ' + cls, glyph);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.onclick = run;
    };
    action('edit', '✎', tr('queue.edit'), () => editQueued(threadId, item.id));
    action('x', '×', tr('queue.remove'), () => { takeQueued(threadId, item.id); els.input.focus(); });
    list.appendChild(row);
  });
  el.appendChild(list);
  el.hidden = false;
  if (freshId) list.scrollTop = list.scrollHeight;   // the one just added is at the end
}

/* Pull a queued message back into the composer to change it — its text, its
 * attachments and its #-references all come back. Anything already typed there
 * is kept, with the queued message after it. */
function editQueued(threadId, itemId) {
  if (threadId !== state.activeId) return;
  const item = takeQueued(threadId, itemId);
  if (!item) return;
  const typed = els.input.value.replace(/\s+$/, '');
  els.input.value = typed ? typed + '\n' + item.text : item.text;
  saveDraft(threadId, els.input.value);
  if (typeof restoreComposerRefs === 'function') restoreComposerRefs(item.refs);
  if (typeof attachSavedPath === 'function') (item.files || []).forEach(attachSavedPath);
  autosize();
  syncShellMode();
  syncQueueBtn();
  els.input.focus();
}

/* ------------------------------ queue button ------------------------------ */
/* Mid-turn the send button is the Stop button, so Enter is the only way to
 * queue — which nobody would guess. Once there is something to queue, a second
 * button appears beside it and says what it does. */

function syncQueueBtn() {
  const btn = els.queueBtn;
  if (!btn) return;
  const raw = els.input.value;
  const has = !!raw.trim() || (typeof hasComposerAttachments === 'function' && hasComposerAttachments());
  btn.hidden = !(state.streaming && has && !isShellInput(raw));
}

if (els.queueBtn) {
  els.queueBtn.innerHTML = QUEUE_SVG;
  els.queueBtn.onclick = () => { send(); els.input.focus(); };
}

/* --------------------------- a queue you can't see ------------------------ */
/* A turn was stopped or failed in a chat that isn't on screen, and messages are
 * still waiting behind it. Nothing will send them now, so say so, once. */
function tipQueueHeld(threadId) {
  const thread = state.threads.find((t) => t.id === threadId);
  const title = (thread && thread.title) || tr('nav.newChatTitle');
  showTip({
    key: 'queue-' + threadId, cls: 'warn', icon: '⏸', label: tr('queue.tipLabel'),
    body: escapeHtml(tr('queue.tipBody', { title })),
    actions: [{ text: tr('queue.tipOpen'), run: (done) => { done(); openThread(threadId); } }],
  });
}
