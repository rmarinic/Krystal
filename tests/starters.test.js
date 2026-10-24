/* Tests for the starting points (src/app/starters.js) and the taskbar state
 * (src/app/titlebar.js): every starter exists in both languages with blanks to
 * fill, Tab's blank-walking finds them in order, and the taskbar says running /
 * waiting / failed / nothing as it should.
 *
 * Run: node tests/starters.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

console.log('starters');

const i18n = read('src', 'i18n.js');
const ids = [...read('src', 'app', 'starters.js').matchAll(/\{ id: '([a-z]+)', icon:/g)].map((m) => m[1]);

check('there are four starting points', () => ok(ids.length === 4, `found ${ids.length}`));

check('each one is named, described and has a prompt in both languages', () => {
  for (const id of ids) for (const part of ['name', 'blurb', 'prompt']) {
    const n = i18n.split(`'starter.${id}.${part}':`).length - 1;
    ok(n === 2, `starter.${id}.${part} appears ${n} times (EN + HR expected)`);
  }
});

check('every prompt has [blanks] to fill, the same number in EN and HR', () => {
  for (const id of ids) {
    const prompts = [...i18n.matchAll(new RegExp(`'starter\.${id}\.prompt': '([^']*)'`, 'g'))].map((m) => m[1]);
    const counts = prompts.map((p) => (p.match(/\[[^\[\]\n]{1,60}\]/g) || []).length);
    ok(counts[0] > 0, `${id}: no blanks`);
    ok(counts[0] === counts[1], `${id}: EN has ${counts[0]} blanks, HR ${counts[1]}`);
  }
});

check('Tab walks the blanks in order and wraps round', () => {
  const src = read('src', 'app', 'starters.js');
  const input = { value: 'Help me write [what] for [whom].', sel: null, addEventListener() {},
    setSelectionRange(a, b) { this.sel = [a, b]; } };
  const ctx = { els: { input, empty: null, feed: { querySelector: () => null } }, document: { addEventListener() {}, querySelectorAll: () => [] },
    tr: (k) => k, escapeHtml: (s) => s, icon: () => '', state: {}, console };
  const S = vm.runInNewContext(`${src}\n;({ selectStarterBlank })`, ctx);
  S.selectStarterBlank(0);
  ok(input.value.slice(...input.sel) === '[what]', 'first blank');
  S.selectStarterBlank(input.sel[1]);
  ok(input.value.slice(...input.sel) === '[whom]', 'second blank');
  S.selectStarterBlank(input.sel[1]);
  ok(input.value.slice(...input.sel) === '[what]', 'wraps to the first');
  input.value = 'nothing left';
  ok(S.selectStarterBlank(0) === false, 'no blanks → false');
});

console.log('taskbar');

function taskbar(lives, focused = true) {
  const src = read('src', 'app', 'titlebar.js');
  const calls = [];
  const win = { setProgressBar: (b) => { calls.push(b); return Promise.resolve(); }, startDragging() {} };
  const ctx = {
    window: { __TAURI__: { window: { getCurrentWindow: () => win } }, addEventListener() {} },
    document: { body: { classList: { add() {}, toggle() {}, remove() {} } }, getElementById: () => null,
      addEventListener() {}, hasFocus: () => focused },
    state: { live: new Map(lives.map((l, i) => [String(i), l])) },
    tr: (k) => k, console, setTimeout, clearTimeout,
  };
  const T = vm.runInNewContext(`${src}\n;({ taskbarSync, taskbarStatus, taskbarFailedTurn })`, ctx);
  return { T, calls, ctx };
}

check('nothing running: nothing shown', () => {
  const { T } = taskbar([]);
  ok(T.taskbarStatus() === 'none', T.taskbarStatus());
});

check('a running turn shows the moving bar; one waiting on you turns it amber', () => {
  ok(taskbar([{}]).T.taskbarStatus() === 'indeterminate', 'running');
  ok(taskbar([{}, { permissions: [{ id: 'p' }] }]).T.taskbarStatus() === 'paused', 'waiting');
});

check('the same state is only sent once', () => {
  const { T, calls } = taskbar([{}]);
  T.taskbarSync(); T.taskbarSync();
  ok(calls.length === 1 && calls[0].status === 'indeterminate', JSON.stringify(calls));
});

check('a failure shows red only if you were away', () => {
  const here = taskbar([], true);
  here.T.taskbarFailedTurn();
  ok(here.T.taskbarStatus() === 'none', 'red while you were looking');
  const away = taskbar([], false);
  away.T.taskbarFailedTurn();
  ok(away.T.taskbarStatus() === 'error', 'no red while away');
  ok(away.calls.pop().progress === 100, 'a state bar is drawn full');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('starters.test.js: ok');
