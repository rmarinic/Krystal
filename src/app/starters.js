/* starters.js   — starting points for a chat: Write / Research / Data / Code.
   Part of the chat frontend; shares one global scope (see core.js). Styles live
   in chat.css ("Starter cards").

   An empty box is the hardest place to begin, more so for anyone who doesn't
   think of Krystal as a coding tool. So the welcome screen and every brand-new
   chat offer four ways in. A card doesn't send anything: it writes a first
   message into the composer with [blanks] to fill, selects the first blank, and
   Tab walks to the next — you finish the sentence and send it yourself. */

const STARTERS = [
  { id: 'write', icon: 'edit' },
  { id: 'research', icon: 'globe' },
  { id: 'data', icon: 'chart' },
  { id: 'code', icon: 'terminal' },
];
const STARTER_BLANK = /\[[^\[\]\n]{1,60}\]/g;
let starterBlanks = false;   // the composer holds a starter whose blanks Tab walks

/* The cards. `where`: 'welcome' (under the welcome screen's buttons) or 'chat'
 * (centred in a new, empty chat). */
function starterBlock(where) {
  const box = document.createElement('div');
  box.className = 'starters starters-' + where;
  if (where === 'chat') {
    box.innerHTML = `<h2>${escapeHtml(tr('starters.title'))}</h2><p>${escapeHtml(tr('starters.sub'))}</p>`;
  } else {
    box.innerHTML = `<div class="starters-lead">${escapeHtml(tr('starters.lead'))}</div>`;
  }
  const grid = document.createElement('div');
  grid.className = 'starter-grid';
  STARTERS.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'starter-card';
    b.style.setProperty('--i', i);
    b.innerHTML =
      `<span class="starter-ico">${icon(s.icon)}</span>` +
      `<span class="starter-name">${escapeHtml(tr('starter.' + s.id + '.name'))}</span>` +
      `<span class="starter-blurb">${escapeHtml(tr('starter.' + s.id + '.blurb'))}</span>`;
    b.onclick = () => pickStarter(s);
    grid.appendChild(b);
  });
  box.appendChild(grid);
  return box;
}

async function pickStarter(s) {
  if (!state.activeId) {
    const t = await startNewChat();
    if (!t) return;
  }
  els.input.value = tr('starter.' + s.id + '.prompt');
  autosize();
  saveDraft(state.activeId, els.input.value);
  if (typeof syncQueueBtn === 'function') syncQueueBtn();
  starterBlanks = true;
  els.input.focus();
  selectStarterBlank(0);
  replayClass(els.composer, 'fresh', 700);
}

/* Select the first [blank] at or after `from` (wrapping round). False if none. */
function selectStarterBlank(from) {
  const text = els.input.value;
  const all = [...text.matchAll(STARTER_BLANK)];
  if (!all.length) return false;
  const m = all.find((x) => x.index >= from) || all[0];
  els.input.setSelectionRange(m.index, m.index + m[0].length);
  return true;
}

/* Tab moves to the next blank — only while a starter is being filled in, so Tab
 * keeps its usual meaning everywhere else. */
els.input.addEventListener('keydown', (e) => {
  if (!starterBlanks || e.key !== 'Tab' || e.shiftKey || e.defaultPrevented) return;
  if (selectStarterBlank(els.input.selectionEnd)) e.preventDefault();
  else starterBlanks = false;
});
els.input.addEventListener('input', () => {
  if (starterBlanks && !STARTER_BLANK.test(els.input.value)) starterBlanks = false;
  STARTER_BLANK.lastIndex = 0;
});

/* The first message is on its way: the starting points have done their job. */
function clearStarters() {
  starterBlanks = false;
  const box = els.feed.querySelector('.starters-chat');
  if (box) box.remove();
}

/* The welcome screen carries the cards under its own buttons. */
(function addWelcomeStarters() {
  const wrap = els.empty && els.empty.querySelector('.empty-actions');
  if (wrap) wrap.after(starterBlock('welcome'));
})();

/* Language switched: the cards are rebuilt in the new one. */
document.addEventListener('i18n:changed', () => {
  document.querySelectorAll('.starters').forEach((old) => {
    old.replaceWith(starterBlock(old.classList.contains('starters-chat') ? 'chat' : 'welcome'));
  });
});
