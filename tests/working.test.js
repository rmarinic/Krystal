/* Tests for the working line under a live reply (src/app/working.js): what it
 * says in each phase, the size of a long tool input, waiting, and that it goes
 * away — and stops its clock — when the reply lands or leaves the screen.
 *
 * Run: node tests/working.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Just enough DOM for makeWorkLine: elements that can be found by class.
function fakeEl(cls) {
  const el = {
    className: cls || '', textContent: '', dataset: {}, children: [], removed: false,
    classList: { add(c) { el.className += ' ' + c; }, remove() {}, contains: () => false },
    set innerHTML(html) {
      el.children = [...html.matchAll(/class="([^"]+)"/g)].map((m) => fakeEl(m[1]));
    },
    querySelector(sel) { return el.children.find((c) => '.' + c.className === sel) || null; },
    remove() { el.removed = true; },
    after(other) { el.next = other; },
  };
  return el;
}

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'working.js'), 'utf8');
  const timers = new Set();
  const ctx = {
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    motionOK: () => true,
    replayClass: (el, c) => { el.beats = (el.beats || 0) + 1; },
    document: { createElement: () => fakeEl(), addEventListener() {} },
    setInterval: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearInterval: (t) => timers.delete(t),
    setTimeout: (fn) => fn(),
    Date, Math, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.timers = timers;
  return ctx;
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const w = load();
const t0 = 1_000_000;

test('each phase has its word, and the clock counts from the turn start', () => {
  const at = (patch) => w.workLineText({ since: t0, phase: 'thinking', ...patch }, t0 + 42000);
  assert.strictEqual(at({}).label, 'work.thinking');
  assert.strictEqual(at({}).tone, 'think');
  assert.strictEqual(at({}).meta, '42s');
  assert.strictEqual(at({ phase: 'writing' }).label, 'work.writing');
  assert.strictEqual(at({ phase: 'writing' }).tone, 'live');
  assert.strictEqual(at({ phase: 'tool', tool: 'Artifact' }).meta, 'Artifact · 42s');
});

test('a long tool input shows its size; a short one does not', () => {
  const at = (chars) => w.workLineText({ since: t0, phase: 'tool', tool: 'Artifact', chars }, t0 + 5000).meta;
  assert.strictEqual(at(400), 'Artifact · 5s');
  assert.strictEqual(at(14 * 1024), 'Artifact · work.size(14) · 5s');
  // The size belongs to the tool being written, not to text that follows it.
  assert.strictEqual(w.workLineText({ since: t0, phase: 'writing', chars: 9000 }, t0).meta, '0s');
});

test('waiting on you: amber, and nothing that moves', () => {
  const t = w.workLineText({ since: t0, phase: 'tool', tool: 'Bash', waiting: true }, t0 + 9000);
  assert.strictEqual(t.label, 'work.waiting');
  assert.strictEqual(t.tone, 'wait');
  assert.strictEqual(t.meta, '');
});

test('the line sits under the bubble, beats on events, and goes when the reply lands', () => {
  const r = load();
  const bubble = fakeEl('bubble');
  const line = r.makeWorkLine(bubble, Date.now());
  const el = bubble.next;
  assert.ok(el && el.className.startsWith('work-line'));
  assert.strictEqual(r.timers.size, 1, 'the clock runs while a line is up');
  line.set({ phase: 'tool', tool: 'Artifact', toolId: 'toolu_a' });
  assert.strictEqual(el.querySelector('.wl-label').textContent, 'work.working');
  assert.strictEqual(el.dataset.tone, 'live');
  line.beat();
  line.beat();   // rate-limited: one beat for two events this close together
  assert.strictEqual(el.querySelector('.wl-dot').beats, 1);
  line.set({ waiting: true });
  assert.strictEqual(el.dataset.tone, 'wait');
  line.end();
  assert.ok(el.removed);
  assert.strictEqual(r.timers.size, 0, 'the clock stops at rest');
});

test('a chat leaving the screen takes its line with it', () => {
  const r = load();
  const a = r.makeWorkLine(fakeEl('bubble'));
  const b = r.makeWorkLine(fakeEl('bubble'));
  assert.strictEqual(r.timers.size, 1, 'one clock for every line');
  a.detach();
  assert.strictEqual(r.timers.size, 1);
  b.detach();
  assert.strictEqual(r.timers.size, 0);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nworking: all passed');
