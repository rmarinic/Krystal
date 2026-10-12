/* Tests for the Changes panel's bookkeeping (src/app/review.js): which files a
 * turn changed, the line diff shown for each, and the message a review becomes.
 *
 * Same approach as the other frontend tests — the file is a classic script that
 * shares one global scope, so it is loaded into a vm context holding just the
 * globals it expects, with a DOM stub thin enough to keep the panel closed.
 *
 * Run: node tests/review.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function stubEl() {
  return {
    hidden: true, textContent: '', innerHTML: '', title: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, append() {}, remove() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}

function loadReview() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'review.js'), 'utf8');
  const els = new Proxy({}, { get: (store, key) => (key in store ? store[key] : (store[key] = stubEl())) });
  const ctx = {
    els,
    state: { activeId: 't1', live: new Map() },
    document: { addEventListener() {}, createElement: () => stubEl() },
    tr: (k) => k,
    escapeHtml: (s) => String(s),
    basename: (p) => String(p).split(/[\\/]/).pop(),
    openOverlay() {}, closeOverlay() {}, showTip() {},
    api: {},
    Map, Set, Uint16Array, Math, String, Array, console,
  };
  const exported = ['lineDiff', 'turnChanges', 'reviewTotals', 'reviewMessage', 'liveTurnSegments'];
  return vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'review.js' });
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const shape = (rows) => rows.map((r) => r.t + r.s).join('|');

console.log('line diff');

check('unchanged lines stay as context around the one that changed', () => {
  const R = loadReview();
  eq(shape(R.lineDiff('a\nb\nc', 'a\nB\nc')), ' a|-b|+B| c');
});

check('a new file is all additions, a cleared one all removals', () => {
  const R = loadReview();
  eq(shape(R.lineDiff('', 'x\ny')), '+x|+y');
  eq(shape(R.lineDiff('x\ny', '')), '-x|-y');
});

check('an inserted line does not drag its neighbours into the diff', () => {
  const R = loadReview();
  eq(shape(R.lineDiff('one\nthree', 'one\ntwo\nthree')), ' one|+two| three');
});

console.log('what a turn changed');

check('edits to one file are gathered under it, in the order they happened', () => {
  const R = loadReview();
  const files = R.turnChanges([
    { type: 'text', text: 'On it.' },
    { type: 'tool', name: 'Edit', id: 'a', detail: 'C:/p/src/app.js', edits: [{ old: 'x = 1', new: 'x = 2' }] },
    { type: 'tool', name: 'Read', id: 'r', detail: 'C:/p/readme.md' },
    { type: 'tool', name: 'Write', id: 'b', detail: 'C:/p/notes.md', content: 'hello\nthere' },
    { type: 'tool', name: 'Edit', id: 'c', detail: 'C:/p/src/app.js', edits: [{ old: 'y', new: 'y\nz' }] },
  ]);
  eq(files.length, 2, 'files');
  eq(files[0].name, 'app.js', 'first file');
  eq(files[0].hunks.length, 2, 'both edits kept');
  eq(files[0].added, 2, 'added');      // "x = 2" and "z"
  eq(files[0].removed, 1, 'removed');  // "x = 1"
  eq(files[1].created, true, 'a written file reads as new');
  eq(files[1].added, 2, 'written lines');
  const t = R.reviewTotals(files);
  eq(t.added, 4, 'total added');
  eq(t.removed, 1, 'total removed');
});

check('a reply that only read and ran things changed nothing', () => {
  const R = loadReview();
  eq(R.turnChanges([
    { type: 'tool', name: 'Read', id: 'r', detail: 'a.js' },
    { type: 'tool', name: 'Bash', id: 's', detail: 'npm test', content: 'not a file' },
  ]).length, 0);
});

check('a live turn reports a tool twice — it is still one edit', () => {
  const R = loadReview();
  const live = { events: [
    { type: 'token', text: 'hi' },
    { type: 'tool', name: 'Edit', id: 'a' },                                           // started
    { type: 'tool', name: 'Edit', id: 'a', detail: 'a.js', edits: [{ old: '1', new: '2' }] },  // complete
  ] };
  const files = R.turnChanges(R.liveTurnSegments(live));
  eq(files.length, 1, 'files');
  eq(files[0].hunks.length, 1, 'hunks');
});

console.log('sending a review');

check('comments are grouped by file and quote the line they are about', () => {
  const R = loadReview();
  const text = R.reviewMessage([
    { path: 'src/a.js', line: '  const x = 2;', sign: '+', text: 'Name this better.' },
    { path: 'src/b.js', line: 'old()', sign: '-', text: 'Why was this removed?' },
    { path: 'src/a.js', line: 'return x', sign: ' ', text: 'Two\nlines.' },
  ]);
  const lines = text.split('\n');
  eq(lines[0], 'review.msgHead', 'heading');
  eq(lines.filter((l) => l === 'src/a.js').length, 1, 'file named once');
  eq(text.includes('- review.msgLine `const x = 2;`'), true, 'line quoted, trimmed');
  eq(text.includes('- review.msgRemoved `old()`'), true, 'removed line says so');
  eq(text.includes('  Two\n  lines.'), true, 'a multi-line comment stays indented');
  eq(text.indexOf('return x') < text.indexOf('src/b.js'), true, 'a.js comments stay together');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
