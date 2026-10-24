/* Tests for Find in chat (src/app/find.js): how a query matches the transcript's
 * text (case- and diacritic-blind, whole characters, never across two blocks),
 * how a match maps back onto the text nodes it came from, which hit a new search
 * starts on, and that the search skips what isn't conversation and gives up when
 * the chat changes under it.
 *
 * Same approach as the other frontend tests: the files run in a vm context that
 * holds the globals they expect from their siblings — utils.js for the real
 * `foldText`, and a small fake of the DOM bits find.js walks.
 *
 * Run: node tests/find.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'app', f), 'utf8');

/* ------------------------------ a tiny fake DOM ---------------------------- */

// Enough of `closest()` for find.js's selectors: tag, .class, [aria-hidden="true"].
function matches(el, sel) {
  return sel.split(',').map((s) => s.trim()).some((s) => {
    if (s.startsWith('.')) return el.classes.includes(s.slice(1));
    if (s === '[aria-hidden="true"]') return el.ariaHidden === true;
    return el.tag === s;
  });
}
function elem(tag, classes = [], parent = null, extra = {}) {
  const el = Object.assign({ tag, classes, parent, ariaHidden: false, shown: true }, extra);
  el.closest = (sel) => { for (let e = el; e; e = e.parent) if (matches(e, sel)) return e; return null; };
  el.checkVisibility = () => { for (let e = el; e; e = e.parent) if (!e.shown) return false; return true; };
  return el;
}
const text = (data, parent) => ({ nodeType: 3, data, parentElement: parent });

function load() {
  const nodes = [];
  const ctx = {
    window: {},
    document: {
      addEventListener() {},
      createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] || null }; },
      createRange: () => ({
        setStart(node, offset) { this.start = { node, offset }; },
        setEnd(node, offset) { this.end = { node, offset }; },
        getBoundingClientRect: () => ({ top: 0, bottom: 10, width: 10, height: 10 }),
      }),
    },
    NodeFilter: { SHOW_TEXT: 4 },
    els: {
      feed: { getBoundingClientRect: () => ({ top: 0, bottom: 500 }), scrollTop: 0 },
      projectScreen: { hidden: true },
    },
    state: { activeId: 't1' },
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    motionOK: () => false,
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    console,
  };
  const F = vm.runInNewContext(
    `${read('utils.js')}\n${read('find.js')}\n;({ findMatches, findJoin, findLocate, findFirstFrom, runFind, findUI })`,
    ctx, { filename: 'find.js' });
  // Pretend the bar is open on chat t1, without building its markup.
  const cls = { toggle() {}, add() {}, remove() {} };
  Object.assign(F.findUI, {
    open: true, chat: 't1', observer: { disconnect() {} },
    input: { value: '' }, count: { textContent: '' }, prev: {}, next: {},
    bar: { classList: cls, offsetHeight: 30, querySelector: () => ({}) },
  });
  return { F, ctx, nodes };
}

/* ---------------------------------- checks --------------------------------- */

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || 'expected'}: ${A} !== ${B}`);
}

const { F } = load();

check('a match ignores case and diacritics, both ways round', () => {
  eq(F.findMatches('Sažetak sastanka', 'sazetak'), [[0, 7]]);
  eq(F.findMatches('sazetak', 'SAŽETAK'), [[0, 7]]);
  eq(F.findMatches('Đuro i đak', 'd'), [[0, 1], [7, 8]], 'đ has no decomposition — folded by hand');
});

check('every occurrence, in order, never overlapping', () => {
  eq(F.findMatches('a test, a Test, a TEST', 'test'), [[2, 6], [10, 14], [18, 22]]);
  eq(F.findMatches('aaaa', 'aa'), [[0, 2], [2, 4]]);
});

check('a blank query matches nothing', () => {
  eq(F.findMatches('some text', ''), []);
  eq(F.findMatches('some  text', '  '), []);
  eq(F.findMatches('some text', null), []);
});

check('indices are into the original text, even after a letter folds away', () => {
  // "é" written as e + combining accent is two characters that fold to one letter.
  const s = 'Café ok';
  eq(F.findMatches(s, 'ok'), [[6, 8]]);
  eq(F.findMatches(s, 'café'), [[0, 5]], 'the accent is part of the match');
});

check('a match ending inside a character that folds to several letters takes all of it', () => {
  // A Hangul syllable decomposes (NFD) into several jamo, none of them combining marks.
  eq(F.findMatches('한국', 'ᄒ'), [[0, 1]]);
});

check('text in one block runs together; a new block never joins a match', () => {
  const p = {}, q = {};
  const joined = F.findJoin([{ text: 'bo', block: p }, { text: 'ld end', block: p }, { text: 'start', block: q }]);
  eq(joined.text, 'bold end\nstart');
  eq(joined.starts, [0, 2, 9]);
  eq(F.findMatches(joined.text, 'bold').length, 1, 'across <strong> inside a paragraph');
  eq(F.findMatches(joined.text, 'endstart').length, 0, 'across two messages');
});

check('a joined index maps back to its piece and offset', () => {
  const starts = [0, 2, 9], lengths = [2, 6, 5];
  eq(F.findLocate(starts, lengths, 0), { piece: 0, offset: 0 });
  eq(F.findLocate(starts, lengths, 3), { piece: 1, offset: 1 });
  eq(F.findLocate(starts, lengths, 2), { piece: 1, offset: 0 }, 'a boundary belongs to the piece starting there');
  eq(F.findLocate(starts, lengths, 14), { piece: 2, offset: 5 }, 'the very end');
});

check('a new search starts on the first hit from the top of the screen', () => {
  eq(F.findFirstFrom([-300, -20, 40, 900], 0), 2);
  eq(F.findFirstFrom([-300, -20], 0), 1, 'all above: the nearest one, the last');
  eq(F.findFirstFrom([], 0), -1);
});

check('the search builds one range per match over the real text nodes', () => {
  const { F, nodes } = load();
  const feed = elem('div', ['feed']);
  const msg1 = elem('div', ['msg'], feed);
  const para = elem('p', [], msg1);
  const strong = elem('strong', [], para);
  const msg2 = elem('div', ['msg'], feed);
  const p2 = elem('p', [], msg2);
  nodes.push(text('Read the ', para), text('Read', strong), text('me file', para), text('readme again', p2));
  F.findUI.input.value = 'readme';
  F.runFind(false);
  const got = F.findUI.ranges.map((r) => [r.start.node.data, r.start.offset, r.end.node.data, r.end.offset]);
  eq(got, [['Read', 0, 'me file', 2], ['readme again', 0, 'readme again', 6]]);
  eq(F.findUI.current, 0);
  eq(F.findUI.count.textContent, 'find.count(1,2)');
});

check('what isn’t conversation is skipped: hidden details, buttons, the chip clock', () => {
  const { F, nodes } = load();
  const feed = elem('div', ['feed']);
  const chip = elem('div', ['action-chip'], feed);
  const row = elem('div', ['chip-row'], chip);
  const details = elem('div', ['chip-details'], chip, { shown: false });
  const btn = elem('button', [], feed);
  const time = elem('span', ['chip-time'], row);
  nodes.push(text('Run the tests', row), text('npm test', details), text('Copy test', btn), text('test 3s', time));
  F.findUI.input.value = 'test';
  F.runFind(false);
  eq(F.findUI.ranges.map((r) => r.start.node.data), ['Run the tests']);
});

check('no matches says so; an empty box says nothing', () => {
  const { F, nodes } = load();
  nodes.push(text('hello', elem('p', [], elem('div', ['msg']))));
  F.findUI.input.value = 'zebra';
  F.runFind(true);
  eq(F.findUI.ranges.length, 0);
  eq(F.findUI.count.textContent, 'find.none');
  F.findUI.input.value = '';
  F.runFind(true);
  eq(F.findUI.count.textContent, '');
});

check('another chat on screen closes the bar instead of searching it', () => {
  const { F, ctx } = load();
  ctx.state.activeId = 't2';
  F.findUI.input.value = 'x';
  F.runFind(false);
  eq(F.findUI.open, false);
});

if (failed) { console.log(`\n${failed} failing`); process.exit(1); }
console.log('\nall passing');
