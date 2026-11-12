/* Tests for the agent inspector's run store (src/app/agents.js) and the bits of
 * its window (src/app/agentpanel.js) that can be checked without a DOM.
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
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'app', f), 'utf8');
  const src = read('agents.js') + '\n' + read('agentpanel.js');
  const els = new Proxy({}, {
    get(store, key) {
      if (!(key in store)) store[key] = stubEl();
      return store[key];
    },
  });
  const ctx = {
    els,
    isAgentTool: (n) => n === 'Agent' || n === 'Task',
    state: { activeId: 'thread-1', live: new Map() },
    document: { addEventListener() {}, createElement: () => stubEl() },
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    // working.js's retry line, as it reads: null once the wait is over.
    retryLineText: (r, now) => (r && now < r.until ? { label: 'work.retrying', meta: r.why, tone: 'think' } : null),
    escapeHtml: (s) => String(s),
    cssEsc: (s) => String(s),
    openOverlay() {}, closeOverlay() {}, replayClass() {},
    fmtTokens: (n) => String(n),
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    toolLabel: (n) => n,
    isShellTool: (n) => n === 'Bash' || n === 'PowerShell',
    chipTime: () => ({ start: 0, end: null }), paintChipTime() {}, startChipClock() {},
    TOOL_ICON: { Agent: '🧩', Task: '🧩' },
    api: { stopChat: async () => {} },
    stopActiveTurn: async () => {},
    // chips.js's file helpers, recorded so a test can see what a step was given.
    FILE_TOOLS: new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
    isImagePath: (p) => /\.(png|jpe?g|gif|webp)$/i.test(p),
    chipFileActs: (p) => ({ kind: 'acts', path: p }),
    buildImagePreview: (p) => ({ kind: 'img', path: p, classList: { add() {} } }),
    loadChipImages: (root, onLoad) => { root.loaded = onLoad; },
    setInterval, clearInterval, Date, Number, Math, console,
  };
  const exported = [
    'els', 'agentRuns', 'agentRun', 'hasAgentRun', 'agentTaskSeen', 'agentProgressSeen',
    'agentActivitySeen', 'agentResultSeen', 'agentTurnEnded', 'hydrateAgentRuns',
    'agentState', 'agentElapsed', 'AGENT_LOG_MAX', 'agentStepFile', 'agentFollow',
    'agentGapText', 'agentNowLine', 'agentRetrySeen', 'AGENT_GAP_SHOW_MS', 'AGENT_QUIET_HINT_MS',
    'agentJob', 'syncAgentFoot', 'state',
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

check('a delegation tool event opens a running run with its brief', () => {
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

check('what a step returned is folded into that step, not added as a line', () => {
  const A = loadAgents();
  A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Bash', toolId: 'sub_1', detail: 'npm test' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Read', toolId: 'sub_2', target: 'a.js' });
  A.agentActivitySeen({ id: 'tu_1', kind: 'result', toolId: 'sub_1', text: '3 failing', isError: true });
  A.agentActivitySeen({ id: 'tu_1', kind: 'result', toolId: 'nobody', text: 'stray' });   // no such step
  const log = A.agentRun('tu_1').log;
  eq(log.length, 2, 'still two steps');
  eq(log[0].output, '3 failing', 'output on the step that ran it');
  eq(log[0].isError, true, 'failure kept');
  eq(log[1].output, null, 'the other step is untouched');
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

check('both names the CLI has used for delegation are recognised', () => {
  const A = loadAgents();
  A.hydrateAgentRuns('t9', [{
    role: 'assistant',
    segments: [
      { type: 'tool', name: 'Agent', id: 'tu_a', detail: 'current name' },
      { type: 'tool', name: 'Task', id: 'tu_t', detail: 'older name' },
      { type: 'tool', name: 'Read', id: 'tu_r', detail: 'not delegation' },
    ],
  }]);
  eq(A.hasAgentRun('tu_a'), true, 'Agent tracked');
  eq(A.hasAgentRun('tu_t'), true, 'Task tracked');
  eq(A.hasAgentRun('tu_r'), false, 'ordinary tool left alone');
});

check('an unfamiliar delegation tool is adopted from its progress events', () => {
  const A = loadAgents();
  // A future rename: the chip is in the transcript under a name we don't know, so
  // only the CLI's progress event can tell us it launched a sub-agent.
  const row = { onclick: null, querySelector: () => null, appendChild() {} };
  const chip = {
    _seg: { name: 'Delegate', id: 'tu_new', detail: 'do the thing' },
    dataset: { id: 'tu_new' },
    classList: (() => {
      const s = new Set(['action-chip', 'expandable', 'working']);
      return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) };
    })(),
    querySelector: (sel) => (sel === '.chip-row' ? row : null),
  };
  A.els.feed.querySelector = () => chip;

  A.agentProgressSeen({ id: 'tu_new', subagent: 'Explore', toolUses: 2, tokens: 500 });

  const r = A.agentRun('tu_new');
  eq(!!r, true, 'run adopted');
  eq(r.description, 'do the thing', 'brief taken from the chip');
  eq(r.subagent, 'Explore', 'progress applied');
  eq(chip.classList.contains('agent-chip'), true, 'chip upgraded');
  eq(chip.classList.contains('expandable'), false, 'no longer expands inline');
  eq(typeof row.onclick, 'function', 'clicking it opens the inspector');
});

check('a shell command reported as a task is not taken for a sub-agent', () => {
  const A = loadAgents();
  // The CLI raises a task for every shell run, under the shell chip's own id.
  for (const name of ['Bash', 'PowerShell']) {
    const id = 'tu_' + name;
    const chip = {
      _seg: { name, id, detail: 'npm test' }, dataset: { id, tool: name },
      classList: { add() { throw new Error('a shell chip must not be upgraded'); }, remove() {}, contains: () => false, toggle() {} },
      querySelector: () => null,
    };
    A.els.feed.querySelector = () => chip;
    A.agentProgressSeen({ id, phase: 'started', description: 'Run the tests' });
    A.agentActivitySeen({ id, kind: 'text', text: 'hm' });
    eq(A.hasAgentRun(id), false, name + ' stays a shell chip');
  }
});

check('progress does not overwrite the brief the agent was given', () => {
  const A = loadAgents();
  A.agentTaskSeen('thread-1', { id: 'tu_b', name: 'Agent', detail: 'Find the config loader' });
  A.agentProgressSeen({ id: 'tu_b', description: 'Reading README.txt', lastTool: 'Read' });
  const r = A.agentRun('tu_b');
  eq(r.description, 'Find the config loader', 'brief kept');
  eq(r.lastTool, 'Read', 'progress still applied');
});

check('reopening a chat rebuilds finished runs from the transcript', () => {
  const A = loadAgents();
  A.hydrateAgentRuns('t9', [{
    role: 'assistant',
    segments: [{ type: 'tool', name: 'Agent', id: 'tu_old', detail: 'earlier brief', output: 'earlier report' }],
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
    segments: [{ type: 'tool', name: 'Agent', id: 'tu_1', detail: 'saved brief', output: 'saved' }],
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

console.log('\nfiles a worker touched');

function stepBody() {
  const kids = [];
  return { kids, appendChild: (k) => kids.push(k) };
}

check('an image the worker read gets Show in folder / Open and a preview that loads', () => {
  const A = loadAgents();
  const body = stepBody();
  A.agentStepFile(body, { tool: 'Read', detail: 'C:\\tmp\\hk\\front_head.png' });
  eq(body.kids.map((k) => k.kind).join(','), 'acts,img', 'actions then image');
  eq(body.kids[1].path, 'C:\\tmp\\hk\\front_head.png', 'image path');
  eq(body.loaded, A.agentFollow, 'loads now, keeping the timeline following');
});

check('a text file gets the file actions but no preview', () => {
  const A = loadAgents();
  const body = stepBody();
  A.agentStepFile(body, { tool: 'Edit', detail: 'C:\\src\\a.js' });
  eq(body.kids.map((k) => k.kind).join(','), 'acts', 'actions only');
  eq(body.loaded, undefined, 'nothing to load');
});

check('a command or a pathless step gets nothing', () => {
  const A = loadAgents();
  const body = stepBody();
  A.agentStepFile(body, { tool: 'Bash', detail: 'python crop.png' });
  A.agentStepFile(body, { tool: 'Read', detail: '' });
  eq(body.kids.length, 0, 'no file line');
});

console.log('\na quiet worker');

// The store stamps entries with Date.now(); these tests move the clock by hand.
function withClock(fn) {
  const realNow = Date.now;
  let t = 1000000;
  Date.now = () => t;
  try { fn((ms) => { t += ms; return t; }, () => t); } finally { Date.now = realNow; }
}

check('a step after a long silence says how long it was in the making, and how big', () => {
  const A = loadAgents();
  withClock((wait) => {
    A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
    wait(5000);
    A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Bash', toolId: 's1', detail: 'ls' });
    wait(2000);
    A.agentActivitySeen({ id: 'tu_1', kind: 'result', toolId: 's1', text: 'ok' });
    wait(202000);                                   // thinking, unseen
    A.agentActivitySeen({ id: 'tu_1', kind: 'thinking' });
    wait(467000);                                   // writing a big file, unseen
    A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Write', toolId: 's2', chars: 124022 });
  });
  const log = A.agentRun('tu_1').log;
  eq(A.agentGapText(log[0]), '', 'a step at the usual pace says nothing');
  eq(log[1].kind, 'thinking', 'the thought is on the timeline');
  eq(log[1].gapMs, 202000, 'counted from the tool result, not the call');
  eq(A.agentGapText(log[1]), 'agent.thought(202s)', 'a long thought');
  eq(A.agentGapText(log[2]), 'agent.wroteIn(121,467s)', 'the file and the minutes it took');
});

check('a short thought is no row; a long one is', () => {
  const A = loadAgents();
  eq(A.agentGapText({ kind: 'thinking', gapMs: 4000 }), '', 'short');
  eq(A.agentGapText({ kind: 'thinking', gapMs: A.AGENT_GAP_SHOW_MS }), 'agent.thought(30s)', 'long');
  eq(A.agentGapText({ kind: 'tool', gapMs: 1000, chars: 8192 }), 'agent.size(8)', 'big but quick: just the size');
});

check('right now: a tool still out is that tool running', () => {
  const A = loadAgents();
  withClock((wait, now) => {
    A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
    A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Read', toolId: 'a' });
    A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Bash', toolId: 'b' });
    A.agentActivitySeen({ id: 'tu_1', kind: 'result', toolId: 'a', text: '...' });
    wait(90000);
    const t = A.agentNowLine(A.agentRun('tu_1'), now());
    eq(t.label, 'Bash', 'the call still out');
    eq(t.meta, '90s', 'for how long');
    eq(t.hint, 'agent.nowToolHint', 'and why there is nothing to see');
  });
});

check('right now: with nothing out, it is composing, counted from its last sign', () => {
  const A = loadAgents();
  withClock((wait, now) => {
    A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
    A.agentActivitySeen({ id: 'tu_1', kind: 'tool', tool: 'Bash', toolId: 'b' });
    wait(3000);
    A.agentActivitySeen({ id: 'tu_1', kind: 'result', toolId: 'b', text: 'ok' });
    wait(20000);
    let t = A.agentNowLine(A.agentRun('tu_1'), now());
    eq(t.label, 'agent.nowComposing', 'composing');
    eq(t.meta, 'agent.nowSince(20s)', 'since the result came back');
    eq(t.hint, '', 'no explanation for a short quiet');
    wait(A.AGENT_QUIET_HINT_MS);
    t = A.agentNowLine(A.agentRun('tu_1'), now());
    eq(t.hint, 'agent.quietHint', 'a long quiet explains itself');
  });
});

check('right now: a wait for the API is said as such, then passes', () => {
  const A = loadAgents();
  withClock((wait, now) => {
    A.agentTaskSeen('t1', { id: 'tu_1', detail: 'brief' });
    A.agentTaskSeen('t2', { id: 'tu_2', detail: 'another chat' });
    A.agentRetrySeen('t1', { why: 'limit', until: now() + 30000, attempt: 1, max: 10 });
    eq(A.agentRun('tu_2').retry, null, 'another chat is not waiting');
    let t = A.agentNowLine(A.agentRun('tu_1'), now());
    eq(t.label, 'work.retrying', 'waiting');
    eq(t.hint, 'agent.retryHint', 'and that it carries on');
    wait(30000);
    t = A.agentNowLine(A.agentRun('tu_1'), now());
    eq(t.label, 'agent.nowComposing', 'the wait is over');
  });
});

check('a worker the reply waits on in the background stops on its own; any other ends the reply', () => {
  const A = loadAgents();
  A.agentTaskSeen('thread-1', { id: 'tu_bg', name: 'Agent', detail: 'Build it' });
  const r = A.agentRun('tu_bg');
  const live = { threadId: 'thread-1', background: { running: 1, jobs: [] } };
  A.state.live.set('thread-1', live);
  eq(A.agentJob(r), null, 'not among the jobs: no job of its own');
  A.syncAgentFoot(r);
  eq(A.els.agentHint.textContent, 'agent.stopHint', 'stopping it ends the reply');
  live.background.jobs.push({ id: 'tu_bg', task: 'a1', kind: 'agent' });
  eq(A.agentJob(r).task, 'a1', 'found by its tool id, with the task to stop');
  A.syncAgentFoot(r);
  eq(A.els.agentHint.textContent, 'agent.stopJobHint', 'stopping it stops only it');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
