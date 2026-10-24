/* Tests for the chat visit history behind Ctrl+Q / Ctrl+E / Ctrl+Tab
 * (src/app/hotkeys.js).
 *
 * Same approach as notifications.test.js: the file runs in a vm context holding
 * the globals it expects from its siblings. `openThread` is stubbed the way the
 * real one behaves for this purpose — it fails for a chat that's gone, and notes
 * the visit for one that isn't. What's under test is where each step lands.
 *
 * Run: node tests/hotkeys.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECTS = [
  { id: 'p1', path: 'G:\\work\\alpha', name: 'alpha' },
  { id: 'p2', path: 'G:\\work\\beta', name: 'beta' },
];

function memoryStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

function load(storage) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'hotkeys.js'), 'utf8');
  const calls = { entered: [], opened: [], picker: 0, newChat: 0, settings: [], palette: 0, find: 0 };
  const gone = new Set();
  const ctx = {
    els: { feed: {} },
    state: { activeId: null, project: PROJECTS[0], projects: PROJECTS },
    localStorage: storage || memoryStorage(),
    document: { addEventListener() {}, querySelector: () => null },
    tr: (k) => k,
    escapeHtml: (s) => String(s),
    replayClass() {},
    api: { projects: async () => ({ projects: PROJECTS }) },
    enterProject: async (p) => { calls.entered.push(p.path); ctx.state.project = p; ctx.state.activeId = null; },
    showProjectPicker: () => { calls.picker++; ctx.state.project = null; ctx.state.activeId = null; },
    startNewChat: () => { calls.newChat++; },
    openSettings: (tab) => { calls.settings.push(tab); },
    togglePalette: () => { calls.palette++; },
    openFind: () => { calls.find++; },
    console,
  };
  const H = vm.runInNewContext(
    `${src}\n;({ noteChatVisit, stepChatHistory, toggleRecentChat, shortcutFor, runShortcut,
       list: () => chatHistory.map((e) => e.id).join(), pos: () => chatHistoryPos })`,
    ctx, { filename: 'hotkeys.js' });
  ctx.openThread = async (id) => {
    if (gone.has(id)) throw new Error('no such chat');
    calls.opened.push(id);
    ctx.state.activeId = id;
    H.noteChatVisit(id);
  };
  // Open chats the ordinary way (sidebar clicks), in this project.
  const visit = async (...ids) => { for (const id of ids) await ctx.openThread(id); };
  return { H, ctx, calls, gone, visit };
}

/* -------------------------------- harness -------------------------------- */

let failures = 0;
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

section('back and forward');

check('back walks the chats in the order they were opened, forward returns', async () => {
  const { H, ctx, visit } = load();
  await visit('a', 'b', 'c');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'b', 'one back');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'a', 'two back');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'a', 'nothing further back');
  await H.stepChatHistory(1);
  await H.stepChatHistory(1);
  eq(ctx.state.activeId, 'c', 'forward to the end');
  eq(H.list(), 'a,b,c', 'stepping records nothing');
});

check('re-opening the chat on screen is not a new visit', async () => {
  const { H, visit } = load();
  await visit('a', 'b', 'b', 'b');
  eq(H.list(), 'a,b', 'history');
});

check('opening a chat after stepping back drops what lay ahead', async () => {
  const { H, ctx, visit } = load();
  await visit('a', 'b', 'c');
  await H.stepChatHistory(-1);
  await H.stepChatHistory(-1);
  await visit('d');
  eq(H.list(), 'a,d', 'history');
  await H.stepChatHistory(1);
  eq(ctx.state.activeId, 'd', 'nothing ahead');
});

check('from the project list, back lands on the chat that was left', async () => {
  const { H, ctx, calls, visit } = load();
  await visit('a', 'b');
  H.runShortcut('projects');
  eq(calls.picker, 1, 'picker shown');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'b', 'the chat left, not the one before it');
  eq(ctx.state.project.path, PROJECTS[0].path, 'its project entered again');
});

check('a step into a chat of another project enters that project first', async () => {
  const { H, ctx, calls, visit } = load();
  await visit('a');
  ctx.state.project = PROJECTS[1];
  await visit('x');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'a', 'chat');
  eq(calls.entered.join(), PROJECTS[0].path, 'project entered');
});

check('a deleted chat is skipped and forgotten, in either direction', async () => {
  const { H, ctx, gone, visit } = load();
  await visit('a', 'b', 'c', 'd');
  gone.add('c');
  await H.stepChatHistory(-1);
  eq(ctx.state.activeId, 'b', 'back skips it');
  eq(H.list(), 'a,b,d', 'and forgets it');
  gone.add('d');
  await H.stepChatHistory(1);
  eq(ctx.state.activeId, 'b', 'forward has nowhere left to go');
  eq(H.list(), 'a,b', 'history');
  eq(H.pos(), 1, 'still on b');
});

check('the history survives a restart', async () => {
  const storage = memoryStorage();
  const first = load(storage);
  await first.visit('a', 'b', 'c');
  await first.H.stepChatHistory(-1);
  const second = load(storage);
  eq(second.H.list(), 'a,b,c', 'list');
  await second.H.stepChatHistory(-1);
  eq(second.ctx.state.activeId, 'b', 'back from a fresh start opens the chat closed on');
});

section('Ctrl+Tab');

check('toggles between the last two chats', async () => {
  const { H, ctx, visit } = load();
  await visit('a', 'b', 'c');
  await H.toggleRecentChat();
  eq(ctx.state.activeId, 'b', 'first press');
  await H.toggleRecentChat();
  eq(ctx.state.activeId, 'c', 'second press');
  await H.toggleRecentChat();
  eq(ctx.state.activeId, 'b', 'third press');
});

check('a deleted chat is dropped and the position kept', async () => {
  const { H, ctx, gone, visit } = load();
  await visit('a', 'b', 'c');
  gone.add('b');
  await H.toggleRecentChat();
  eq(ctx.state.activeId, 'c', 'stayed');
  eq(H.list(), 'a,c', 'history');
  await H.toggleRecentChat();
  eq(ctx.state.activeId, 'a', 'next press reaches the one before');
});

section('keys');

check('each combination maps to its shortcut, and nothing else does', () => {
  const k = (code, mods) => Object.assign({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods);
  const ctrl = { ctrlKey: true };
  const { H } = load();
  eq(H.shortcutFor(k('KeyQ', ctrl)), 'back');
  eq(H.shortcutFor(k('KeyE', ctrl)), 'forward');
  eq(H.shortcutFor(k('Tab', ctrl)), 'recent');
  eq(H.shortcutFor(k('KeyW', ctrl)), 'projects');
  eq(H.shortcutFor(k('KeyN', ctrl)), 'newChat');
  eq(H.shortcutFor(k('KeyS', ctrl)), 'help');
  eq(H.shortcutFor(k('KeyK', ctrl)), 'palette');
  eq(H.shortcutFor(k('KeyF', ctrl)), 'find');
  eq(H.shortcutFor(k('KeyQ')), null, 'typing a q');
  eq(H.shortcutFor(k('KeyA', ctrl)), null, 'select all in the composer');
  eq(H.shortcutFor(k('KeyQ', { ctrlKey: true, altKey: true })), null, 'Ctrl+Alt is AltGr on Croatian keyboards');
  eq(H.shortcutFor(k('Tab', { ctrlKey: true, shiftKey: true })), null, 'Ctrl+Shift+Tab');
});

check('project-only shortcuts do nothing on the project list', () => {
  const { H, ctx, calls } = load();
  ctx.state.project = null;
  H.runShortcut('newChat');
  H.runShortcut('projects');
  eq(calls.newChat + calls.picker, 0, 'nothing ran');
  H.runShortcut('help');
  eq(calls.settings.join(), 'keys', 'the list opens anywhere');
  H.runShortcut('palette');
  eq(calls.palette, 1, 'so does the palette');
  H.runShortcut('find');
  eq(calls.find, 1, 'Ctrl+F asks find.js (which stays shut with no chat open)');
});

(async () => {
  for (const step of steps) await step();
  if (failures) {
    console.log(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
})();
