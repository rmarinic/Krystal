/* Tests for the usage limits (src/app/usage.js): how a turn's figures fold
 * into what the endpoint said, how a passed reset reads, and the warning levels.
 *
 * Same approach as the other frontend tests: the file runs in a vm context that
 * holds the globals it expects from its siblings.
 *
 * Run: node tests/usage.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function load(extra) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'usage.js'), 'utf8');
  const ctx = {
    els: {}, state: {},
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    escapeHtml: (s) => String(s),
    icon: (n) => `[${n}]`,
    showTip: () => {},
    motionOK: () => false,
    replayClass: () => {},
    window: { I18N: { getLang: () => 'en' } },
    settingsTab: null, settingsPanelEl: null,
    console, Date, Math,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const u = load();
const now = Math.floor(Date.now() / 1000);
const endpoint = [
  { kind: 'session', label: null, pct: 8, resetsAt: now + 3600, severity: 'normal' },
  { kind: 'weekly', label: null, pct: 67, resetsAt: now + 86400 * 2, severity: 'normal' },
  { kind: 'weekly_scoped', label: 'Fable', pct: 0, resetsAt: now + 86400 * 2, severity: 'normal' },
];

test('a turn replaces the windows it names and keeps the rest', () => {
  const turn = [
    { kind: 'session', label: null, pct: 12, resetsAt: now + 3500, severity: 'normal' },
    { kind: 'weekly', label: null, pct: 68, resetsAt: now + 86400 * 2, severity: 'normal' },
  ];
  const m = u.mergeUsageWindows(endpoint, turn);
  assert.strictEqual(m.length, 3);
  assert.strictEqual(m.find((w) => w.kind === 'session').pct, 12);
  assert.strictEqual(m.find((w) => w.kind === 'weekly_scoped').label, 'Fable');
});

test('a scoped window does not overwrite the all-models week', () => {
  const m = u.mergeUsageWindows(endpoint, [{ kind: 'weekly_scoped', label: 'Opus', pct: 5 }]);
  assert.strictEqual(m.length, 4);
  assert.strictEqual(m.find((w) => w.kind === 'weekly' && !w.label).pct, 67);
});

test('merging into nothing works', () => {
  assert.strictEqual(u.mergeUsageWindows(null, endpoint).length, 3);
});

test('a window past its reset reads as empty', () => {
  assert.strictEqual(u.windowFrac({ kind: 'session', pct: 90, resetsAt: now - 5 }), 0);
  assert.strictEqual(u.windowFrac({ kind: 'session', pct: 90, resetsAt: now + 5 }), 0.9);
  assert.strictEqual(u.windowFrac(null), null);
});

test('levels: thresholds, and a refused window is high whatever the number', () => {
  assert.strictEqual(u.usageLevel(0.5), 'ok');
  assert.strictEqual(u.usageLevel(0.85), 'warn');
  assert.strictEqual(u.usageLevel(0.97), 'high');
  assert.strictEqual(u.usageLevel(0.4, 'limited'), 'high');
});

test('session reset is a countdown, a weekly one a day and time', () => {
  assert.ok(u.windowResetText(endpoint[0]).startsWith('usage.resetIn'));
  assert.ok(u.windowResetText(endpoint[1]).startsWith('usage.resetAt'));
  assert.strictEqual(u.windowResetText({ kind: 'weekly', resetsAt: null }), '');
});

test('alert: the worse of session and week, and which ones are close', () => {
  const s = (pct, severity) => ({ kind: 'session', pct, resetsAt: now + 3600, severity });
  const wk = (pct, severity) => ({ kind: 'weekly', pct, resetsAt: now + 86400, severity });
  assert.strictEqual(u.usageAlert(s(40), wk(60)).level, '');
  assert.strictEqual(u.usageAlert(null, null).level, '');
  const a = u.usageAlert(s(85), wk(60));
  assert.strictEqual(a.level, 'warn');
  assert.strictEqual(a.hot.map((w) => w.kind).join(), 'session');
  assert.strictEqual(u.usageAlert(s(85), wk(97)).level, 'high');
  assert.strictEqual(u.usageAlert(s(10), wk(20, 'limited')).level, 'high');
  // A session past its reset is empty again, so it no longer warns.
  assert.strictEqual(u.usageAlert({ kind: 'session', pct: 99, resetsAt: now - 5 }, wk(10)).level, '');
});

// A stand-in for the ring button: enough DOM for paintUsageMark.
function fakeRing() {
  const kids = [];
  const btn = {
    appendChild: (el) => { kids.push(el); el.remove = () => kids.splice(kids.indexOf(el), 1); },
    querySelector: (sel) => kids.find((k) => sel === '.' + k.className.split(' ')[0]) || null,
    kids,
  };
  return btn;
}
function fakeDocument() {
  return { createElement: () => ({ className: '', dataset: {}, textContent: '', title: '' }) };
}

test('the ring carries a mark only while a limit is close, coloured by the worse', () => {
  const btn = fakeRing();
  const r = load({ ctxRing: { btn }, document: fakeDocument() });
  r.usageFromTurn([{ kind: 'session', pct: 50, resetsAt: now + 3600 }]);
  assert.strictEqual(btn.kids.length, 0);
  r.usageFromTurn([{ kind: 'session', pct: 86, resetsAt: now + 3600 }]);
  assert.strictEqual(btn.kids.length, 1);
  assert.strictEqual(btn.kids[0].className, 'ctx-alert lvl-warn');
  assert.ok(btn.kids[0].title.includes('usage.5h.label 86%'));
  r.usageFromTurn([{ kind: 'weekly', pct: 96, resetsAt: now + 86400 }]);
  assert.strictEqual(btn.kids.length, 1);
  assert.strictEqual(btn.kids[0].className, 'ctx-alert lvl-high');
  r.usageFromTurn([
    { kind: 'session', pct: 3, resetsAt: now + 3600 },
    { kind: 'weekly', pct: 40, resetsAt: now + 86400 },
  ]);
  assert.strictEqual(btn.kids.length, 0);
});

test('crossing into warning raises a toast once, and a tip when toasts are off', () => {
  const notices = [], tips = [];
  let toasts = true;
  const r = load({
    showNotice: (n) => { if (!toasts) return false; notices.push(n); return true; },
    showTip: (t) => tips.push(t),
  });
  r.usageFromTurn([{ kind: 'session', pct: 82, resetsAt: now + 3600 }]);
  r.usageFromTurn([{ kind: 'session', pct: 83, resetsAt: now + 3600 }]);
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].tone, 'warn');
  assert.strictEqual(notices[0].run, r.openUsageSettings);
  toasts = false;
  r.usageFromTurn([{ kind: 'session', pct: 96, resetsAt: now + 3600 }]);
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].cls, 'high');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nusage: all passed');
