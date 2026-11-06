/* harder.js     — "Try harder": one more, more careful pass at the last reply
   Part of the chat frontend; shares one global scope (see core.js).

   Effort (`claude --effort`) is the biggest quality lever after the model: on
   the public coding-agent benchmarks, the same Claude goes from 55 to 63 to 68
   between high, xhigh and max. It also costs: each step is slower and spends
   more of the plan. So the default stays `high`, and the step up is offered where
   it's wanted — right under the reply that fell short — instead of being
   something you must remember to change *before* you ask.

   A click moves the chat's effort one step up (it stays there, and the picker
   shows it) and sends a message asking for another, more careful pass. The
   first attempt is kept in the conversation on purpose: what was tried, and
   any files it already changed, are exactly what the second pass should build
   on. Only the latest reply offers it, never while a turn runs, and not once the
   chat is already at the top step.

   It rests still: one quiet button that appears with the reply and goes when
   the next message does. The choice is pure (`harderOffer`), tested in
   tests/harder.test.js. */

/* The effort one step above `cur` in the offered list, or null at the top (or
 * for an id the list doesn't know). */
function nextEffort(cur, ids) {
  const i = ids.indexOf(cur);
  return i >= 0 && i < ids.length - 1 ? ids[i + 1] : null;
}

/* Whether the latest message gets the button, and what it would raise to.
 * `last`: { role, shell } of the last message on screen (null: none). */
function harderOffer({ last, live, effort, efforts }) {
  if (!last || live) return null;
  if (last.role !== 'assistant' || last.shell) return null;   // a `$` run isn't Claude's answer
  return nextEffort(effort, efforts);
}

/* Put the button under the on-screen chat's latest reply, or take it away.
 * Called whenever that could change: a chat opened, a turn started or ended,
 * the effort picked by hand. */
function harderSync() {
  const old = els.feed.querySelector('.try-harder');
  const msgs = els.feed.querySelectorAll('.msg');
  const lastEl = msgs.length ? msgs[msgs.length - 1] : null;
  const next = state.activeId && harderOffer({
    last: lastEl ? {
      role: lastEl.classList.contains('assistant') ? 'assistant' : 'user',
      shell: lastEl.classList.contains('shell'),
    } : null,
    live: state.live.has(state.activeId),
    effort: effortSel ? effortSel.getValue() : state.defaultEffort,
    efforts: (state.efforts || []).map((e) => e.id),
  });
  if (!next) { if (old) old.remove(); return; }
  if (old && old.dataset.to === next && old.parentNode === lastEl) return;   // already right
  if (old) old.remove();
  const name = tr('effort.' + next + '.name');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'try-harder';
  btn.dataset.to = next;
  btn.title = tr('harder.title', { level: name });
  btn.innerHTML = `${icon('bulb')}<span>${escapeHtml(tr('harder.btn'))}</span>` +
    `<span class="th-level">${escapeHtml(name)}</span>`;
  btn.onclick = () => tryHarder(btn);
  lastEl.appendChild(btn);
}

/* Raise the chat's effort one step and ask for another pass. */
async function tryHarder(btn) {
  const threadId = state.activeId;
  const next = btn.dataset.to;
  if (!threadId || !next || state.live.has(threadId)) return;
  btn.disabled = true;
  try {
    await api.setEffort(threadId, next);
  } catch (e) {
    btn.disabled = false;
    showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('harder.failLabel'),
      body: escapeHtml(String((e && e.message) || e)) });
    return;
  }
  if (threadId !== state.activeId) return;   // you went elsewhere meanwhile
  if (effortSel) effortSel.set(next);
  btn.remove();
  startTurn(threadId, { text: tr('harder.msg'), files: [], refs: [] }, { follow: true });
}
