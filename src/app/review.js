/* review.js     — Changes panel: what a reply changed, comments on it, and undo
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ turn changes ----------------------------- */
/* A reply that edits files leaves a strip under it — "Changed files: 3 +12 −4" —
 * that opens this panel: every file the reply touched, as a diff. Two things can
 * be done from there that a row of action chips can't offer:
 *
 *   • comment on a line. Comments collect in the panel and go to Claude as one
 *     message, so a review reads as a review rather than five separate nags.
 *   • undo the changes. The CLI keeps a copy of each file it edits, filed under
 *     the message that asked (`rewind_files` in commands.rs), so the project can
 *     be put back to how it was before that message — later replies' edits
 *     included. The conversation is left alone; Claude is told on the next turn.
 *
 * The diffs are built from the turn's own Edit/Write segments, so they show what
 * Claude's file tools did. A file a shell command rewrote isn't in them, and
 * isn't something undo can restore either — the two agree with each other. */

const REVIEW_WRITE_TOOLS = new Set(['Write', 'NotebookEdit']);
const REVIEW_DIFF_CELLS = 250000;   // above this, skip the line-matching (see lineDiff)

/* Line-by-line diff of two texts → [{ t: ' ' | '-' | '+', s }]. A plain LCS: the
 * inputs are single edits (capped by the backend), not whole files. */
function lineDiff(oldText, newText) {
  const a = oldText ? String(oldText).split('\n') : [];
  const b = newText ? String(newText).split('\n') : [];
  const n = a.length, m = b.length;
  if (n * m > REVIEW_DIFF_CELLS) {
    return a.map((s) => ({ t: '-', s })).concat(b.map((s) => ({ t: '+', s })));
  }
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ t: '-', s: a[i++] });
    else out.push({ t: '+', s: b[j++] });
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

/* The files a turn changed, from its tool segments (saved ones, or a live turn's
 * tool events — the same shape). One entry per file, in the order first touched:
 * { path, name, created, hunks: [[{t,s}…]…], added, removed }. */
function turnChanges(segs) {
  // A live turn reports each tool twice (started, then complete): last one wins.
  const byId = new Map();
  let anon = 0;
  for (const s of (segs || [])) {
    if (!s || s.type !== 'tool') continue;
    const edits = Array.isArray(s.edits) && s.edits.length;
    const wrote = s.content != null && REVIEW_WRITE_TOOLS.has(s.name);
    if (!edits && !wrote) continue;
    byId.set(s.id || ('_' + anon++), s);
  }
  const files = new Map();
  for (const s of byId.values()) {
    const path = s.detail || s.target || '';
    if (!path) continue;
    let f = files.get(path);
    if (!f) {
      f = { path, name: basename(path), created: false, hunks: [], added: 0, removed: 0 };
      files.set(path, f);
    }
    const hunks = Array.isArray(s.edits) && s.edits.length
      ? s.edits.map((e) => lineDiff(e.old, e.new))
      : [lineDiff('', s.content)];
    if (!(Array.isArray(s.edits) && s.edits.length) && !f.hunks.length) f.created = true;
    for (const h of hunks) {
      f.hunks.push(h);
      for (const row of h) {
        if (row.t === '+') f.added++;
        else if (row.t === '-') f.removed++;
      }
    }
  }
  return [...files.values()];
}

function reviewTotals(files) {
  let added = 0, removed = 0;
  for (const f of files) { added += f.added; removed += f.removed; }
  return { added, removed };
}

function reviewStatsHtml(added, removed) {
  return `<span class="rv-add">+${added}</span><span class="rv-del">−${removed}</span>`;
}

/* Hang the "changed files" strip under an assistant message. `ckpt` is the id
 * the turn's user message was sent under — what undo is keyed by; without one
 * (a turn from before checkpoints) the panel still opens, it just can't undo. */
function attachTurnChanges(msgEl, segs, ckpt, threadId) {
  if (!msgEl) return;
  const old = msgEl.querySelector(':scope > .turn-changes');
  if (old) old.remove();
  const files = turnChanges(segs);
  if (!files.length) return;
  const { added, removed } = reviewTotals(files);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'turn-changes';
  btn.title = tr('review.openTitle');
  btn.innerHTML =
    '<span class="tc-ico" aria-hidden="true">📝</span>' +
    `<span class="tc-label">${escapeHtml(tr('review.strip', { n: files.length }))}</span>` +
    `<span class="tc-stats">${reviewStatsHtml(added, removed)}</span>` +
    '<span class="tc-open" aria-hidden="true">⤢</span>';
  btn.onclick = () => openReview({ msgEl, files, ckpt: ckpt || '', threadId: threadId || state.activeId });
  msgEl.appendChild(btn);
}

/* The tool events of a live turn, for the strip a just-finished reply gets. */
function liveTurnSegments(live) {
  const out = [];
  for (const ev of (live.events || [])) if (ev && ev.type === 'tool') out.push(ev);
  return out;
}

/* -------------------------------- the panel ------------------------------ */

let review = null;          // { msgEl, files, ckpt, threadId, comments, rewind }

function openReview(opts) {
  // Comments live on the message while the app is open, so closing the panel to
  // go and look at something doesn't throw a half-written review away.
  const comments = opts.msgEl._reviewComments || (opts.msgEl._reviewComments = []);
  review = { ...opts, comments, rewind: null };
  renderReview();
  openOverlay(els.reviewOverlay);
  els.reviewBody.scrollTop = 0;
}

function closeReview() {
  review = null;
  closeOverlay(els.reviewOverlay);
}

function renderReview() {
  if (!review) return;
  const { added, removed } = reviewTotals(review.files);
  els.reviewSub.innerHTML =
    `<span>${escapeHtml(tr('review.strip', { n: review.files.length }))}</span>` + reviewStatsHtml(added, removed);
  const body = els.reviewBody;
  body.innerHTML = '';
  review.files.forEach((f, fi) => body.appendChild(reviewFile(f, fi)));
  syncReviewFoot();
}

function reviewFile(f, fi) {
  const box = document.createElement('section');
  box.className = 'rv-file';
  const head = document.createElement('header');
  head.className = 'rv-file-head';
  head.title = f.path;
  head.innerHTML =
    `<span class="rv-name">${escapeHtml(f.name)}</span>` +
    (f.created ? `<span class="rv-new">${escapeHtml(tr('review.newFile'))}</span>` : '') +
    `<span class="rv-path">${escapeHtml(f.path)}</span>` +
    `<span class="rv-file-stats">${reviewStatsHtml(f.added, f.removed)}</span>`;
  box.appendChild(head);

  f.hunks.forEach((hunk, hi) => {
    const block = document.createElement('div');
    block.className = 'rv-hunk';
    hunk.forEach((row, ri) => block.appendChild(reviewLine(f, fi, hi, ri, row)));
    box.appendChild(block);
  });
  return box;
}

function reviewKey(fi, hi, ri) { return fi + ':' + hi + ':' + ri; }

/* One diff line. Clicking it opens a comment box right under it. */
function reviewLine(f, fi, hi, ri, row) {
  const wrap = document.createElement('div');
  wrap.className = 'rv-row';
  const key = reviewKey(fi, hi, ri);
  wrap.dataset.key = key;

  const line = document.createElement('button');
  line.type = 'button';
  line.className = 'rv-line' + (row.t === '+' ? ' add' : row.t === '-' ? ' del' : '');
  line.title = tr('review.lineTitle');
  const sign = document.createElement('span');
  sign.className = 'rv-sign';
  sign.textContent = row.t === ' ' ? '' : row.t === '-' ? '−' : '+';
  const text = document.createElement('span');
  text.className = 'rv-text';
  text.textContent = row.s || ' ';
  line.append(sign, text);
  line.onclick = () => editReviewComment(wrap, f, key, row);
  wrap.appendChild(line);

  const existing = review.comments.find((c) => c.key === key);
  if (existing) wrap.appendChild(reviewNote(wrap, existing));
  return wrap;
}

/* A saved comment, shown under its line. */
function reviewNote(wrap, c) {
  const note = document.createElement('div');
  note.className = 'rv-note';
  const text = document.createElement('span');
  text.className = 'rv-note-text';
  text.textContent = c.text;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'rv-note-x';
  x.title = tr('review.remove');
  x.setAttribute('aria-label', tr('review.remove'));
  x.textContent = '×';
  x.onclick = () => {
    review.comments.splice(review.comments.indexOf(c), 1);
    note.remove();
    syncReviewFoot();
  };
  note.append(text, x);
  return note;
}

/* Open (or re-open) the comment box under a line. */
function editReviewComment(wrap, f, key, row) {
  if (wrap.querySelector('.rv-edit')) { wrap.querySelector('textarea').focus(); return; }
  const existing = review.comments.find((c) => c.key === key);
  const oldNote = wrap.querySelector('.rv-note');
  if (oldNote) oldNote.remove();

  const box = document.createElement('div');
  box.className = 'rv-edit';
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = tr('review.commentPh');
  ta.value = existing ? existing.text : '';
  const acts = document.createElement('div');
  acts.className = 'rv-edit-acts';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'init-act ghost';
  cancel.textContent = tr('review.cancel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'init-act primary';
  save.textContent = tr('review.add');
  acts.append(cancel, save);
  box.append(ta, acts);
  wrap.appendChild(box);
  ta.focus();

  const done = () => {
    box.remove();
    const c = review && review.comments.find((x) => x.key === key);
    if (c) wrap.appendChild(reviewNote(wrap, c));
    syncReviewFoot();
  };
  cancel.onclick = done;
  save.onclick = () => {
    const text = ta.value.trim();
    const at = review.comments.findIndex((c) => c.key === key);
    if (at >= 0) review.comments.splice(at, 1);
    if (text) review.comments.push({ key, path: f.path, line: row.s, sign: row.t, text });
    done();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.onclick(); }
    else if (e.key === 'Escape') { e.stopPropagation(); done(); }
  });
}

/* The message a review becomes: grouped by file, each comment quoting its line —
 * the line text is what lets Claude find the spot, since an edit carries no line
 * numbers of its own. */
function reviewMessage(comments) {
  const byFile = new Map();
  for (const c of comments) {
    if (!byFile.has(c.path)) byFile.set(c.path, []);
    byFile.get(c.path).push(c);
  }
  const parts = [tr('review.msgHead')];
  for (const [path, list] of byFile) {
    parts.push('');
    parts.push(path);
    for (const c of list) {
      const what = c.sign === '-' ? tr('review.msgRemoved') : tr('review.msgLine');
      parts.push(`- ${what} \`${String(c.line).trim()}\``);
      parts.push('  ' + c.text.replace(/\n/g, '\n  '));
    }
  }
  return parts.join('\n');
}

function sendReview() {
  if (!review || !review.comments.length) return;
  const threadId = review.threadId;
  const msg = { text: reviewMessage(review.comments), files: [], refs: [] };
  review.comments.length = 0;         // sent — the message itself is the record now
  closeReview();
  if (state.live.has(threadId) && typeof enqueueMessage === 'function') enqueueMessage(threadId, msg);
  else startTurn(threadId, msg, { follow: true });
}

/* ---------------------------------- undo --------------------------------- */
/* Two steps on purpose. The first asks the CLI what undoing would touch and
 * changes nothing; only the second does it. `review.rewind` holds where we are:
 * null → 'checking' → { files } (waiting for the yes) → 'working'. */

function syncReviewFoot() {
  if (!review) return;
  const n = review.comments.length;
  els.reviewSend.disabled = n === 0;
  els.reviewSend.textContent = tr('review.send', { n });

  const rw = review.rewind;
  const asking = rw && typeof rw === 'object';
  els.reviewUndo.hidden = !review.ckpt || asking;
  els.reviewUndo.disabled = rw === 'checking' || rw === 'working';
  els.reviewUndo.textContent = rw === 'checking' ? tr('review.undoChecking') : tr('review.undo');
  els.reviewUndoGo.hidden = !asking;
  els.reviewUndoGo.disabled = false;
  els.reviewUndoGo.textContent = tr('review.undoGo');
  els.reviewUndoCancel.hidden = !asking;
  els.reviewHint.textContent = asking
    ? tr('review.undoConfirm', { n: rw.files.length })
    : (review.hint || tr('review.hint'));
  els.reviewHint.classList.toggle('warn', !!asking || !!review.hintWarn);
}

function reviewHint(text, warn) {
  if (!review) return;
  review.hint = text;
  review.hintWarn = !!warn;
  review.rewind = null;
  syncReviewFoot();
}

async function askUndo() {
  if (!review || !review.ckpt) return;
  const mine = review;
  if (state.live.has(mine.threadId)) return reviewHint(tr('review.undoBusy'), true);
  mine.rewind = 'checking';
  syncReviewFoot();
  try {
    const r = await api.rewindFiles(mine.threadId, mine.ckpt, true);
    if (review !== mine) return;                         // closed while we asked
    if (!r || !r.canRewind) return reviewHint(tr('review.undoGone'), true);
    const files = Array.isArray(r.files) ? r.files : [];
    if (!files.length) return reviewHint(tr('review.undoNothing'), false);
    mine.rewind = { files };
    syncReviewFoot();
  } catch (e) {
    if (review !== mine) return;
    const busy = String((e && e.message) || e) === 'busy';
    reviewHint(busy ? tr('review.undoBusy') : tr('review.undoFail', { why: String((e && e.message) || e) }), true);
  }
}

async function doUndo() {
  if (!review || !review.rewind || typeof review.rewind !== 'object') return;
  const mine = review;
  const count = mine.rewind.files.length;
  mine.rewind = 'working';
  els.reviewUndoGo.disabled = true;
  try {
    const r = await api.rewindFiles(mine.threadId, mine.ckpt, false);
    if (!r || !r.canRewind) {
      if (review === mine) reviewHint(tr('review.undoGone'), true);
      return;
    }
    if (review === mine) closeReview();
    showTip({ key: 'status', icon: '↩️', label: tr('review.undoneLabel'), body: tr('review.undoneBody', { n: count }) });
    if (typeof refreshGit === 'function') refreshGit();
  } catch (e) {
    if (review === mine) reviewHint(tr('review.undoFail', { why: String((e && e.message) || e) }), true);
  }
}

els.reviewClose.onclick = closeReview;
els.reviewDone.onclick = closeReview;
els.reviewSend.onclick = sendReview;
els.reviewUndo.onclick = askUndo;
els.reviewUndoGo.onclick = doUndo;
els.reviewUndoCancel.onclick = () => { if (review) { review.rewind = null; syncReviewFoot(); } };

// Backdrop click closes — unless the release just ended a text drag-select
// (same guard as the agent inspector).
let reviewPressOnBackdrop = false;
els.reviewOverlay.addEventListener('mousedown', (e) => { reviewPressOnBackdrop = (e.target === els.reviewOverlay); });
els.reviewOverlay.addEventListener('mouseup', (e) => {
  if (reviewPressOnBackdrop && e.target === els.reviewOverlay) closeReview();
  reviewPressOnBackdrop = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.reviewOverlay.hidden) closeReview();
});
