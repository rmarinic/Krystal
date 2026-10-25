/* Tests for mirroring a turn started from outside (src/app/mirror.js).
 *
 * The backend (src-tauri/src/remote/) tells the window about a turn it didn't
 * start with three events: `remote-turn-start`, one `remote-turn` per event of
 * the turn, and `remote-turn-end`. Its own tests (and the relay's, in
 * cloud/relay.rs) hold those payloads; this one holds mirror.js to them:
 *
 *   - the event names here are the ones remote/mod.rs emits;
 *   - a turn replays through `handleLiveEvent` with the liveTurn `send()` builds;
 *   - its late title (after `done`) still reaches the chat, and nothing else
 *     after the turn has landed does (the stream's own closing `error` would
 *     land it twice);
 *   - a turn that ends without `done` or `error` still ends;
 *   - one turn's late words can't land on the next turn in the same chat.
 *
 * mirror.js runs in a vm context with stubs for the globals it borrows from its
 * siblings. `handleLiveEvent` and `finishLive` are thin fakes that do what the
 * real ones do with the turn's bookkeeping.
 *
 * Run: node tests/mirror.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const mirrorSrc = fs.readFileSync(path.join(root, 'src', 'app', 'mirror.js'), 'utf8');
const remoteSrc = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'remote', 'mod.rs'), 'utf8');

function load({ activeId = 't1' } = {}) {
  const handlers = {};
  const seen = { handled: [], finished: [], bubbles: [], starters: 0, typers: 0, synced: 0, threads: 0 };
  const state = { activeId, live: new Map(), activity: [], view: 'threads', project: { path: 'C:/p' } };
  const ctx = {
    state,
    stickToBottom: false,
    listen: (name, fn) => { handlers[name] = fn; },
    handleLiveEvent: (live, msg) => {
      seen.handled.push(msg);
      if (msg.type === 'done' || msg.type === 'error') ctx.finishLive(live);
    },
    finishLive: (live) => {
      if (live.finalized) return;
      live.finalized = true;
      state.live.delete(live.threadId);
      seen.finished.push(live.threadId);
    },
    liveTurnStarted: () => {},
    clearStarters: () => { seen.starters += 1; },
    hideSuggestion: () => {},
    appendMessage: (role, text) => { seen.bubbles.push([role, text]); },
    mascotTurnBegan: () => {},
    attachLiveTyper: () => { seen.typers += 1; },
    scrollFeed: () => {},
    syncComposer: () => { seen.synced += 1; },
    renderSidebar: () => {},
    loadThreads: () => { seen.threads += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(mirrorSrc, ctx, { filename: 'mirror.js' });
  // As Tauri delivers them: `{ payload }`.
  const emit = (name, payload) => {
    assert.ok(handlers[name], `mirror.js doesn't listen for ${name}`);
    handlers[name]({ payload });
  };
  const start = (turn, threadId = 't1', text = 'hi') => emit('remote-turn-start', { threadId, turn, text });
  const event = (turn, msg, threadId = 't1') => emit('remote-turn', { threadId, turn, raw: JSON.stringify(msg) });
  const end = (turn, threadId = 't1') => emit('remote-turn-end', { threadId, turn });
  return { ctx, state, seen, handlers, emit, start, event, end };
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('mirror.js');

test('listens for exactly the events remote/mod.rs emits', () => {
  const emitted = [...remoteSrc.matchAll(/^const EV_\w+: &str = "([a-z-]+)";/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual(emitted, ['remote-threads-changed', 'remote-turn', 'remote-turn-end', 'remote-turn-start']);
  const { handlers } = load();
  assert.deepStrictEqual(Object.keys(handlers).sort(), emitted);
});

test('a turn on screen paints like one typed here, event by event', () => {
  const t = load();
  t.start('a', 't1', 'from the phone');
  const live = t.state.live.get('t1');
  assert.ok(live && live.remote, 'a liveTurn for the chat');
  assert.strictEqual(live.activity, t.state.activity, 'on screen it feeds the Activity panel');
  assert.deepStrictEqual(t.seen.bubbles, [['user', 'from the phone']]);
  assert.strictEqual(t.seen.typers, 1);
  assert.strictEqual(t.seen.starters, 1, "an empty chat's starting points go");
  assert.strictEqual(t.ctx.stickToBottom, true);
  t.event('a', { type: 'token', text: 'Hel' });
  t.event('a', { type: 'tool', id: 'x', name: 'Read' });
  assert.deepStrictEqual(t.seen.handled.map((m) => m.type), ['token', 'tool']);
});

test('off screen it still runs, without painting', () => {
  const t = load({ activeId: 'other' });
  t.start('a', 't1');
  assert.ok(t.state.live.has('t1'));
  assert.strictEqual(t.state.live.get('t1').activity === t.state.activity, false);
  assert.deepStrictEqual(t.seen.bubbles, []);
  assert.strictEqual(t.seen.typers, 0);
});

test("the first reply's late title still reaches the chat; nothing else after it lands", () => {
  const t = load();
  t.start('a');
  t.event('a', { type: 'done', text: 'Hello' });
  assert.deepStrictEqual(t.seen.finished, ['t1']);
  t.event('a', { type: 'title', title: 'A better name' });
  t.event('a', { type: 'end' });
  t.end('a');
  assert.deepStrictEqual(t.seen.handled.map((m) => m.type), ['done', 'title']);
  assert.deepStrictEqual(t.seen.finished, ['t1'], 'finished once');
  t.event('a', { type: 'title', title: 'too late' });
  assert.strictEqual(t.seen.handled.length, 2, 'after the end the turn is forgotten');
});

test("a failed turn fails once, not again on the stream's closing error", () => {
  const t = load();
  t.start('a');
  t.event('a', { type: 'error', message: 'Overloaded' });
  t.event('a', { type: 'error', message: 'Overloaded' });
  t.end('a');
  assert.deepStrictEqual(t.seen.handled.map((m) => m.type), ['error']);
  assert.deepStrictEqual(t.seen.finished, ['t1']);
});

test('a turn that never said done or error still ends', () => {
  const t = load();
  t.start('a');
  t.event('a', { type: 'token', text: 'x' });
  t.event('a', { type: 'end' });
  assert.ok(t.state.live.has('t1'), 'the closing `end` alone is just an event');
  t.end('a');
  assert.ok(!t.state.live.has('t1'));
  assert.deepStrictEqual(t.seen.finished, ['t1']);
});

test("one turn's late words don't land on the next in the same chat", () => {
  const t = load();
  t.start('a');
  t.event('a', { type: 'done', text: 'one' });
  t.start('b', 't1', 'again');                       // before `a` has ended
  const second = t.state.live.get('t1');
  t.event('a', { type: 'error', message: 'late' });   // `a`'s closing frame
  t.end('a');
  assert.ok(t.state.live.get('t1') === second && !second.finalized, 'the second turn runs on');
  t.event('b', { type: 'done', text: 'two' });
  t.end('b');
  assert.deepStrictEqual(t.seen.handled.map((m) => m.text || m.message), ['one', 'two']);
});

test('a chat already streaming here is left to its own turn', () => {
  const t = load();
  const own = { threadId: 't1', finalized: false };
  t.state.live.set('t1', own);
  t.start('a');
  t.event('a', { type: 'token', text: 'x' });
  t.end('a');
  assert.strictEqual(t.state.live.get('t1'), own);
  assert.deepStrictEqual(t.seen.handled, []);
  assert.deepStrictEqual(t.seen.finished, []);
});

test('a payload without a turn id is ignored, not half-tracked', () => {
  const t = load();
  t.emit('remote-turn-start', { threadId: 't1', text: 'hi' });
  assert.ok(!t.state.live.has('t1'));
});

test('a chat created from outside refreshes the open project only', () => {
  const t = load();
  t.emit('remote-threads-changed', { project: 'C:/elsewhere' });
  assert.strictEqual(t.seen.threads, 0);
  t.emit('remote-threads-changed', { project: 'C:/p' });
  assert.strictEqual(t.seen.threads, 1);
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
