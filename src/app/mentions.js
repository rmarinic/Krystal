/* mentions.js   — #-reference another chat for context from the composer
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ chat refs -------------------------------- */
/* Type `#` in the composer to pull up an autocomplete of this project's other
 * chats; pick one and its title is inserted inline ("…we covered this in
 * #Old chat"). Referenced chats show as small pills above the input and ride
 * along as background context for that turn — their transcripts are handed to
 * the backend (`chat` command's `refs`), which folds them into the prompt.
 *
 * References are tracked by thread id (not fragile title re-parsing): selecting a
 * chat records it; on send we keep only those whose inserted token is still in
 * the text. Stale ids are harmless — the backend just skips anything empty. */

const composerRefs = new Map();   // threadId -> { id, title, token }
const mentionState = { open: false, items: [], sel: 0 };

/* ----------------------------- query detect ------------------------------ */

// The `#token` being typed right before the caret (or null). The token runs to
// the caret and stops at whitespace, so a finished "#Title " no longer matches.
function currentMentionQuery() {
  const el = els.input;
  if (document.activeElement !== el) return null;
  const before = el.value.slice(0, el.selectionStart);
  const m = /(?:^|\s)#([^\s#]*)$/.exec(before);
  return m ? { query: m[1] } : null;
}

function onComposerInput() {
  reconcileRefs();
  if (isShellInput(els.input.value)) return closeMentionPop();   // `$` shell mode owns the line
  const q = currentMentionQuery();
  if (!q) return closeMentionPop();
  openMentionPop(q.query);
}

// Drop any reference whose inserted token the user has since edited away.
function reconcileRefs() {
  const v = els.input.value;
  let changed = false;
  for (const [id, ref] of composerRefs) {
    if (!v.includes(ref.token)) { composerRefs.delete(id); changed = true; }
  }
  if (changed) renderRefPills();
}

/* ------------------------------- popup ----------------------------------- */

function threadHasContent(t) { return !!(t.usage && t.usage.turns); }

function openMentionPop(query) {
  const q = (query || '').toLowerCase();
  const items = (state.threads || []).filter((t) =>
    t.id !== state.activeId &&
    !composerRefs.has(t.id) &&
    threadHasContent(t) &&
    (!q || (t.title || '').toLowerCase().includes(q))
  ).slice(0, 8);
  mentionState.items = items;
  mentionState.sel = 0;
  mentionState.open = true;
  renderMentionPop();
}

function renderMentionPop() {
  const pop = els.mentionPop;
  if (!mentionState.items.length) {
    pop.innerHTML = `<div class="mention-empty">${escapeHtml(tr('mention.none'))}</div>`;
    pop.hidden = false;
    replayClass(pop, 'mention-in');
    return;
  }
  pop.innerHTML = mentionState.items.map((t, i) => {
    const title = t.title || tr('nav.newChatTitle');
    const when = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString() : '';
    return `<button class="mention-item${i === mentionState.sel ? ' sel' : ''}" data-i="${i}">` +
        `<span class="mention-hash" aria-hidden="true">#</span>` +
        `<span class="mention-title">${escapeHtml(title)}</span>` +
        `<span class="mention-when">${escapeHtml(when)}</span>` +
      `</button>`;
  }).join('');
  pop.hidden = false;
  replayClass(pop, 'mention-in');
  // mousedown (not click) so picking an item doesn't blur the textarea first.
  pop.querySelectorAll('.mention-item').forEach((b) => {
    b.addEventListener('mousedown', (e) => { e.preventDefault(); chooseMention(mentionState.items[+b.dataset.i]); });
  });
}

function paintMentionSel() {
  els.mentionPop.querySelectorAll('.mention-item').forEach((b, i) =>
    b.classList.toggle('sel', i === mentionState.sel));
}

function closeMentionPop() {
  mentionState.open = false;
  mentionState.items = [];
  if (els.mentionPop) { els.mentionPop.hidden = true; els.mentionPop.innerHTML = ''; }
}

// Returns true when it consumed the key (so the composer's Enter-to-send bails).
function mentionKeydown(e) {
  if (!mentionState.open) return false;
  if (e.key === 'Escape') { closeMentionPop(); e.preventDefault(); return true; }
  const n = mentionState.items.length;
  if (!n) return false;                       // empty list — let Enter send as usual
  if (e.key === 'ArrowDown') { mentionState.sel = (mentionState.sel + 1) % n; paintMentionSel(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { mentionState.sel = (mentionState.sel - 1 + n) % n; paintMentionSel(); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { chooseMention(mentionState.items[mentionState.sel]); e.preventDefault(); return true; }
  return false;
}

/* ----------------------------- select / pills ---------------------------- */

function chooseMention(thread) {
  if (!thread) return closeMentionPop();
  const el = els.input;
  const pos = el.selectionStart;
  const before = el.value.slice(0, pos);
  const after = el.value.slice(pos);
  const m = /(?:^|\s)#([^\s#]*)$/.exec(before);
  if (!m) return closeMentionPop();

  const title = thread.title || tr('nav.newChatTitle');
  const token = '#' + title;
  const insert = token + ' ';
  const start = pos - m[1].length - 1;        // index of the '#'
  el.value = before.slice(0, start) + insert + after;
  const caret = start + insert.length;
  el.setSelectionRange(caret, caret);

  composerRefs.set(thread.id, { id: thread.id, title, token });
  closeMentionPop();
  renderRefPills();
  autosize();
  el.focus();
}

function renderRefPills() {
  const box = els.composerRefs;
  if (!box) return;
  if (!composerRefs.size) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const ref of composerRefs.values()) {
    const pill = document.createElement('span');
    pill.className = 'composer-ref';
    pill.innerHTML =
      `<span class="ref-ico" aria-hidden="true">🔗</span>` +
      `<span class="ref-title"></span>` +
      `<button class="ref-x" title="${escapeHtml(tr('mention.removeRef'))}" aria-label="${escapeHtml(tr('mention.removeRef'))}">×</button>`;
    pill.querySelector('.ref-title').textContent = ref.title;
    pill.querySelector('.ref-x').onclick = () => removeRef(ref.id);
    box.appendChild(pill);
  }
  box.hidden = false;
}

function removeRef(id) {
  const ref = composerRefs.get(id);
  if (!ref) return;
  composerRefs.delete(id);
  // Strip the inserted token (and a trailing space) back out of the message.
  els.input.value = els.input.value.split(ref.token + ' ').join('').split(ref.token).join('');
  renderRefPills();
  autosize();
  els.input.focus();
}

/* Thread ids still referenced in `text`, for the chat command's `refs`. */
function resolveComposerRefs(text) {
  const out = [];
  for (const ref of composerRefs.values()) if (text.includes(ref.token)) out.push(ref.id);
  return out;
}

function clearComposerRefs() {
  composerRefs.clear();
  renderRefPills();
  closeMentionPop();
}

/* -------------------------------- wiring --------------------------------- */

// Close the popup when focus leaves the composer (after a tick so an item's
// mousedown still registers).
els.input.addEventListener('blur', () => { setTimeout(closeMentionPop, 120); });
