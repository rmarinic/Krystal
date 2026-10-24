/* Tests for the command palette (src/app/palette.js): how typed letters match a
 * name, how matches rank, and which actions are on offer when.
 *
 * Same approach as the other frontend tests: the file runs in a vm context that
 * holds the globals it expects from its siblings.
 *
 * Run: node tests/palette.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function button(visible = true) {
  return { hidden: !visible, disabled: false, offsetParent: visible ? {} : null, clicks: 0, click() { this.clicks++; } };
}

function load(over = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'palette.js'), 'utf8');
  const els = {
    compactBtn: button(), clearBtn: button(), branchBtn: button(), hintBtn: button(),
    activityBtn: button(false), tasksBtn: button(), artifactsBtn: button(), runBtn: button(false),
  };
  const ctx = Object.assign({
    els,
    state: {
      project: { path: 'G:\\work\\alpha', name: 'alpha' },
      projects: [{ path: 'G:\\work\\alpha', name: 'alpha' }, { path: 'G:\\work\\beta', name: 'beta' }],
      threads: [{ id: 't1', title: 'Sažetak sastanka', updatedAt: null }, { id: 't2', title: 'Release notes', updatedAt: null }],
      activeId: 't1',
    },
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    stampLabel: () => '',
    basename: (p) => String(p).split(/[\\/]/).pop(),
    icon: (n) => `[${n}]`,
    window: { I18N: { getLang: () => 'en', setLang() {} } },
    console,
  }, over);
  const P = vm.runInNewContext(`${src}\n;({ paletteMatch, paletteFold, paletteItems })`, ctx, { filename: 'palette.js' });
  return { P, ctx, els };
}

const steps = [];
let failed = 0;
function check(name, fn) {
  steps.push(async () => {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  });
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

check('letters in order match, even with others between them', () => {
  const { P } = load();
  eq(!!P.paletteMatch('Compact this conversation', 'cmp'), true);
  eq(!!P.paletteMatch('Compact this conversation', 'pmc'), false, 'out of order');
  eq(!!P.paletteMatch('Compact', 'compactx'), false, 'a letter that is not there');
});

check('case and diacritics are ignored, both ways', () => {
  const { P } = load();
  eq(!!P.paletteMatch('Sažmi ovaj razgovor', 'sazmi'), true, 'typed without the caron');
  eq(!!P.paletteMatch('Đurđevak', 'durd'), true, 'đ, which has no decomposition');
  eq(!!P.paletteMatch('Release notes', 'RELEASE'), true);
  eq(P.paletteFold('Čćžšđ'), 'cczsd');
});

check('the matched letters are marked on the label as written', () => {
  const { P } = load();
  eq(P.paletteMatch('Sažmi', 'saz').html, '<mark>S</mark><mark>a</mark><mark>ž</mark>mi');
  eq(P.paletteMatch('a<b', 'b').html, 'a&lt;<mark>b</mark>', 'the rest is escaped');
});

check('a name that starts with what you typed ranks above one that only contains it', () => {
  const { P } = load();
  const start = P.paletteMatch('Notes for release', 'notes').score;
  const inside = P.paletteMatch('Release notes', 'notes').score;
  const scattered = P.paletteMatch('No time to settle', 'notes').score;
  eq(start < inside, true, 'prefix first');
  eq(inside < scattered, true, 'then a whole run, then scattered letters');
});

check('only the actions whose button could be pressed are offered', () => {
  const { P } = load();
  const labels = P.paletteItems().map((i) => i.label);
  eq(labels.includes('palette.compact'), true);
  eq(labels.includes('palette.activity'), false, 'Activity is hidden');
  eq(labels.includes('palette.run'), false, 'so is Run');
  eq(labels.includes('palette.instructions'), true, 'a chat is open');
});

check('chats of this project are listed, the open one flagged; other projects too', () => {
  const { P } = load();
  const items = P.paletteItems();
  const chats = items.filter((i) => i.group === 'chats');
  eq(chats.length, 2);
  eq(chats[0].current, true, 'the open chat');
  const projects = items.filter((i) => i.group === 'projects').map((i) => i.label);
  eq(projects.join(), 'beta', 'the one you are in is not offered');
});

check('on the project list there are no chats and no chat actions', () => {
  const { P, ctx } = load();
  ctx.state.project = null;
  ctx.state.activeId = null;
  const items = P.paletteItems();
  eq(items.some((i) => i.group === 'chats'), false);
  eq(items.some((i) => i.label === 'palette.newChat' || i.label === 'palette.instructions'), false);
  eq(items.filter((i) => i.group === 'projects').length, 2, 'every project');
});

check('an action runs by pressing its button', () => {
  const { P, els } = load();
  P.paletteItems().find((i) => i.label === 'palette.compact').run();
  eq(els.compactBtn.clicks, 1);
});

(async () => {
  for (const step of steps) await step();
  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exitCode = failed ? 1 : 0;
})();
