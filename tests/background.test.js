/* Tests for the jobs a reply waits on (src/app/background.js): what each row
 * says for a helper agent and a background command, how long silence has to
 * last before it turns amber and how that is worded, that an API wait is no
 * silence, and that the list keeps what it knew across the backend's updates.
 *
 * Loaded with the agent run store (src/app/agents.js) it reads helpers from.
 *
 * Run: node tests/background.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function load() {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'app', f), 'utf8');
  const ctx = {
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    toolLabel: (n) => 'tool:' + n,
    // working.js's retry line, as it reads: null once the wait is over.
    retryLineText: (r, now) => (r && now < r.until ? { label: 'work.retrying', meta: r.why, tone: 'think' } : null),
    motionOK: () => true, replayClass() {}, icon: () => '', toolIcon: () => '',
    WORK_BEAT_MS: 300,
    agentRunChanged() {},   // the inspector's repaint (agentpanel.js)
    document: { addEventListener() {}, createElement: () => ({}) },
    state: { activeId: 't1', live: new Map() },
    els: new Proxy({}, { get: () => ({ querySelector: () => null, querySelectorAll: () => [] }) }),
    Date, Math, Number, console,
  };
  vm.createContext(ctx);
  vm.runInContext(read('agents.js') + '\n' + read('background.js'), ctx);
  return ctx;
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const b = load();
const t0 = 10_000_000;
const MIN = 60 * 1000;
const agentJob = (patch) => ({ id: 'tu_send', task: 'a1', kind: 'agent', description: 'Build the importer', startedAt: t0, ...patch });
const shellJob = (patch) => ({ id: 'tu_sh', task: 'b1', kind: 'shell', description: 'Run the build', startedAt: t0, tail: '', tailAt: null, ...patch });
const run = (patch) => ({ id: 'tu_send', log: [], heardAt: null, now: '', retry: null, description: '', ...patch });

test('a helper says what it is, how long it has run, and when it was last heard from', () => {
  const v = b.bgJobView(agentJob(), run({ heardAt: t0 + 30000, now: 'Running Sleep for 25 seconds' }), t0 + 50000);
  assert.strictEqual(v.title, 'Build the importer');
  assert.strictEqual(v.clock, '50s', 'its own clock, from when it started');
  assert.strictEqual(v.step, 'Running Sleep for 25 seconds', "the CLI's word on its current step");
  assert.strictEqual(v.last, 'bg.last(20s)');
  assert.strictEqual(v.tone, 'live');
  assert.strictEqual(v.warn, '');
  assert.strictEqual(v.check, 'inspect');
  assert.strictEqual(b.bgJobView(agentJob(), run({ heardAt: t0 + 48000 }), t0 + 50000).last, 'bg.lastNow');
  assert.strictEqual(b.bgJobView(agentJob(), null, t0).step, 'bg.starting', 'nothing heard yet');
});

test('a tool the helper is still waiting on is its step, with that tool\'s own clock', () => {
  const r = run({ heardAt: t0 + 10000, log: [
    { kind: 'text', text: 'Building now.\nThen testing.', at: t0 + 5000 },
    { kind: 'tool', tool: 'Bash', target: 'npm run build', toolId: 'w1', output: null, at: t0 + 10000 },
  ] });
  assert.strictEqual(b.bgJobView(agentJob(), r, t0 + 70000).step, 'tool:Bash · npm run build · 60s');
  // Once it returns, the latest thing said or done is the step.
  r.log[1].output = 'ok';
  r.log.push({ kind: 'text', text: 'Build passed.\nMore detail.', at: t0 + 80000 });
  assert.strictEqual(b.bgJobView(agentJob(), r, t0 + 81000).step, 'Build passed.', 'first line only');
});

test('a helper silent for ten minutes turns amber, worded by what the silence is', () => {
  const quiet = run({ heardAt: t0 });
  assert.strictEqual(b.bgJobView(agentJob(), quiet, t0 + 10 * MIN - 1000).tone, 'live', 'not yet');
  const v = b.bgJobView(agentJob(), quiet, t0 + 12 * MIN);
  assert.strictEqual(v.tone, 'stale');
  assert.strictEqual(v.warn, 'bg.staleQuiet(720s)');
  const busy = run({ heardAt: t0, log: [{ kind: 'tool', tool: 'Bash', target: 'npm test', toolId: 'w1', output: null, at: t0 }] });
  assert.strictEqual(b.bgJobView(agentJob(), busy, t0 + 12 * MIN).warn, 'bg.staleTool(tool:Bash,720s)',
    'a command still running may be fine, and says so');
});

test('a helper waiting out an API retry is not silent', () => {
  const r = run({ heardAt: t0, retry: { why: 'limit', until: t0 + 20 * MIN } });
  const v = b.bgJobView(agentJob(), r, t0 + 12 * MIN);
  assert.strictEqual(v.step, 'work.retrying · limit');
  assert.strictEqual(v.tone, 'live');
  assert.strictEqual(v.warn, '');
});

test('a command shows the last line it printed and when, and goes amber after ten quiet minutes', () => {
  const none = b.bgJobView(shellJob(), null, t0 + 5000);
  assert.strictEqual(none.step, 'bg.noOutput');
  assert.strictEqual(none.mono, false);
  assert.strictEqual(none.last, '', 'no output yet: no "last output" either');
  assert.strictEqual(none.check, 'open');
  const job = shellJob({ tail: 'compiling\nlinking krystal.exe\n\n', tailAt: t0 + 60000 });
  const v = b.bgJobView(job, null, t0 + 90000);
  assert.strictEqual(v.step, 'linking krystal.exe');
  assert.strictEqual(v.mono, true);
  assert.strictEqual(v.last, 'bg.lastOutput(30s)');
  const stale = b.bgJobView(job, null, t0 + 60000 + 11 * MIN);
  assert.strictEqual(stale.tone, 'stale');
  assert.strictEqual(stale.warn, 'bg.staleShell(660s)');
  // A long line is cut to fit a row.
  assert.ok(b.bgLastLine('x'.repeat(500)).length <= 140);
});

test('the list keeps each job\'s start and output across updates, on this clock', () => {
  const first = b.bgFromEvent({ running: 1, jobs: [
    { id: 'tu_sh', task: 'b1', kind: 'shell', description: 'Run the build', ageMs: 4000 },
  ] }, null, 't1', t0);
  assert.strictEqual(first.jobs[0].startedAt, t0 - 4000, 'an age, turned into a start on this clock');
  assert.strictEqual(first.threadId, 't1');
  b.bgJobActivity(first, { id: 'tu_sh', tail: 'step 1' }, t0 + 1000);
  assert.strictEqual(first.jobs[0].tail, 'step 1');
  assert.strictEqual(first.jobs[0].tailAt, t0 + 1000);
  const next = b.bgFromEvent({ running: 2, jobs: [
    { id: 'tu_sh', task: 'b1', kind: 'shell', ageMs: 9000 },
    { id: 'tu_ag', task: 'a2', kind: 'agent', ageMs: 0, owner: null },
  ] }, first, 't1', t0 + 5000);
  assert.strictEqual(next.jobs[0].startedAt, t0 - 4000, 'the start it already had');
  assert.strictEqual(next.jobs[0].tail, 'step 1', 'and what it printed');
  assert.strictEqual(next.jobs[1].kind, 'agent');
  // An older backend sends only a count.
  assert.strictEqual(b.bgFromEvent({ running: 1 }, null, 't1', t0).jobs.length, 0);
  // A line for a job no longer listed changes nothing.
  b.bgJobActivity(next, { id: 'gone', tail: 'x' }, t0);
});

test('the helper\'s current step comes from its progress reports, never its brief', () => {
  b.agentTaskSeen('t1', { id: 'tu_p', name: 'Agent', detail: 'Build the importer' });
  b.agentProgressSeen({ id: 'tu_p', phase: 'started', description: 'Build the importer' });
  assert.strictEqual(b.agentRun('tu_p').now, '');
  b.agentProgressSeen({ id: 'tu_p', phase: 'progress', description: 'Running Run the tests' });
  assert.strictEqual(b.agentRun('tu_p').now, 'Running Run the tests');
  assert.strictEqual(b.agentRun('tu_p').description, 'Build the importer');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nbackground: all passed');
