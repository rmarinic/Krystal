/* Tests for the project's check in the transcript (src/app/check.js): what each
 * outcome of a run says, and its chip (a failure reads as failed, a timeout
 * doesn't, the output is a click away).
 *
 * Run: node tests/check.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function fakeEl() {
  const el = {
    className: '', dataset: {}, children: [], hidden: false, title: '', innerHTML: '', onclick: null,
    appendChild(c) { el.children.push(c); return c; },
  };
  return el;
}

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'check.js'), 'utf8');
  const filled = [];
  const ctx = {
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    escapeHtml: (s) => String(s),
    icon: (n) => `<i ${n}>`,
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    CHIP_TICK_SVG: '<svg/>',
    fillChipDetails: (d, seg) => filled.push(seg),
    toggleChip: () => {},
    document: { createElement: () => fakeEl() },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.filled = filled;
  return ctx;
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const c = load();

test('each outcome says what happened, naming the command', () => {
  // A plain copy: objects made inside the vm sandbox have its own Object prototype.
  const t = (seg) => ({ ...c.checkChipText({ command: 'npm test', attempt: 1, ...seg }) });
  assert.deepStrictEqual(t({ ok: true }), { label: 'check.passed(npm test,1)', tone: 'ok' });
  assert.strictEqual(t({ ok: true, attempt: 2 }).label, 'check.passedAfter(npm test,2)', 'passing after a fix says so');
  assert.deepStrictEqual(t({ ok: false, retrying: true }), { label: 'check.failedFixing(npm test)', tone: 'fail' });
  assert.deepStrictEqual(t({ ok: false, gaveUp: true }), { label: 'check.gaveUp(npm test)', tone: 'fail' });
  assert.deepStrictEqual(t({ ok: false, timedOut: true }), { label: 'check.timedOut(npm test)', tone: 'warn' });
});

test('a failed check is a failed chip; a slow one is not', () => {
  const fail = c.renderCheckChip({ id: 'check-1', ok: false, retrying: true, command: 'npm test', output: '1 failing', ms: 4000 });
  assert.ok(fail.className.includes('error'));
  assert.strictEqual(fail.dataset.id, 'check-1');
  const slow = c.renderCheckChip({ ok: false, timedOut: true, command: 'npm test' });
  assert.ok(!slow.className.includes('error'), 'a timeout says nothing about the code');
  assert.ok(slow.className.includes('warn'));
  const ok = c.renderCheckChip({ ok: true, command: 'npm test', output: '12 passing', ms: 2000 });
  assert.ok(!ok.className.includes('error'));
  assert.ok(ok.children[0].innerHTML.includes('2s'), 'how long it took');
});

test('the output is in the chip, to open', () => {
  const r = load();
  r.renderCheckChip({ ok: false, retrying: true, command: 'cargo test', output: 'error[E0308]' });
  assert.strictEqual(r.filled.length, 1);
  assert.strictEqual(r.filled[0].output, 'error[E0308]');
  assert.strictEqual(r.filled[0].isError, true);
});

if (failed) { console.log(`check: ${failed} failed`); process.exit(1); }
console.log('check: all passed');
