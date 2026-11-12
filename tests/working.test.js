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

test('waiting on background work says so, with a count only when there are several', () => {
  const at = (jobs) => w.workLineText({ since: t0, phase: 'background', jobs, tool: 'Bash' }, t0 + 75000);
  assert.strictEqual(at(1).label, 'work.background');
  assert.strictEqual(at(1).meta, '75s', 'one job: just the clock, no tool left over from before');
  assert.strictEqual(at(3).meta, 'work.jobs(3) · 75s');
  assert.strictEqual(at(1).tone, 'live', 'still working, not waiting on you');
  // A permission prompt from the background job still wins: that one needs you.
  assert.strictEqual(w.workLineText({ since: t0, phase: 'background', jobs: 1, waiting: true }, t0).tone, 'wait');
});

test('one background job of a known kind is named for what it is', () => {
  const at = (jobs, jobKind) => w.workLineText({ since: t0, phase: 'background', jobs, jobKind }, t0).label;
  assert.strictEqual(at(1, 'agent'), 'work.bgAgent');
  assert.strictEqual(at(1, 'shell'), 'work.bgShell');
  assert.strictEqual(at(2, 'agent'), 'work.background', 'several: just "background work"');
  assert.strictEqual(at(1, ''), 'work.background', 'a mix, or an older backend that sent no list');
});

test('while the project\'s check runs, the line names it and keeps time', () => {
  const t = w.workLineText({ since: t0, phase: 'check', tool: 'npm test' }, t0 + 30000);
  assert.strictEqual(t.label, 'work.checking');
  assert.strictEqual(t.meta, 'npm test · 30s');
  assert.strictEqual(t.tone, 'live');
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

test('a retry says why, when the next try is, and which try it will be', () => {
  const note = w.apiRetryNote({ attempt: 2, maxRetries: 10, delayMs: 40000, status: 429, error: 'rate_limit' }, t0);
  assert.strictEqual(note.why, 'limit');
  assert.strictEqual(note.until, t0 + 40000);
  const line = w.workLineText({ since: t0, phase: 'tool', tool: 'Agent', retry: note }, t0 + 10000);
  assert.strictEqual(line.label, 'work.retrying');
  assert.strictEqual(line.meta, 'retry.why.limit · work.retryIn(30s) · work.retryTry(2,10)');
});

test('the reasons a request fails are told apart', () => {
  const why = (m) => w.apiRetryNote(m, t0).why;
  assert.strictEqual(why({ status: 529, error: 'overloaded_error' }), 'overloaded');
  assert.strictEqual(why({ error: 'Request timed out' }), 'noanswer');
  assert.strictEqual(why({ status: 500, error: 'api_error' }), 'error');
  assert.strictEqual(why({ error: 'rate_limit' }), 'limit');
});

test('once the wait is over the line goes back to what the turn is doing', () => {
  const note = w.apiRetryNote({ delayMs: 5000 }, t0);
  const line = w.workLineText({ since: t0, phase: 'writing', retry: note }, t0 + 5000);
  assert.strictEqual(line.label, 'work.writing');
  assert.strictEqual(w.retryLineText(null, t0), null);
});

test('waiting on you outranks a retry', () => {
  const note = w.apiRetryNote({ delayMs: 60000 }, t0);
  assert.strictEqual(w.workLineText({ since: t0, waiting: true, retry: note }, t0 + 1).label, 'work.waiting');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nworking: all passed');
