/* Tests for Ask mode's permission prompts (src/app/permissions.js).
 *
 * Same approach as agents-store.test.js: the file is loaded into a vm context
 * that provides the globals it expects from its siblings, with a DOM stub just
 * thick enough to let the card build. What's under test is the bookkeeping — the
 * per-turn queue, which question is on show, what gets sent back — and the
 * wording of the "always" button, not the pixels.
 *
 * Run: node tests/permissions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------- the stubs ------------------------------- */

function stubEl(tag) {
  const set = new Set();
  const el = {
    tag, hidden: false, textContent: '', title: '', disabled: false,
    className: '', dataset: {}, children: [], onclick: null,
    // Assigning markup replaces what was there, as the real thing does.
    set innerHTML(_html) { el.children.length = 0; },
    get innerHTML() { return ''; },
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    },
    appendChild(child) { el.children.push(child); return child; },
    // Enough of a tree walk to find the buttons the card was given.
    all() { return el.children.flatMap((c) => [c, ...c.all()]); },
    querySelector: () => null,
    querySelectorAll(sel) { return sel === 'button' ? el.all().filter((c) => c.tag === 'button') : []; },
  };
  return el;
}

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'permissions.js'), 'utf8');
  const strip = stubEl('div');
  strip.hidden = true;
  const calls = { answered: [], tips: [], closedTips: 0, sidebar: 0, opened: [] };
  const ctx = {
    els: { composerPerm: strip },
    state: { activeId: 't1', live: new Map(), view: 'threads', threads: [{ id: 't2', title: 'Refactor' }] },
    document: { createElement: (tag) => stubEl(tag) },
    window: { addEventListener() {} },
    // Echo the key with its variables, so a test can see which string was chosen.
    tr: (k, vars) => (vars ? `${k}(${Object.values(vars).join(',')})` : k),
    escapeHtml: (s) => String(s),
    basename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop(),
    replayClass() {},
    renderDiff: () => stubEl('div'),
    renderSidebar: () => { calls.sidebar++; },
    openThread: (id) => { calls.opened.push(id); },
    showTip: (tip) => { calls.tips.push(tip); return () => { calls.closedTips++; }; },
    api: {
      answerPermission: async (threadId, id, decision) => {
        calls.answered.push({ threadId, id, decision });
        return { ok: true };
      },
    },
    console,
  };
  const exported = [
    'permissionAsked', 'permissionGone', 'permissionsTurnEnded', 'threadAwaitsPermission',
    'permissionAlways', 'permissionTitle', 'renderPermission', 'answerPermission', 'syncPermission',
  ];
  const P = vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'permissions.js' });
  return { P, ctx, strip, calls };
}

function liveTurn(ctx, threadId) {
  const live = { threadId };
  ctx.state.live.set(threadId, live);
  return live;
}

const bash = (id, cmd) => ({
  id, tool: 'Bash', detail: cmd,
  always: [{ kind: 'rule', tool: 'Bash', text: cmd.split(' ')[0] + ' *', scope: 'localSettings' }],
});

/* -------------------------------- harness -------------------------------- */

let failures = 0;
// Some checks await a click, so they are queued and run in order at the end.
const steps = [];
function section(title) { steps.push(async () => console.log(title)); }
function check(name, fn) {
  steps.push(async () => {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (e) {
      failures++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
    }
  });
}
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* --------------------------------- tests --------------------------------- */

section('permission prompts');

check('a question on the open chat shows its card and marks the sidebar', () => {
  const { P, ctx, strip, calls } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  eq(P.threadAwaitsPermission('t1'), true, 'waiting');
  eq(strip.hidden, false, 'strip shown');
  eq(strip.dataset.pid, 'r1', 'question on show');
  eq(calls.sidebar, 1, 'sidebar re-rendered');
  eq(calls.tips.length, 0, 'no tip for a chat you are looking at');
});

check('the same question announced twice is one question', () => {
  const { P, ctx } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  P.permissionAsked(live, bash('r1', 'npm install'));
  eq(live.permissions.length, 1, 'queue length');
});

check('questions queue: the first stays on show until it is settled', () => {
  const { P, ctx, strip } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  P.permissionAsked(live, bash('r2', 'git push'));
  eq(strip.dataset.pid, 'r1', 'front of the queue');
  P.permissionGone(live, 'r1');
  eq(strip.dataset.pid, 'r2', 'next one steps up');
  P.permissionGone(live, 'r2');
  eq(strip.hidden, true, 'strip hidden once nothing is waiting');
  eq(P.threadAwaitsPermission('t1'), false, 'no longer waiting');
});

check('a question settled out of order leaves the one on show alone', () => {
  const { P, ctx, strip } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  P.permissionAsked(live, bash('r2', 'git push'));
  P.permissionGone(live, 'r2');
  eq(strip.dataset.pid, 'r1', 'still the first');
  eq(live.permissions.length, 1, 'queue length');
  P.permissionGone(live, 'nope');   // unknown id: nothing happens
  eq(live.permissions.length, 1, 'unknown id ignored');
});

check('a question in a chat you are not looking at raises a tip, once', () => {
  const { P, ctx, strip, calls } = load();
  const other = liveTurn(ctx, 't2');
  P.permissionAsked(other, bash('r1', 'npm install'));
  P.permissionAsked(other, bash('r2', 'git push'));
  eq(strip.hidden, true, 'nothing shown on the open chat');
  eq(calls.tips.length, 1, 'one tip, not one per question');
  eq(calls.tips[0].body.includes('Refactor'), true, 'names the chat');
  // Its button takes you there.
  calls.tips[0].actions[0].run(() => {});
  eq(calls.opened[0], 't2', 'opens the waiting chat');
});

check('opening that chat shows the question and retires the tip', () => {
  const { P, ctx, strip, calls } = load();
  const other = liveTurn(ctx, 't2');
  P.permissionAsked(other, bash('r1', 'npm install'));
  ctx.state.activeId = 't2';
  P.syncPermission();
  eq(strip.dataset.pid, 'r1', 'question on show');
  eq(calls.closedTips, 1, 'tip closed');
});

check('the end of the turn clears whatever it was still asking', () => {
  const { P, ctx, strip } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  ctx.state.live.delete('t1');           // as finishLive does
  P.permissionsTurnEnded(live);
  eq(live.permissions.length, 0, 'queue emptied');
  eq(strip.hidden, true, 'strip hidden');
});

check('each button sends its own decision, and the card goes once it is taken', async () => {
  const { P, ctx, strip, calls } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  const buttons = strip.querySelectorAll('button');
  eq(buttons.length, 3, 'allow, always, deny');
  eq(buttons.map((b) => b.className.split(' ')[1]).join(','), 'allow,always,deny', 'order');
  await buttons[1].onclick();
  eq(calls.answered.length, 1, 'one answer sent');
  eq(calls.answered[0].decision, 'always', 'decision');
  eq(calls.answered[0].id, 'r1', 'request id');
  eq(calls.answered[0].threadId, 't1', 'thread');
  eq(strip.hidden, true, 'card gone');
});

check('with nothing to make permanent there is no "always" button', () => {
  const { P, ctx, strip } = load();
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, { id: 'r1', tool: 'WebFetch', detail: 'https://example.com', always: [] });
  eq(strip.querySelectorAll('button').length, 2, 'allow and deny only');
});

check('an answer that could not be sent keeps the question, with live buttons', async () => {
  const { P, ctx, strip } = load();
  ctx.api.answerPermission = async () => { throw new Error('offline'); };
  const live = liveTurn(ctx, 't1');
  P.permissionAsked(live, bash('r1', 'npm install'));
  const buttons = strip.querySelectorAll('button');
  await buttons[0].onclick();
  eq(live.permissions.length, 1, 'still queued');
  eq(buttons[0].disabled, false, 'button usable again');
});

section('the wording');

check('the "always" button says what it would stop asking about', () => {
  const { P } = load();
  const edits = P.permissionAlways({ always: [{ kind: 'mode', text: 'acceptEdits', scope: 'session' }] });
  eq(edits.label, 'perm.always.edits', 'accept-edits');
  eq(edits.title.includes('perm.scope.session'), true, 'tooltip says how long it lasts');

  const rule = P.permissionAlways({ always: [{ kind: 'rule', tool: 'Bash', text: 'npm install *', scope: 'localSettings' }] });
  eq(rule.label, 'perm.always.rule(npm install *)', 'command rule');

  // A rule with no pattern covers the whole tool — name the tool.
  const tool = P.permissionAlways({ always: [{ kind: 'rule', tool: 'mcp__github__create_issue', text: '', scope: 'localSettings' }] });
  eq(tool.label, 'perm.always.rule(create_issue (github))', 'tool-wide rule');

  const dir = P.permissionAlways({ always: [{ kind: 'dir', text: 'C:\\work\\notes', scope: 'session' }] });
  eq(dir.label, 'perm.always.dir(notes)', 'folder');

  eq(P.permissionAlways({ always: [] }), null, 'nothing offered');
  eq(P.permissionAlways({}), null, 'field absent');
});

check('the title names the action, or the tool when it has no wording of its own', () => {
  const { P } = load();
  eq(P.permissionTitle({ tool: 'Bash' }), 'perm.title.run', 'command');
  eq(P.permissionTitle({ tool: 'MultiEdit' }), 'perm.title.edit', 'edit');
  eq(P.permissionTitle({ tool: 'mcp__github__create_issue' }), 'perm.title.tool(create_issue (github))', 'mcp tool');
});

(async () => {
  for (const step of steps) await step();
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
