/* find.js       — Find in chat (Ctrl+F): a small bar over the top of the
                   transcript that marks every match and steps through them.
   Part of the chat frontend; shares one global scope (see core.js). Styles live
   in css/find.css.

   Matches are painted with the CSS Custom Highlight API: ranges over the text as
   it stands, never <mark> elements spliced into it. The transcript changes under
   us all the time (livemd.js re-renders the block being streamed every frame, a
   chip settles, a chat reopens), and wrapped text would either be wiped or trip
   the renderer up. Ranges ask nothing of the DOM; when it changes we look again.

   Matching ignores case and diacritics (`foldText`, shared with the palette), so
   "sazetak" finds "Sažetak". */

/* ------------------------------ the matching ------------------------------ */

/* Fold `text` one character at a time, remembering for each folded letter the
 * index in `text` of the character it came from (plus one sentinel at the end),
 * so a match in the folded text maps back onto the original. */
function findFold(text) {
  let folded = '';
  const from = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const f = cp < 128 ? ch.toLowerCase() : foldText(ch);   // ASCII needs no NFD
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
    i += ch.length;
  }
  from.push(text.length);
  return { folded, from };
}

/* Where `query` occurs in `text`: [start, end) index pairs into `text`, in order
 * and not overlapping. A blank query matches nothing. */
function findMatches(text, query) {
  const q = foldText(query || '');
  if (!q.trim()) return [];
  const { folded, from } = findFold(text);
  const out = [];
  for (let i = folded.indexOf(q); i !== -1; i = folded.indexOf(q, i + q.length)) {
    // A character can fold to several letters; a match ending inside one still
    // covers the whole character.
    let j = i + q.length;
    while (j < folded.length && from[j] === from[j - 1]) j++;
    out.push([from[i], from[j]]);
  }
  return out;
}

/* Join the transcript's text pieces ({ text, block }) into one string to search.
 * Pieces inside the same block run together, so "**bo**ld" still matches "bold";
 * a new block starts after a line break, so the end of one message and the
 * start of the next never make a match. `starts[i]` is where piece i begins. */
function findJoin(pieces) {
  let text = '';
  const starts = [];
  pieces.forEach((p, i) => {
    if (i && p.block !== pieces[i - 1].block) text += '\n';
    starts.push(text.length);
    text += p.text;
  });
  return { text, starts };
}

/* Which piece holds index `at` of the joined text, and where in it. An index on
 * a boundary belongs to the piece that starts there, except at the very end. */
function findLocate(starts, lengths, at) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid; else hi = mid - 1;
  }
  return { piece: lo, offset: Math.min(at - starts[lo], lengths[lo]) };
}

/* The hit to start on: the first one at or below `viewTop`, else the last (all
 * of them are above). `tops` are the hits' tops, in document order. */
function findFirstFrom(tops, viewTop) {
  const i = tops.findIndex((t) => t >= viewTop);
  return i === -1 ? tops.length - 1 : i;
}

/* ----------------------------- the transcript ----------------------------- */

// Text that reads as the conversation. Buttons, icons and the copy affordances
// aren't; the chip's clock and caret change under you.
const FIND_SKIP = 'button, svg, textarea, input, .code-copy, .empty-state, .chip-time, .chip-caret, ' +
  '.find-flash, [aria-hidden="true"]';
const FIND_BLOCKS = 'p, li, pre, h1, h2, h3, h4, h5, h6, td, th, blockquote, .chip-row, .msg';

/* Every visible text node of the transcript, as pieces for `findJoin`. */
function findPieces() {
  const seen = new Map();   // element → visible?, so each parent is asked once
  const visible = (el) => {
    if (!seen.has(el)) {
      seen.set(el, !el.closest(FIND_SKIP) &&
        (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0));
    }
    return seen.get(el);
  };
  const pieces = [];
  const walker = document.createTreeWalker(els.feed, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.data || !el || !visible(el)) continue;
    pieces.push({ node: n, text: n.data, block: el.closest(FIND_BLOCKS) });
  }
  return pieces;
}

/* ---------------------------------- state --------------------------------- */

const findUI = {
  bar: null, input: null, count: null, prev: null, next: null,
  open: false,
  chat: null,          // the chat it was opened on; another one closes it
  ranges: [],          // one Range per match, in order
  current: -1,
  returnFocus: null,   // where focus was before Ctrl+F
  observer: null,
  pending: 0,          // a re-search waiting on the throttle
};
const FIND_RESEARCH_MS = 300;   // at most this often while the transcript changes
const findHL = !!(window.CSS && CSS.highlights && window.Highlight);

function buildFindBar() {
  const bar = document.createElement('div');
  bar.className = 'find-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'search');
  bar.innerHTML =
    icon('search') +
    '<input class="find-q" type="text" spellcheck="false" autocomplete="off">' +
    '<span class="find-count" aria-live="polite"></span>' +
    `<button type="button" class="find-btn find-prev">${icon('chevronUp')}</button>` +
    `<button type="button" class="find-btn find-next">${icon('chevronDown')}</button>` +
    `<button type="button" class="find-btn find-x">${icon('close')}</button>`;
  els.feed.parentElement.appendChild(bar);
  findUI.bar = bar;
  findUI.input = bar.querySelector('.find-q');
  findUI.count = bar.querySelector('.find-count');
  findUI.prev = bar.querySelector('.find-prev');
  findUI.next = bar.querySelector('.find-next');

  // The buttons keep focus in the box, so Enter keeps working after a click.
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  findUI.prev.onclick = () => stepFind(-1);
  findUI.next.onclick = () => stepFind(1);
  bar.querySelector('.find-x').onclick = () => closeFind();
  findUI.input.addEventListener('input', () => runFind(true));
  findUI.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  paintFindBar();
}

function paintFindBar() {
  if (!findUI.bar) return;
  findUI.bar.setAttribute('aria-label', tr('find.placeholder'));
  findUI.input.placeholder = tr('find.placeholder');
  findUI.prev.title = tr('find.prev');
  findUI.next.title = tr('find.next');
  findUI.bar.querySelector('.find-x').title = tr('find.close');
  paintFindCount();
}

function paintFindCount() {
  const n = findUI.ranges.length;
  const q = findUI.input.value.trim();
  findUI.count.textContent = !q ? '' : n ? tr('find.count', { n: findUI.current + 1, total: n }) : tr('find.none');
  findUI.bar.classList.toggle('none', !!q && !n);
  findUI.prev.disabled = findUI.next.disabled = !n;
}

/* ------------------------------ open / close ------------------------------ */

function openFind() {
  if (!state.activeId || !els.projectScreen.hidden) return;
  if (!findUI.bar) buildFindBar();
  if (findUI.open) { findUI.input.focus(); findUI.input.select(); return; }
  findUI.open = true;
  findUI.chat = state.activeId;
  findUI.returnFocus = document.activeElement;
  // Just under the header, whatever height it has today.
  findUI.bar.style.top = (els.feed.offsetTop + 10) + 'px';
  findUI.bar.classList.remove('out');
  findUI.bar.hidden = false;
  replayClass(findUI.bar, 'in');
  findUI.input.focus();
  findUI.input.select();
  if (!findUI.observer) findUI.observer = new MutationObserver(onFeedChanged);
  findUI.observer.observe(els.feed, { childList: true, subtree: true, characterData: true });
  if (findUI.input.value.trim()) runFind(true);
}

function closeFind() {
  if (!findUI.open) return;
  findUI.open = false;
  findUI.observer.disconnect();
  clearTimeout(findUI.pending);
  findUI.pending = 0;
  findUI.ranges = [];
  findUI.current = -1;
  paintFindHits();
  const bar = findUI.bar;
  bar.classList.add('out');
  setTimeout(() => { if (!findUI.open) { bar.hidden = true; bar.classList.remove('out'); } }, motionOK() ? 140 : 0);
  const back = findUI.returnFocus;
  findUI.returnFocus = null;
  if (back && back.isConnected && back !== document.body) back.focus();
}

/* ------------------------------ search / step ----------------------------- */

/* Search the transcript for what's in the box. `fresh` (the query changed): go to
 * the first match from the top of what's on screen. Otherwise (the transcript
 * changed) stay on the same match, so a streaming reply doesn't yank you around. */
function runFind(fresh) {
  if (!findUI.open) return;
  if (state.activeId !== findUI.chat || !els.projectScreen.hidden) { closeFind(); return; }
  const query = findUI.input.value;
  const pieces = query.trim() ? findPieces() : [];
  const { text, starts } = findJoin(pieces);
  const lengths = pieces.map((p) => p.text.length);
  findUI.ranges = findMatches(text, query).map(([a, b]) => {
    const s = findLocate(starts, lengths, a);
    const e = findLocate(starts, lengths, b);
    const r = document.createRange();
    r.setStart(pieces[s.piece].node, s.offset);
    r.setEnd(pieces[e.piece].node, e.offset);
    return r;
  });
  const n = findUI.ranges.length;
  if (!n) findUI.current = -1;
  else if (fresh) {
    const top = els.feed.getBoundingClientRect().top;
    findUI.current = findFirstFrom(findUI.ranges.map((r) => r.getBoundingClientRect().top), top);
  } else findUI.current = Math.min(Math.max(findUI.current, 0), n - 1);
  paintFindHits();
  paintFindCount();
  if (fresh && n) revealFindHit();
}

function stepFind(dir) {
  if (!findUI.open) return;
  if (state.activeId !== findUI.chat) { closeFind(); return; }
  if (findUI.pending) { clearTimeout(findUI.pending); findUI.pending = 0; runFind(false); }
  const n = findUI.ranges.length;
  if (!n) return;
  findUI.current = (findUI.current + dir + n) % n;   // wraps, like every find bar
  paintFindHits();
  paintFindCount();
  revealFindHit();
}

/* The transcript changed: look again, at most every FIND_RESEARCH_MS — a reply
 * streams dozens of changes a second. Our own landing light doesn't count. */
function onFeedChanged(records) {
  const ours = (n) => n.nodeType === 1 && n.classList.contains('find-flash');
  if (records.every((r) => r.type === 'childList' &&
      [...r.addedNodes, ...r.removedNodes].every(ours))) return;
  if (findUI.pending) return;
  findUI.pending = setTimeout(() => { findUI.pending = 0; runFind(false); }, FIND_RESEARCH_MS);
}

/* ------------------------------- painting -------------------------------- */

function paintFindHits() {
  if (!findHL) return;
  const cur = findUI.ranges[findUI.current];
  CSS.highlights.set('find-hit', new Highlight(...findUI.ranges.filter((r) => r !== cur)));
  const now = new Highlight(...(cur ? [cur] : []));
  now.priority = 1;
  CSS.highlights.set('find-now', now);
}

/* Bring the current match into the comfortable middle of the transcript (left
 * alone if it's already there), and let it land with one soft light. */
function revealFindHit() {
  const range = findUI.ranges[findUI.current];
  if (!range) return;
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const f = els.feed.getBoundingClientRect();
  // The composer dock floats over the bottom of the feed.
  const bottom = Math.min(f.bottom, els.composer.getBoundingClientRect().top);
  const top = f.top + (findUI.bar.offsetHeight || 0) + 20;
  let shift = 0;
  if (r.top < top || r.bottom > bottom - 20) {
    shift = r.top - (top + (bottom - top) * 0.3);
    unfollowFeed();   // feed.js: a streaming reply must not pull the feed back down
    els.feed.scrollTo({ top: Math.max(0, els.feed.scrollTop + shift), behavior: motionOK() ? 'smooth' : 'auto' });
  }
  findFlash(r, f);
}

/* One edgeless light behind the match, placed in the feed's own coordinates so
 * it rides along with the scroll. It answers the jump and is gone in under a
 * second; under reduced motion the brighter highlight says it alone. */
function findFlash(r, f) {
  if (!motionOK()) return;
  const el = document.createElement('i');
  el.className = 'find-flash';
  el.setAttribute('aria-hidden', 'true');
  const padX = 26, padY = 16;
  el.style.left = (r.left - f.left + els.feed.scrollLeft - padX) + 'px';
  el.style.top = (r.top - f.top + els.feed.scrollTop - padY) + 'px';
  el.style.width = (r.width + padX * 2) + 'px';
  el.style.height = (r.height + padY * 2) + 'px';
  el.addEventListener('animationend', () => el.remove());
  els.feed.appendChild(el);
}

/* ------------------------------- wiring ----------------------------------- */

// F3 / Shift+F3 step too, as they do in every Windows find bar.
document.addEventListener('keydown', (e) => {
  if (!findUI.open || e.key !== 'F3') return;
  e.preventDefault();
  stepFind(e.shiftKey ? -1 : 1);
});
document.addEventListener('i18n:changed', () => {
  paintFindBar();
  if (findUI.open) paintFindCount();
});
