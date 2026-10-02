/* Tests for queued messages (src/app/queue.js).
 *
 * Same approach as permissions.test.js: the file is loaded into a vm context
 * that provides the globals it expects from its siblings, with a DOM stub just
 * thick enough to let the strip build. What's under test is the bookkeeping —
 * what waits, what goes out when a turn ends and what is held back — not the
 * pixels.
 *
 * Run: node tests/queue.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------- the stubs ------------------------------- */

function stubEl(tag) {
  const set = new Set();
  const el = {
    tag, hidden: false, textContent: '', title: '', type: '', value: '',
    className: '', children: [], onclick: null, scrollTop: 0, scrollHeight: 0,
    // Assigning markup replaces what was there, as the real thing does.
    set innerHTML(_html) { el.children.length = 0; },
    get innerHTML() { return ''; },
    classList: {
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      contains: (c) => set.has(c),
    },
    setAttribute() {},
    focus() {},
    appendChild(child) { el.children.push(child); return child; },
    all() { return el.children.flatMap((c) => [c, ...c.all()]); },
    // By class name — all the strip is ever asked for here.
    byClass(cls) { return el.all().filter((c) => c.className.split(' ').includes(cls)); },
  };
  return el;
}

/* A localStorage that outlives one `load()`, so a restart can be played out. */
function memoryStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

function load(storage) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'queue.js'), 'utf8');
  const strip = stubEl('div');
  strip.hidden = true;
  const button = stubEl('button');
  const input = stubEl('textarea');
  const calls = { started: [], tips: [], sidebar: 0, opened: [], refs: [], files: [], drafts: [] };
  const ctx = {
    els: { composerQueue: strip, queueBtn: button, input },
    state: {
      activeId: 't1', live: new Map(), view: 'threads', streaming: false,
      threads: [{ id: 't2', title: 'Refactor' }],
    },
    localStorage: storage || memoryStorage(),
    document: { createElement: (tag) => stubEl(tag) },
    pendingAnswer: null,
    // Echo the key with its variables, so a test can see which string was chosen.
    tr: (k, vars) => (vars ? `${k}(${Object.values(vars).join(',')})` : k),
    escapeHtml: (s) => String(s),
    basename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop(),
    renderSidebar: () => { calls.sidebar++; },
    openThread: (id) => { calls.opened.push(id); },
    showTip: (tip) => { calls.tips.push(tip); return () => {}; },
    // As the real one does: the turn is live from the moment it starts.
    startTurn: (threadId, msg, opts) => {
      calls.started.push({ threadId, msg, opts });
      ctx.state.live.set(threadId, { threadId });
    },
    send: () => {},
    saveDraft: (id, text) => { calls.drafts.push({ id, text }); },
    restoreComposerRefs: (refs) => { calls.refs.push(refs); },
    attachSavedPath: (p) => { calls.files.push(p); },
    autosize() {},
    syncShellMode() {},
    isShellInput: (v) => /^\s*\$/.test(v || ''),
    hasComposerAttachments: () => false,
    console,
  };
  const exported = [
    'enqueueMessage', 'takeQueued', 'dropQueue', 'queuedCount', 'sendNextQueued',
    'queueTurnEnded', 'renderQueue', 'editQueued', 'syncQueueBtn',
  ];
  const Q = vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'queue.js' });
  return { Q, ctx, strip, button, input, calls };
}

const msg = (text, files, refs) => ({ text, files: files || [], refs: refs || [] });

/* A turn running in `threadId`, and the same turn ending (as finishLive does:
 * the liveTurn is gone from `state.live` before the queue is asked). */
function running(ctx, threadId) {
  const live = { threadId, activity: [] };
  ctx.state.live.set(threadId, live);
  return live;
}
function ended(Q, ctx, live, how) {
  ctx.state.live.delete(live.threadId);
  Object.assign(live, how || {});
  if (live.threadId === ctx.state.activeId) Q.renderQueue();   // syncComposer's part
  Q.queueTurnEnded(live);
}

const labelOf = (strip) => strip.byClass('queue-label')[0].textContent;
const rowsOf = (strip) => strip.byClass('queue-text').map((r) => r.textContent);

/* -------------------------------- harness -------------------------------- */

let failures = 0;
function section(title) { console.log(title); }
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

section('queueing');

check('a message sent mid-turn waits in the strip and marks the sidebar', () => {
  const { Q, ctx, strip, calls } = load();
  running(ctx, 't1');
  Q.enqueueMessage('t1', msg('add tests'));
  eq(Q.queuedCount('t1'), 1, 'queued');
  eq(strip.hidden, false, 'strip shown');
  eq(labelOf(strip), 'queue.waiting', 'says it will be sent');
  eq(strip.byClass('queue-go').length, 0, 'nothing to press while the turn runs');
  eq(rowsOf(strip).join('|'), 'add tests', 'the message');
  eq(calls.sidebar, 1, 'sidebar re-rendered');
  eq(calls.started.length, 0, 'not sent yet');
});

check('a message queued in another chat leaves the open chat\'s strip alone', () => {
  const { Q, ctx, strip } = load();
  running(ctx, 't2');
  Q.enqueueMessage('t2', msg('elsewhere'));
  eq(strip.hidden, true, 'nothing shown here');
  eq(Q.queuedCount('t2'), 1, 'queued there');
});

check('a message that is only attachments is listed by its files', () => {
  const { Q, ctx, strip } = load();
  running(ctx, 't1');
  Q.enqueueMessage('t1', msg('', ['C:\\shots\\a.png', 'C:\\shots\\b.png']));
  eq(rowsOf(strip)[0], 'a.png, b.png', 'file names');
});

section('when the turn ends');

check('a finished turn sends the next message — one per turn, in order', () => {
  const { Q, ctx, strip, calls } = load();
  const first = running(ctx, 't1');
  Q.enqueueMessage('t1', msg('one'));
  Q.enqueueMessage('t1', msg('two'));
  ended(Q, ctx, first);
  eq(calls.started.length, 1, 'one turn started');
  eq(calls.started[0].msg.text, 'one', 'the first typed goes first');
  eq(calls.started[0].threadId, 't1', 'in its own chat');
  eq(Q.queuedCount('t1'), 1, 'the other still waits');
  ended(Q, ctx, ctx.state.live.get('t1'));
  eq(calls.started[1].msg.text, 'two', 'then the second');
  eq(Q.queuedCount('t1'), 0, 'queue empty');
  ended(Q, ctx, ctx.state.live.get('t1'));
  eq(calls.started.length, 2, 'nothing left to send');
  eq(strip.hidden, true, 'strip gone');
});

check('a stopped turn holds the queue, and "Send now" releases it', () => {
  const { Q, ctx, strip, calls } = load();
  const live = running(ctx, 't1');
  Q.enqueueMessage('t1', msg('now commit it'));
  ended(Q, ctx, live, { stopped: true });
  eq(calls.started.length, 0, 'not sent');
  eq(Q.queuedCount('t1'), 1, 'still queued');
  eq(labelOf(strip), 'queue.held', 'says it is on hold');
  eq(calls.tips.length, 0, 'no tip for a chat you are looking at');
  strip.byClass('queue-go')[0].onclick();
  eq(calls.started.length, 1, 'sent on request');
  eq(calls.started[0].opts.follow, true, 'and the feed follows it');
});

check('a failed turn holds the queue too', () => {
  const { Q, ctx, calls } = load();
  const live = running(ctx, 't1');
  Q.enqueueMessage('t1', msg('next'));
  ended(Q, ctx, live, { failed: true });
  eq(calls.started.length, 0, 'not sent');
  eq(Q.queuedCount('t1'), 1, 'still queued');
});

check('a chat you are not looking at still sends its queue', () => {
  const { Q, ctx, calls } = load();
  const live = running(ctx, 't2');
  live.activity = [{ id: 'a1' }];
  Q.enqueueMessage('t2', msg('carry on'));
  ended(Q, ctx, live);
  eq(calls.started.length, 1, 'sent');
  eq(calls.started[0].threadId, 't2', 'to that chat');
  eq(calls.started[0].opts.activity, live.activity, 'its activity list carries over');
  eq(calls.tips.length, 0, 'nothing to say');
});

check('…and says so when that chat\'s turn was stopped instead', () => {
  const { Q, ctx, calls } = load();
  const live = running(ctx, 't2');
  Q.enqueueMessage('t2', msg('carry on'));
  ended(Q, ctx, live, { stopped: true });
  eq(calls.started.length, 0, 'not sent');
  eq(calls.tips.length, 1, 'one tip');
  eq(calls.tips[0].body.includes('Refactor'), true, 'names the chat');
  calls.tips[0].actions[0].run(() => {});
  eq(calls.opened[0], 't2', 'its button opens the chat');
});

check('an answer picked on a question card goes before the queue', () => {
  const { Q, ctx, calls } = load();
  const live = running(ctx, 't1');
  Q.enqueueMessage('t1', msg('later'));
  ctx.pendingAnswer = 'Option B';
  ended(Q, ctx, live);
  eq(calls.started.length, 0, 'the queue waits for the answer\'s turn');
  ctx.pendingAnswer = null;
  ended(Q, ctx, running(ctx, 't1'));
  eq(calls.started[0].msg.text, 'later', 'and follows it');
});

check('nothing is sent while a turn is still running', () => {
  const { Q, ctx, calls } = load();
  running(ctx, 't1');
  Q.enqueueMessage('t1', msg('wait'));
  Q.sendNextQueued('t1');
  eq(calls.started.length, 0, 'not sent');
  eq(Q.queuedCount('t1'), 1, 'still queued');
});

section('changing your mind');

check('a queued message can be dropped', () => {
  const { Q, ctx, strip } = load();
  running(ctx, 't1');
  Q.enqueueMessage('t1', msg('one'));
  Q.enqueueMessage('t1', msg('two'));
  strip.byClass('x')[0].onclick();
  eq(rowsOf(strip).join('|'), 'two', 'the other stays');
  strip.byClass('x')[0].onclick();
  eq(strip.hidden, true, 'strip hidden once empty');
  eq(Q.queuedCount('t1'), 0, 'queue empty');
});

check('editing pulls it back into the box, after anything already typed', () => {
  const { Q, ctx, strip, input, calls } = load();
  running(ctx, 't1');
  const refs = [{ id: 't2', title: 'Refactor', token: '#Refactor' }];
  Q.enqueueMessage('t1', msg('see #Refactor', ['C:\\a.png'], refs));
  input.value = 'half a thought  ';
  strip.byClass('edit')[0].onclick();
  eq(input.value, 'half a thought\nsee #Refactor', 'text restored');
  eq(Q.queuedCount('t1'), 0, 'no longer queued');
  eq(calls.refs[0], refs, 'its references come back');
  eq(calls.files.join(','), 'C:\\a.png', 'and its attachments');
  eq(calls.drafts[0].text, input.value, 'kept as the chat\'s draft');
});

check('a deleted chat takes its queue with it', () => {
  const { Q, ctx } = load();
  running(ctx, 't2');
  Q.enqueueMessage('t2', msg('gone'));
  Q.dropQueue('t2');
  eq(Q.queuedCount('t2'), 0, 'forgotten');
});

section('across a restart');

check('a queue survives closing the app, and comes back on hold', () => {
  const storage = memoryStorage();
  const before = load(storage);
  running(before.ctx, 't1');
  before.Q.enqueueMessage('t1', msg('remember me'));

  const after = load(storage);            // a fresh start: nothing is running
  eq(after.Q.queuedCount('t1'), 1, 'still there');
  after.Q.renderQueue();
  eq(labelOf(after.strip), 'queue.held', 'held — nothing will send it by itself');
  eq(after.calls.started.length, 0, 'and it was not sent behind your back');
});

section('the queue button');

check('it shows only mid-turn, once there is something to queue', () => {
  const { Q, ctx, button, input } = load();
  Q.syncQueueBtn();
  eq(button.hidden, true, 'idle, empty');
  input.value = 'hello';
  Q.syncQueueBtn();
  eq(button.hidden, true, 'idle: Enter just sends');
  ctx.state.streaming = true;
  Q.syncQueueBtn();
  eq(button.hidden, false, 'mid-turn with text');
  input.value = '$ dir';
  Q.syncQueueBtn();
  eq(button.hidden, true, 'a shell line is not a message');
  input.value = '';
  ctx.hasComposerAttachments = () => true;
  Q.syncQueueBtn();
  eq(button.hidden, false, 'an attachment alone can be queued');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
