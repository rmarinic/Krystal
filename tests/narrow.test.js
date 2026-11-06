/* Tests for the phone layout's drawer (src/app/narrow.js, css/narrow.css): the
 * ☰ button opens and shuts it, the scrim and Esc shut it, choosing where to go
 * in it (a chat, new chat, a foot row) shuts it, typing in its search or
 * flipping Saved doesn't, and a window grown wide drops it. Also that the
 * stylesheet keeps the drawer off-screen until it is open, inside the one
 * breakpoint, and that no rule hides the sidebar outright on a narrow screen
 * any more (that left a phone with no way to its chats).
 *
 * Run: node tests/narrow.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// Just enough DOM: elements with a parent, `closest` by id / class / tag, and listeners.
function el(tag, { id = '', cls = '', attrs = {} } = {}, parent = null) {
  const e = {
    tag, id, cls, attrs: { ...attrs }, parent, handlers: {},
    setAttribute(k, v) { e.attrs[k] = v; },
    addEventListener(type, fn) { (e.handlers[type] = e.handlers[type] || []).push(fn); },
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((s) => {
        if (s.startsWith('#')) return e.id === s.slice(1);
        const m = /^(\w+)?(?:\[([\w-]+)\])?$/.exec(s);
        if (!m) return false;
        return (!m[1] || e.tag === m[1]) && (!m[2] || m[2] in e.attrs);
      });
    },
    closest(sel) { for (let n = e; n; n = n.parent) if (n.matches(sel)) return n; return null; },
  };
  return e;
}
const fire = (target, type, ev = {}) => (target.handlers[type] || []).forEach((fn) => fn({ target, ...ev }));

function load() {
  const classes = new Set();
  const doc = el('document');
  const win = el('window');
  const timers = [];
  const sidebar = el('aside', { cls: 'sidebar' });
  const ctx = {
    els: { drawerBtn: el('button', { id: 'drawer-btn' }), drawerScrim: el('div', { id: 'drawer-scrim' }), sidebar },
    document: Object.assign(doc, { body: { classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    } } }),
    window: Object.assign(win, { innerWidth: 390 }),
    setTimeout: (fn) => timers.push(fn),
  };
  vm.createContext(ctx);
  vm.runInContext(src('app/narrow.js'), ctx, { filename: 'narrow.js' });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { ctx, open: () => classes.has('drawer-open'), sidebar, doc, win, flush };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

check('☰ opens the drawer and shuts it again; aria-expanded follows', () => {
  const t = load();
  fire(t.ctx.els.drawerBtn, 'click');
  assert.ok(t.open());
  assert.equal(t.ctx.els.drawerBtn.attrs['aria-expanded'], 'true');
  fire(t.ctx.els.drawerBtn, 'click');
  assert.ok(!t.open());
  assert.equal(t.ctx.els.drawerBtn.attrs['aria-expanded'], 'false');
});

check('the scrim and Esc shut it', () => {
  const t = load();
  fire(t.ctx.els.drawerBtn, 'click');
  fire(t.ctx.els.drawerScrim, 'click');
  assert.ok(!t.open());
  fire(t.ctx.els.drawerBtn, 'click');
  fire(t.doc, 'keydown', { key: 'Enter' });
  assert.ok(t.open(), 'another key leaves it open');
  fire(t.doc, 'keydown', { key: 'Escape' });
  assert.ok(!t.open());
});

check('choosing a chat, new chat or a foot row shuts it, after the click has done its work', () => {
  const t = load();
  const list = el('ul', { id: 'thread-list' }, t.sidebar);
  const row = el('li', { attrs: { 'data-tid': 't1' } }, list);
  const title = el('span', {}, row);
  for (const target of [title, el('button', { id: 'new-chat' }, t.sidebar), el('span', {}, el('button', { id: 'tasks-btn' }, t.sidebar))]) {
    fire(t.ctx.els.drawerBtn, 'click');
    fire(t.sidebar, 'click', { target });
    assert.ok(t.open(), 'not shut in the same tick as the click');
    t.flush();
    assert.ok(!t.open(), `shut after choosing ${target.tag}`);
  }
});

check('typing in its search or flipping Saved keeps it open', () => {
  const t = load();
  fire(t.ctx.els.drawerBtn, 'click');
  for (const target of [el('input', { id: 'search' }, t.sidebar), el('button', { id: 'saved-toggle' }, t.sidebar), el('div', {}, t.sidebar)]) {
    fire(t.sidebar, 'click', { target });
    t.flush();
    assert.ok(t.open(), `still open after ${target.id || target.tag}`);
  }
});

check('a window grown wide drops it', () => {
  const t = load();
  fire(t.ctx.els.drawerBtn, 'click');
  t.win.innerWidth = 900;
  fire(t.win, 'resize');
  assert.ok(t.open(), 'a landscape phone keeps it');
  t.win.innerWidth = 1400;
  fire(t.win, 'resize');
  assert.ok(!t.open());
});

check('the stylesheet: the drawer is off-screen until open, inside the breakpoint, and nothing hides the sidebar outright', () => {
  const css = src('css/narrow.css');
  const at = css.indexOf('@media (max-width: 760px), (max-height: 520px) and (max-width: 1100px)');
  assert.ok(at >= 0, 'the breakpoint is there');
  const inside = css.slice(at);
  assert.match(inside, /aside\.sidebar \{[^}]*position: fixed[^}]*transform: translateX\(-105%\)/);
  assert.match(inside, /body\.drawer-open aside\.sidebar \{[^}]*transform: none/);
  assert.match(css.slice(0, at), /\.drawer-btn, \.drawer-scrim \{ display: none; \}/, 'the button is hidden outside it');
  const hidden = fs.readdirSync(path.join(__dirname, '..', 'src', 'css'))
    .filter((f) => /aside\.sidebar\s*\{\s*display:\s*none/.test(src('css/' + f)));
  assert.deepStrictEqual(hidden, [], 'no stylesheet hides the sidebar outright');
});

if (failures) { console.log(`narrow.test.js: ${failures} failed`); process.exit(1); }
console.log('narrow.test.js: ok');
