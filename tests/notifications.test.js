/* The bell's bookkeeping (src/app/notifications.js): what is raised, for which
 * chat, and what takes it down again. The script is loaded into a bare context
 * with the handful of globals it reaches for stubbed — no DOM is needed, since
 * the panel only renders while it is open and toasts are switched off here.
 *
 * Run: node tests/notifications.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* A localStorage that outlives one `load()`, so a restart can be played out. */
function memoryStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

const PROJECTS = [
  { id: 1, path: 'G:\\work\\alpha', name: 'alpha' },
  { id: 2, path: 'G:\\work\\beta', name: '' },
];

function load(storage) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'notifications.js'), 'utf8');
  const calls = { entered: [], opened: [], fetched: [] };
  const ctx = {
    els: { notifPop: { hidden: true }, toasts: null, projectList: null, projectScreen: { hidden: true } },
    state: {
      activeId: 't1', live: new Map(), project: PROJECTS[0], projects: PROJECTS,
      threads: [
        { id: 't1', title: 'On screen', cwd: PROJECTS[0].path },
        { id: 't2', title: 'Refactor', cwd: PROJECTS[0].path },
      ],
    },
    localStorage: storage || memoryStorage(),
    document: { querySelectorAll: () => [], addEventListener() {} },
    tr: (k, vars) => (vars ? `${k}(${Object.values(vars).join(',')})` : k),
    escapeHtml: (s) => String(s),
    basename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop(),
    timeLabel: () => '12:00',
    replayClass() {},
    settingOn: () => false,   // no toasts: nothing to draw
    threadAwaitsPermission: () => true,
    api: {
      // A chat in the *other* project — not in `state.threads`.
      thread: async (id) => {
        calls.fetched.push(id);
        if (id !== 't9') throw new Error('no such chat');
        return { id, title: 'Elsewhere', cwd: PROJECTS[1].path };
      },
      projects: async () => ({ projects: PROJECTS }),
    },
    enterProject: async (p) => { calls.entered.push(p.path); ctx.state.project = p; },
    console,
  };
  const exported = [
    'notifyChat', 'dropNotifications', 'dropNotification', 'notificationRetitled',
    'liveTurnStarted', 'turnEndKind', 'openNotification', 'notifProjectName', 'notifSnippet',
    'chatUnread', 'clearUnread', 'forgetNotifs',
  ];
  const N = vm.runInNewContext(
    `${src}\n;({ ${exported.join(', ')}, list: () => notifs })`, ctx, { filename: 'notifications.js' });
  // As the real one does: opening a chat settles what was raised for it.
  ctx.openThread = async (id) => {
    if (id === 'gone') throw new Error('no such chat');
    calls.opened.push(id);
    ctx.state.activeId = id;
    N.dropNotifications(id);
    N.clearUnread(id);
  };
  // The sidebar's repaint (sidebar.js), counted.
  calls.painted = 0;
  ctx.paintUnreadMarks = () => { calls.painted++; };
  return { N, ctx, calls };
}

const turn = (threadId, more) => Object.assign(
  { threadId, cwd: PROJECTS[0].path, title: 'Refactor', events: [] }, more || {});

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

section('raising');

check('nothing is raised for the chat on screen', async () => {
  const { N } = load();
  await N.notifyChat(turn('t1'), 'done', 'All set.');
  eq(N.list().length, 0, 'rows');
});

check('a reply landing elsewhere becomes a row: kind, chat, project, a line of it', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2'), 'done', 'Renamed the **module**\n\nand ran the tests.');
  const [n] = N.list();
  eq(N.list().length, 1, 'rows');
  eq(n.kind, 'done', 'kind');
  eq(n.title, 'Refactor', 'chat');
  eq(N.notifProjectName(n.project), 'alpha', 'project');
  eq(n.text, 'Renamed the module and ran the tests.', 'one readable line');
});

check('one row per chat: a newer event replaces the older one', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2'), 'ask', 'npm install');
  await N.notifyChat(turn('t2'), 'done', 'Installed.');
  await N.notifyChat(turn('t3', { title: 'Other' }), 'failed', 'overloaded');
  eq(N.list().length, 2, 'rows');
  eq(N.list().map((n) => n.threadId + ':' + n.kind).join(' '), 't3:failed t2:done', 'newest first');
});

check('a first turn names its chat as it ends', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2', { title: 'New chat' }), 'done', 'Hi.', 'Greeting');
  eq(N.list()[0].title, 'Greeting', 'title from the done event');
  N.notificationRetitled('t2', 'A better title');
  eq(N.list()[0].title, 'A better title', 'and from the late auto-title');
});

check('a chat in another project is looked up when the turn never noted its folder', async () => {
  const { N, calls } = load();
  await N.notifyChat({ threadId: 't9', events: [] }, 'done', 'Done.');
  eq(calls.fetched.join(), 't9', 'asked the backend');
  eq(N.list()[0].title, 'Elsewhere', 'chat');
  eq(N.notifProjectName(N.list()[0].project), 'beta', 'project named by its folder');
});

check('a turn notes its project when it starts', async () => {
  const { N, calls } = load();
  const here = { threadId: 't2' };
  await N.liveTurnStarted(here);
  eq(here.cwd, PROJECTS[0].path, 'from the sidebar list');
  eq(calls.fetched.length, 0, 'without asking the backend');
  const there = { threadId: 't9' };
  await N.liveTurnStarted(there);
  eq(there.cwd, PROJECTS[1].path, 'from the backend otherwise');
});

check('a turn that ended on a question or a plan says so', () => {
  const { N } = load();
  eq(N.turnEndKind(turn('t2')), 'done', 'plain');
  eq(N.turnEndKind(turn('t2', { events: [
    { type: 'token', text: 'hm' },
    { type: 'tool', name: 'AskUserQuestion', questions: [{ question: 'Which?' }] },
  ] })), 'question', 'question card');
  eq(N.turnEndKind(turn('t2', { events: [
    { type: 'tool', name: 'ExitPlanMode', plan: '1. do it' },
  ] })), 'plan', 'plan card');
  eq(N.turnEndKind(turn('t2', { events: [{ type: 'tool', name: 'AskUserQuestion' }] })), 'done', 'the bare start event');
});

section('settling');

check('an answered permission prompt takes only its own row down', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2'), 'done', 'Finished.');
  N.dropNotifications('t2', 'ask');
  eq(N.list().length, 1, 'the reply stays');
  await N.notifyChat(turn('t2'), 'ask', 'git push');
  N.dropNotifications('t2', 'ask');
  eq(N.list().length, 0, 'the prompt goes');
});

check('opening the chat clears it, entering its project first if need be', async () => {
  const { N, ctx, calls } = load();
  await N.notifyChat({ threadId: 't9', events: [] }, 'done', 'Done.');
  await N.notifyChat(turn('t2'), 'done', 'Also done.');
  await N.openNotification(N.list().find((n) => n.threadId === 't9'));
  eq(calls.entered.join(), PROJECTS[1].path, 'switched project');
  eq(calls.opened.join(), 't9', 'opened the chat');
  eq(N.list().map((n) => n.threadId).join(), 't2', 'only the other one is left');
  ctx.state.project = PROJECTS[0];
  await N.openNotification(N.list()[0]);
  eq(calls.entered.length, 1, 'same project: no switch');
  eq(N.list().length, 0, 'all read');
});

check('a notification for a chat or project that is gone just goes away', async () => {
  const { N, calls } = load();
  await N.notifyChat(turn('gone'), 'done', 'x');
  await N.notifyChat(turn('t5', { cwd: 'G:\\work\\deleted' }), 'done', 'y');
  await N.openNotification(N.list().find((n) => n.threadId === 'gone'));
  await N.openNotification(N.list().find((n) => n.threadId === 't5'));
  eq(N.list().length, 0, 'rows');
  eq(calls.opened.length, 0, 'nothing opened');
});

check('rows survive a restart — except a permission prompt, which no turn outlives', async () => {
  const storage = memoryStorage();
  const first = load(storage);
  await first.N.notifyChat(turn('t2'), 'done', 'Finished.');
  await first.N.notifyChat(turn('t3', { title: 'Other' }), 'ask', 'rm -rf build');
  eq(first.N.list().length, 2, 'before');
  const second = load(storage);
  eq(second.N.list().map((n) => n.threadId + ':' + n.kind).join(), 't2:done', 'after');
});

section('unread chats');

check('a reply landing elsewhere marks its chat unread, in its tone, landing once', async () => {
  const { N, calls } = load();
  await N.notifyChat(turn('t2'), 'done', 'Done.');
  await N.notifyChat(turn('t3'), 'failed', 'overloaded');
  const a = N.chatUnread('t2');
  eq(a && a.kind, 'done', 'kind');
  eq(a.tone, 'ok', 'tone');
  eq(a.land, true, 'first drawing lands');
  eq(N.chatUnread('t2').land, false, 'a re-render does not land it again');
  eq(N.chatUnread('t3').tone, 'high', 'a failure is red');
  eq(calls.painted, 2, 'the sidebar was repainted each time');
});

check('the chat on screen, and a permission prompt, are never marked', async () => {
  const { N } = load();
  await N.notifyChat(turn('t1'), 'done', 'x');
  await N.notifyChat(turn('t2'), 'ask', 'npm install');
  eq(N.chatUnread('t1'), null, 'on screen');
  eq(N.chatUnread('t2'), null, 'permission prompt');
});

check('a newer event replaces the mark and lands again', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2'), 'failed', 'x');
  N.chatUnread('t2');
  await N.notifyChat(turn('t2'), 'question', 'Which one?');
  const u = N.chatUnread('t2');
  eq(u.kind + ':' + u.tone + ':' + u.land, 'question:warn:true', 'mark');
});

check('opening the chat clears the mark; clearing the bell does not', async () => {
  const { N } = load();
  await N.notifyChat(turn('t2'), 'done', 'x');
  await N.notifyChat(turn('t3'), 'done', 'y');
  N.forgetNotifs(N.list().slice());   // "Clear all" in the bell
  eq(N.list().length, 0, 'bell empty');
  eq(!!N.chatUnread('t2'), true, 'still unread after clearing the bell');
  await N.openNotification({ id: 'x', threadId: 't2', project: PROJECTS[0].path });
  eq(N.chatUnread('t2'), null, 'opened');
  eq(!!N.chatUnread('t3'), true, 'the other stays');
});

check('marks survive a restart, without landing again', async () => {
  const storage = memoryStorage();
  const first = load(storage);
  await first.N.notifyChat(turn('t2'), 'plan', 'Plan');
  const second = load(storage);
  const u = second.N.chatUnread('t2');
  eq(u && u.kind, 'plan', 'kept');
  eq(u.land, false, 'old news does not pop');
});

(async () => {
  for (const step of steps) await step();
  if (failures) {
    console.log(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
})();
