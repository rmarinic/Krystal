/* Tests for "Try harder" (src/app/harder.js): which effort comes next, when the
 * button is offered, and what a click does — raise the chat's effort, then send
 * the "another, more careful pass" message; nothing is sent if the raise fails.
 *
 * Run: node tests/harder.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Just enough DOM: messages in a feed, each with a class list and children.
function fakeEl(className) {
  const el = {
    className, children: [], dataset: {}, parentNode: null, disabled: false, innerHTML: '', title: '',
    classList: { contains: (c) => el.className.split(' ').includes(c) },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el); el.parentNode = null; },
  };
  return el;
}
function all(root) { return root.children.flatMap((c) => [c, ...all(c)]); }
function fakeFeed() {
  const feed = fakeEl('feed');
  feed.querySelectorAll = (sel) => all(feed).filter((e) => e.classList.contains(sel.slice(1)));
  feed.querySelector = (sel) => feed.querySelectorAll(sel)[0] || null;
  return feed;
}

function load({ effort = 'high', failSet = false } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'harder.js'), 'utf8');
  const calls = { setEffort: [], turns: [], tips: [] };
  const picker = { v: effort, getValue() { return this.v; }, set(v) { this.v = v; } };
  const ctx = {
    els: { feed: fakeFeed() },
    state: { activeId: 't1', live: new Map(), efforts: EFFORTS.map((id) => ({ id })), defaultEffort: 'high' },
    effortSel: picker,
    api: {
      setEffort: async (id, e) => { calls.setEffort.push([id, e]); if (failSet) throw new Error('nope'); },
    },
    startTurn: (id, msg, opts) => calls.turns.push({ id, msg, opts }),
    showTip: (t) => calls.tips.push(t),
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    icon: (n) => `<svg ${n}>`,
    escapeHtml: (s) => s,
    document: { createElement: () => fakeEl('') },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.calls = calls;
  ctx.picker = picker;
  return ctx;
}

function addMsg(ctx, cls) { return ctx.els.feed.appendChild(fakeEl('msg ' + cls)); }

let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + name),
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); },
  ));
}

const h = load();

test('each effort steps to the one above it, and the top has nowhere to go', () => {
  assert.strictEqual(h.nextEffort('high', EFFORTS), 'xhigh');
  assert.strictEqual(h.nextEffort('xhigh', EFFORTS), 'max');
  assert.strictEqual(h.nextEffort('low', EFFORTS), 'medium');
  assert.strictEqual(h.nextEffort('max', EFFORTS), null);
  assert.strictEqual(h.nextEffort('turbo', EFFORTS), null, 'an id the list does not know');
});

test('only a finished reply of Claude\'s, below the top step, is offered it', () => {
  const offer = (o) => h.harderOffer({ last: { role: 'assistant', shell: false }, live: false, effort: 'high', efforts: EFFORTS, ...o });
  assert.strictEqual(offer({}), 'xhigh');
  assert.strictEqual(offer({ live: true }), null, 'never while a turn runs');
  assert.strictEqual(offer({ last: { role: 'user' } }), null, 'your message has no answer yet');
  assert.strictEqual(offer({ last: { role: 'assistant', shell: true } }), null, 'a $ run is not Claude\'s answer');
  assert.strictEqual(offer({ last: null }), null, 'an empty chat');
  assert.strictEqual(offer({ effort: 'max' }), null, 'already at the top');
});

test('the button sits under the latest reply only, and goes when it no longer fits', () => {
  const c = load();
  const first = addMsg(c, 'assistant');
  addMsg(c, 'user');
  const last = addMsg(c, 'assistant');
  c.harderSync();
  const btns = c.els.feed.querySelectorAll('.try-harder');
  assert.strictEqual(btns.length, 1);
  assert.strictEqual(btns[0].parentNode, last);
  assert.strictEqual(btns[0].dataset.to, 'xhigh');
  assert.ok(!first.children.length);
  c.harderSync();
  assert.strictEqual(c.els.feed.querySelectorAll('.try-harder').length, 1, 'syncing again adds no second one');
  // A turn starts: gone.
  c.state.live.set('t1', {});
  c.harderSync();
  assert.strictEqual(c.els.feed.querySelectorAll('.try-harder').length, 0);
  // At the top step: never offered.
  c.state.live.clear();
  c.picker.v = 'max';
  c.harderSync();
  assert.strictEqual(c.els.feed.querySelectorAll('.try-harder').length, 0);
});

test('a click raises the chat\'s effort, then asks for another pass', async () => {
  const c = load();
  addMsg(c, 'assistant');
  c.harderSync();
  const btn = c.els.feed.querySelector('.try-harder');
  await c.tryHarder(btn);
  assert.deepStrictEqual(c.calls.setEffort, [['t1', 'xhigh']]);
  assert.strictEqual(c.picker.v, 'xhigh', 'the picker shows the new effort');
  assert.strictEqual(c.calls.turns.length, 1);
  assert.strictEqual(c.calls.turns[0].id, 't1');
  assert.strictEqual(c.calls.turns[0].msg.text, 'harder.msg');
  assert.strictEqual(c.els.feed.querySelectorAll('.try-harder').length, 0);
});

test('if the effort can\'t be raised, nothing is sent and you are told', async () => {
  const c = load({ failSet: true });
  addMsg(c, 'assistant');
  c.harderSync();
  const btn = c.els.feed.querySelector('.try-harder');
  await c.tryHarder(btn);
  assert.strictEqual(c.calls.turns.length, 0);
  assert.strictEqual(c.picker.v, 'high');
  assert.strictEqual(btn.disabled, false, 'it can be tried again');
  assert.strictEqual(c.calls.tips.length, 1);
});

test('nothing happens while a turn is already running', async () => {
  const c = load();
  addMsg(c, 'assistant');
  c.harderSync();
  const btn = c.els.feed.querySelector('.try-harder');
  c.state.live.set('t1', {});
  await c.tryHarder(btn);
  assert.strictEqual(c.calls.setEffort.length, 0);
  assert.strictEqual(c.calls.turns.length, 0);
});

Promise.all(pending).then(() => {
  if (failed) { console.log(`harder: ${failed} failed`); process.exit(1); }
  console.log('harder: all passed');
});
