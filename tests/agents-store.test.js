/* Tests for the agent inspector's run store (src/app/agents.js).
 *
 * The frontend is bundler-free classic scripts sharing one global scope, so the
 * file is loaded here into a vm context that provides exactly the globals it
 * expects from its siblings (els/state/tr/…) plus a DOM stub thin enough to keep
 * the panel closed — what's under test is the bookkeeping, not the rendering.
 *
 * Run: node tests/agents-store.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------- the stubs ------------------------------- */

function stubEl() {
  const set = new Set();
  return {
    hidden: true, textContent: '', innerHTML: '', title: '', disabled: false,
    className: '', dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    },
    addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function loadAgents() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'agents.js'), 'utf8');
  const els = new Proxy({}, {
    get(store, key) {
      if (!(key in store)) store[key] = stubEl();
      return store[key];
    },
  });
  const ctx = {
    els,
    state: { activeId: 'thread-1', live: new Map() },
    document: { addEventListener() {}, createElement: () => stubEl() },
    tr: (k) => k,
    escapeHtml: (s) => String(s),
    cssEsc: (s) => String(s),
    openOverlay() {}, closeOverlay() {}, replayClass() {},
    fmtTokens: (n) => String(n),
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    toolLabel: (n) => n,
    TOOL_ICON: { Task: '🧩' },
    api: { stopChat: async () => {} },
    stopActiveTurn: async () => {},
    setInterval, clearInterval, Date, Number, Math, console,
  };
  const exported = [
    'agentRuns', 'agentRun', 'hasAgentRun', 'agentTaskSeen', 'agentProgressSeen',
    'agentActivitySeen', 'agentResultSeen', 'agentTurnEnded', 'hydrateAgentRuns',
    'agentState', 'agentElapsed', 'AGENT_LOG_MAX',
  ];
  return vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'agents.js' });
}

/* -------------------------------- harness -------------------------------- */

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

/* --------------------------------- tests --------------------------------- */

console.log('agent run store');

check('a Task tool event opens a running run with its brief', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', name: 'Task', target: 'research the API', detail: 'research the API surface' });
  const r = A.agentRun('tu_1');
  eq(!!r, true, 'run exists');
  eq(r.threadId, 't1', 'threadId');
  eq(r.description, 'research the API surface', 'description');
  eq(r.running, true, 'running');
  eq(A.agentState(r), 'running', 'state');
});

check('progress folds in the tally without duplicating the run', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentProgressSeen({ id: 'tu_1', subagent: 'Explore', lastTool: 'Grep', toolUses: 4, tokens: 8200, durationMs: 6000 });
  const r = A.agentRun('tu_1');
  eq(A.agentRuns.size, 1, 'run count');
  eq(r.subagent, 'Explore', 'subagent');
  eq(r.lastTool, 'Grep', 'lastTool');
  eq(r.toolUses, 4, 'toolUses');
  eq(r.tokens, 8200, 'tokens');
});

check('activity lines land on the timeline in order', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'text', text: 'Looking around' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Read', target: 'a.js', detail: 'src/a.js' });
  const log = A.agentRun('tu_1').log;
  eq(log.length, 2, 'entries');
  eq(log[0].kind, 'text', 'first kind');
  eq(log[1].tool, 'Read', 'second tool');
  eq(typeof log[1].at, 'number', 'timestamped');
});

check('the timeline is capped, keeping the newest steps', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  for (let i = 0; i < A.AGENT_LOG_MAX + 25; i++) {
    A.agentActivitySeen({ id: 'tu_1', kind: 'text', text: 'step ' + i });
  }
  const log = A.agentRun('tu_1').log;
  eq(log.length, A.AGENT_LOG_MAX, 'capped');
  eq(log[log.length - 1].text, 'step ' + (A.AGENT_LOG_MAX + 24), 'newest kept');
});

check('a tool_result finishes the run and keeps the report', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentResultSeen({ id: 'tu_1', output: 'found 3 call sites' });
  const r = A.agentRun('tu_1');
  eq(r.running, false, 'running');
  eq(r.output, 'found 3 call sites', 'output');
  eq(A.agentState(r), 'done', 'state');
});

check('a failed sub-agent reads as failed', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentResultSeen({ id: 'tu_1', output: 'boom', isError: true });
  eq(A.agentState(A.agentRun('tu_1')), 'error', 'state');
});

check('a worker still going when the turn ends counts as stopped', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentTurnEnded('t1');
  const r = A.agentRun('tu_1');
  eq(r.running, false, 'running');
  eq(A.agentState(r), 'stopped', 'state');
});

check('the turn ending leaves other threads alone', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentTaskSeen('t2', { id: 'tu_2', detail: 'brief' });
  A.agentTurnEnded('t1');
  eq(A.agentRun('tu_1').running, false, 'own thread settled');
  eq(A.agentRun('tu_2').running, true, 'other thread untouched');
});

check('a finished run is not resurrected by a late progress event', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentResultSeen({ id: 'tu_1', output: 'done' });
  A.agentProgressSeen({ id: 'tu_1', toolUses: 9, tokens: 9000 });   // straggler
  A.agentTurnEnded('t1');
  const r = A.agentRun('tu_1');
  eq(r.running, false, 'still settled');
  eq(A.agentState(r), 'done', 'still done');
  eq(r.tokens, 9000, 'but the final tally is kept');
});

check('events for a worker a worker spawned are ignored (no chip, no run)', () => {
  const A = loadAgents();
  A.agentProgressSeen({ id: 'nested_1', tokens: 10 });
  A.agentActivitySeen({ id: 'nested_1', kind: 'text', text: 'hi' });
  eq(A.hasAgentRun('nested_1'), false, 'no phantom run');
  eq(A.agentRuns.size, 0, 'store empty');
});

check('reopening a chat rebuilds finished runs from the transcript', () => {
  const A = loadAgents();
  A.hydrateAgentRuns('t9', [{
    role: 'assistant',
    segments: [{ type: 'tool', name: 'Task', id: 'tu_old', detail: 'earlier brief', output: 'earlier report' }],
  }]);
  const r = A.agentRun('tu_old');
  eq(r.running, false, 'not running');
  eq(r.live, false, 'not live');
  eq(r.threadId, 't9', 'threadId');
  eq(r.description, 'earlier brief', 'description');
  eq(r.output, 'earlier report', 'report');
  eq(r.startedAt, null, 'no start time to offset against');
});

check('hydrating does not clobber a run from this session', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'live brief' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'text', text: 'step' });
  A.hydrateAgentRuns('t1', [{
    role: 'assistant',
    segments: [{ type: 'tool', name: 'Task', id: 'tu_1', detail: 'saved brief', output: 'saved' }],
  }]);
  const r = A.agentRun('tu_1');
  eq(r.description, 'live brief', 'kept the live brief');
  eq(r.log.length, 1, 'kept the live timeline');
});

check('elapsed prefers the CLI duration, never goes backwards', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  const r = A.agentRun('tu_1');
  r.durationMs = 30000;
  const first = A.agentElapsed(r);
  eq(first >= 30000, true, 'uses the reported duration');
  r.startedAt = Date.now() - 60000;
  eq(A.agentElapsed(r) >= 60000, true, 'falls forward to wall clock');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
