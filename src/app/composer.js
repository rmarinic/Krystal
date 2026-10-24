/* composer.js   — the message box: per-chat drafts, autosize, the `$` shell
                 mode, and the send/stop button
   Part of the chat frontend; shares one global scope (see core.js). */

/* ------------------------------ composer drafts -------------------------- *
 * What you've typed but not sent is kept PER CHAT: saved in localStorage (so it
 * survives closing the app) and restored when you reopen that chat. Switching
 * chats never loses an in-progress message, and the sidebar flags any chat that
 * has an unsent draft waiting (see updateDraftMark in sidebar.js). */
const DRAFTS_KEY = 'krystal.drafts';
let drafts = (function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch (_) { return {}; }
})();
function persistDrafts() {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch (_) {}
}
function getDraft(id) { return (id && drafts[id]) || ''; }
function hasDraft(id) { return !!(id && drafts[id] && drafts[id].trim()); }
/* Save (or clear) the draft for a chat. Only pokes the sidebar when the draft's
 * presence actually flips, so typing doesn't re-render the row on every keypress. */
function saveDraft(id, text) {
  if (!id) return;
  const had = !!drafts[id];
  if (text && text.trim()) drafts[id] = text; else delete drafts[id];
  const has = !!drafts[id];
  persistDrafts();
  if (had !== has && typeof updateDraftMark === 'function') updateDraftMark(id);
}
/* Forget a chat's draft entirely (e.g. the chat was deleted). */
function dropDraft(id) {
  if (id && drafts[id] != null) { delete drafts[id]; persistDrafts(); }
}

/* Fit the composer to its text. Growing is instant (a transition there would
 * leave the text a frame behind its box while you type); shrinking — a message
 * just sent, a paragraph deleted — exhales back down. */
function autosize() {
  const el = els.input;
  const prev = parseFloat(el.style.height) || 0;
  el.style.height = 'auto';
  const next = Math.min(el.scrollHeight, 200);
  const exhale = motionOK() && prev > next;
  el.classList.toggle('exhale', exhale);
  if (exhale) { el.style.height = prev + 'px'; void el.offsetHeight; }
  el.style.height = next + 'px';
}
els.input.addEventListener('input', () => {
  autosize(); syncShellMode();
  lightKey();                                   // the floor warms as you type (light.js)
  mascotKey();                                  // the face watches the caret (mascot.js)
  saveDraft(state.activeId, els.input.value);   // keep this chat's draft current
  if (typeof syncQueueBtn === 'function') syncQueueBtn();         // something to queue mid-turn?
  if (typeof onComposerInput === 'function') onComposerInput();   // # mention autocomplete
  if (typeof onComposerSlash === 'function') onComposerSlash();   // / skill picker
});
els.input.addEventListener('keydown', (e) => {
  // The # mention and / skill popups get first crack at navigation/selection
  // keys. Only one can be open at a time (they trigger on different text).
  if (typeof mentionKeydown === 'function' && mentionKeydown(e)) return;
  if (typeof skillKeydown === 'function' && skillKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

/* The `$` escape hatch: a leading `$` switches the composer to "shell mode",
 * where Enter runs the line as a shell command (in the project folder) instead
 * of messaging Claude. We light up the composer so the switch is unmistakable.
 * It works mid-turn too: the command runs beside Claude, not through it, so
 * there's nothing to wait for (the send button stays Stop; Enter runs it). */
function isShellInput(v) { return /^\s*\$/.test(v || ''); }
function shellCommandOf(v) { return (v || '').replace(/^\s*\$\s?/, ''); }
function syncShellMode() {
  const on = isShellInput(els.input.value);
  els.composer.classList.toggle('shell-mode', on);
}
/* The send button doubles as a stop button while a turn streams (when the
 * feature is enabled). Inline SVGs so syncComposer can swap them per state. */
const SEND_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';

// Both icons live in the button at once; CSS cross-morphs them as `.is-stop`
// toggles, so the arrow ships cleanly into the square (and back).
els.sendBtn.innerHTML = `<span class="ic ic-send">${SEND_SVG}</span><span class="ic ic-stop">${STOP_SVG}</span>`;
els.sendBtn.onclick = () => {
  if (state.streaming) stopActiveTurn();
  else send();
};
