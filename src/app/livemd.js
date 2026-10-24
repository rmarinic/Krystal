/* livemd.js     — markdown that formats itself while the reply is still arriving
   Part of the chat frontend; shares one global scope (see core.js). */
/* ---------------------------- live markdown ------------------------------ */
/* A reply used to stream as plain text — `**`, `##` and backticks on show — and
 * only became formatted once the whole block had arrived. Now it is formatted as
 * it is written, in two parts:
 *
 *   • finished blocks — a paragraph followed by a blank line, a heading line, a
 *     closed code fence — are rendered once, frozen, and never touched again (a
 *     code block is highlighted the moment it closes);
 *   • the block still being written (the "tail") is re-rendered each frame. It
 *     is one paragraph or list, so that stays cheap. Before rendering it is
 *     healed (`mdHeal`): an unclosed `**`, backtick or fence is closed, and a
 *     marker typed halfway is held back, so half-written syntax never flashes on
 *     screen as stray symbols.
 *
 * Blocks go straight into the text element, as the final render puts them,
 * so spacing rules (`.seg-text :first-child` …) apply the same throughout and
 * nothing jumps when the reply lands and is rendered whole.
 *
 * The ink fade survives the re-rendering: newly revealed characters are wrapped
 * in `.tw` spans with a negative animation-delay, so a fade cut short by the
 * next frame's render carries on exactly where it was rather than restarting. */

const LIVE_MD_FADE_MS = 320;          // matches `.tw` in motion.css

/* Where the finished blocks end: the source up to the returned index can be
 * rendered and frozen. Only lines that have ended (a `\n` arrived) count, and
 * nothing inside an open code fence is ever finished. */
function mdSplit(text) {
  let cut = 0, pos = 0, fence = null;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {        // the last piece hasn't ended
    const line = lines[i];
    const end = pos + line.length + 1;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // A closing fence: same character, at least as long, nothing after it.
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
        cut = end;
      }
    } else if (open) {
      fence = open[1];
      if (!/^\s/.test(line)) cut = pos;               // the text before it was complete
    } else if (!line.trim() || /^#{1,6}\s/.test(line)) {
      cut = end;                                      // a blank line, or a heading line
    }
    pos = end;
  }
  return cut;
}

// The fence a block is still inside at its end, or null.
function mdOpenFence(text) {
  let fence = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (!fence) fence = m[1];
    else if (m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
  }
  return fence;
}

/* Make a half-written block render as what it is going to be. */
function mdHeal(tail) {
  let t = String(tail || '');
  const fence = mdOpenFence(t);
  if (fence) return t.replace(/\n?$/, '\n') + fence;           // code so far, as code
  t = t.replace(/[*_`~]+$/, '');                                // a marker typed halfway
  t = t.replace(/(^|\n) {0,3}#{1,6}$/, '$1');                   // `##` with no heading yet
  t = t.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1');              // [text](half-a-url → text
  t = t.replace(/\[([^\]\n]*)$/, '$1');                         // [half-the-text → its text
  const bare = t.replace(/`[^`\n]*`/g, '');                     // what is not inline code
  let close = '';
  if ((bare.match(/`/g) || []).length % 2) close = '`';
  else {
    // A lone `*` for italics — not a list bullet, not half of a `**`.
    const singles = bare.replace(/\*\*/g, '').replace(/^\s*\*\s/gm, '').match(/\*/g) || [];
    if (singles.length % 2) close += '*';
    if ((bare.match(/\*\*/g) || []).length % 2) close += '**';
  }
  // A closer only closes right after a word (`**word **` stays literal), and
  // the space it would follow isn't visible anyway.
  return close ? t.replace(/\s+$/, '') + close : t;
}

/* ------------------------------ the DOM side ------------------------------ */

// Text nodes that show something (a `\n` between blocks doesn't).
function mdIsInk(node) { return node.nodeType === 3 && /\S/.test(node.nodeValue); }

function mdInkLength(nodes) {
  let n = 0;
  for (const root of nodes) {
    if (root.nodeType === 3) { if (mdIsInk(root)) n += root.nodeValue.length; continue; }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (mdIsInk(w.currentNode)) n += w.currentNode.nodeValue.length;
  }
  return n;
}

// The node before `node` in document order, within `root` (deepest-last first).
function mdPrevNode(node, root) {
  if (node.previousSibling) {
    node = node.previousSibling;
    while (node.lastChild) node = node.lastChild;
    return node;
  }
  const up = node.parentNode;
  return up && up !== root ? up : null;
}
function mdLastNode(root) {
  let node = root;
  while (node.lastChild) node = node.lastChild;
  return node === root ? null : node;
}

/* Wrap `n` characters of ink in a fading span, counting back from the end of
 * `root` after skipping the newest `skip` characters. Text already fading (a
 * frozen block wrapped on an earlier frame) is counted but left as it is. */
function mdFadeFromEnd(root, skip, n, delayMs, skipNode) {
  for (let node = mdLastNode(root); node && n > 0; node = mdPrevNode(node, root)) {
    if (node === skipNode || !mdIsInk(node)) continue;
    let len = node.nodeValue.length;
    if (skip >= len) { skip -= len; continue; }
    let end = len - skip;                       // wrap [start, end) of this node
    skip = 0;
    const start = Math.max(0, end - n);
    n -= end - start;
    const p = node.parentNode;
    if (p && p.classList && p.classList.contains('tw')) continue;
    if (end < len) node.splitText(end);
    const piece = start > 0 ? node.splitText(start) : node;
    const span = document.createElement('span');
    span.className = 'tw';
    span.style.animationDelay = `-${Math.round(delayMs)}ms`;
    piece.parentNode.insertBefore(span, piece);
    span.appendChild(piece);
    node = span;                                // carry on from before the wrapped piece
    while (node.firstChild) node = node.firstChild;
  }
}

/* One streaming text block. `update(source, animate)` brings the element up to
 * date with everything revealed so far. */
function makeLiveMarkdown(el, caret) {
  let doneLen = 0;            // how much of the source is frozen as finished blocks
  let doneInk = 0;            // …and how much ink those blocks show
  let tailNodes = [];         // what the tail rendered to last frame
  let shownInk = 0;
  let reveals = [];           // { n, at }: ink revealed recently, oldest first

  function fragment(md) {
    const tpl = document.createElement('template');
    tpl.innerHTML = renderMarkdown(md);
    return tpl.content;
  }

  return {
    update(source, animate) {
      caret.remove();
      for (const n of tailNodes) n.remove();
      tailNodes = [];

      const cut = mdSplit(source);
      if (cut > doneLen) {
        const frag = fragment(source.slice(doneLen, cut));
        decorateCode(frag);                     // highlight + copy, now that it's whole
        const added = [...frag.childNodes];
        el.appendChild(frag);
        doneInk += mdInkLength(added);
        doneLen = cut;
      }
      const tail = source.slice(doneLen);
      if (tail.trim()) {
        const frag = fragment(mdHeal(tail));
        tailNodes = [...frag.childNodes];
        el.appendChild(frag);
      }

      // The caret sits right after the last thing written.
      let last = mdLastNode(el);
      while (last && !mdIsInk(last)) last = mdPrevNode(last, el);
      if (last) last.parentNode.insertBefore(caret, last.nextSibling);
      else el.appendChild(caret);

      const ink = doneInk + mdInkLength(tailNodes);
      const now = performance.now();
      if (animate && ink > shownInk) reveals.push({ n: ink - shownInk, at: now });
      shownInk = ink;
      reveals = reveals.filter((r) => now - r.at < LIVE_MD_FADE_MS);
      if (!animate || !motionOK()) return;
      let skip = 0;
      for (let i = reveals.length - 1; i >= 0; i--) {
        mdFadeFromEnd(el, skip, reveals[i].n, now - reveals[i].at, caret);
        skip += reveals[i].n;
      }
    },
  };
}
