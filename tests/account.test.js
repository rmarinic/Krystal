/* Tests for Settings → Remote → Account (src/app/account.js): what each link
 * status shows, that every string it can ask for exists in both languages, how
 * a link landing is felt, and that Settings can be opened over the project
 * picker (where the launch notice sends you).
 *
 * Same approach as the other frontend tests: the file runs in a vm context that
 * holds the globals it expects from its siblings.
 *
 * Run: node tests/account.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const src = read('src', 'app', 'account.js');

function load(extra) {
  const listeners = {};
  const ctx = {
    tr: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    escapeHtml: (s) => String(s).replace(/</g, '&lt;'),
    replayClass: () => {},
    motionOK: () => true,
    listen: (name, fn) => { listeners[name] = fn; },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => true } } },
    settingsTab: 'remote',
    api: {},
    console, Promise,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.listeners = listeners;
  return ctx;
}

let failed = 0;
const pending = [];
function test(name, fn) {
  const done = () => console.log('  ok  ' + name);
  const fail = (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(done, fail));
    else done();
  } catch (e) { fail(e); }
}

const status = (over) => ({
  state: 'notLinked', linked: false, email: null, deviceName: 'MARIN-PC', code: null, problem: null, ...over,
});
const acts = (v) => v.actions.map((a) => a.act).join(',');

/* ------------------------------ accountView ------------------------------ */

console.log('account view');
const { accountView } = load();

test('not linked offers to link', () => {
  const v = accountView(status());
  assert.strictEqual(v.kind, 'idle');
  assert.strictEqual(v.problem, null);
  assert.strictEqual(acts(v), 'start');
  assert.strictEqual(v.actions[0].key, 'account.link');
});

test('linking shows the code, with Open app.krystal.rip and Cancel', () => {
  const v = accountView(status({ state: 'linking', code: 'KRY-7F3Q-AB2C' }));
  assert.strictEqual(v.kind, 'linking');
  assert.strictEqual(v.code, 'KRY-7F3Q-AB2C');
  assert.strictEqual(acts(v), 'open,cancel');
  assert.strictEqual(v.actions[0].key, 'account.openSite');
});

test('linked offers Unlink, and Unlink asks first', () => {
  const s = status({ state: 'linked', linked: true, email: 'you@example.com' });
  assert.strictEqual(acts(accountView(s, false)), 'ask');
  const asking = accountView(s, true);
  assert.strictEqual(asking.ask, true);
  assert.strictEqual(acts(asking), 'unlink,keep');
});

test('an expired code offers to start again', () => {
  const v = accountView(status({ problem: 'expired' }));
  assert.strictEqual(v.problem, 'account.problem.expired');
  assert.strictEqual(v.actions[0].key, 'account.startAgain');
});

test('errors are said plainly, with a retry', () => {
  for (const p of ['offline', 'denied', 'tooMany', 'failed']) {
    const v = accountView(status({ problem: p }));
    assert.strictEqual(v.problem, 'account.problem.' + p);
    assert.strictEqual(v.actions[0].act, 'start');
    assert.strictEqual(v.actions[0].key, 'account.retry', p);
  }
});

test('unlinked elsewhere is news, and offers to link again rather than retry', () => {
  const v = accountView(status({ problem: 'unlinkedRemotely' }));
  assert.strictEqual(v.problem, 'account.problem.unlinkedRemotely');
  assert.strictEqual(v.actions[0].key, 'account.link');
});

test('a missing status reads as not linked', () => {
  assert.strictEqual(accountView(null).kind, 'idle');
});

/* ------------------------------ presenceView ----------------------------- */

console.log('\nconnection view');
const { presenceView } = load();
const CONNS = ['off', 'connecting', 'online', 'offline', 'elsewhere', 'update', 'failed'];

test('online is green; on its way or retrying by itself is still grey', () => {
  assert.deepStrictEqual({ ...presenceView({ reachable: true, conn: 'online' }) }, { tone: 'on', key: 'account.presence.online' });
  for (const conn of ['connecting', 'offline']) {
    assert.deepStrictEqual({ ...presenceView({ reachable: true, conn }) }, { tone: 'idle', key: 'account.presence.' + conn });
  }
});

test('amber only when staying reachable needs you', () => {
  for (const conn of ['elsewhere', 'update', 'failed']) {
    assert.strictEqual(presenceView({ reachable: true, conn }).tone, 'warn', conn);
  }
});

test('the switch off reads as off, whatever the socket is still doing', () => {
  for (const conn of CONNS) {
    assert.deepStrictEqual({ ...presenceView({ reachable: false, conn }) }, { tone: 'idle', key: 'account.presence.off' });
  }
});

test('off with the switch on is the moment before the first dial', () => {
  assert.strictEqual(presenceView({ reachable: true, conn: 'off' }).key, 'account.presence.connecting');
  assert.strictEqual(presenceView({ reachable: true, conn: 'from-the-future' }).key, 'account.presence.connecting');
  assert.strictEqual(presenceView(null).key, 'account.presence.off');
});

/* ------------------------------ the strings ------------------------------ */

console.log('\nstrings');

/* i18n.js keeps one `'key': …` per line inside an `en:` block then an `hr:` one. */
function keys() {
  const i18n = read('src', 'i18n.js');
  const hrAt = i18n.indexOf('\n    hr: {');
  const of = (chunk) => new Set([...chunk.matchAll(/^\s{6}'([^']+)':/gm)].map((m) => m[1]));
  return { en: of(i18n.slice(0, hrAt)), hr: of(i18n.slice(hrAt)) };
}

test('every key account.js can ask for is in both languages', () => {
  const { en, hr } = keys();
  const used = new Set([...src.matchAll(/\btr\('([^']+)'/g)].map((m) => m[1]));
  for (const a of ['start', 'cancel', 'unlink']) used.add('account.working.' + a);
  // Every key a view can name, across every status and problem.
  const problems = ['offline', 'tooMany', 'denied', 'expired', 'failed', 'unlinkedRemotely', 'unlinkedHereOnly'];
  const views = [
    accountView(status()), accountView(status({ state: 'linking', code: 'K' })),
    accountView(status({ state: 'linked' }), false), accountView(status({ state: 'linked' }), true),
    ...problems.map((p) => accountView(status({ problem: p }))),
  ];
  for (const v of views) {
    if (v.problem) used.add(v.problem);
    for (const a of v.actions) used.add(a.key);
  }
  for (const conn of CONNS) {
    for (const reachable of [true, false]) used.add(presenceView({ reachable, conn }).key);
  }
  const missing = [...used].filter((k) => !en.has(k) || !hr.has(k));
  assert.deepStrictEqual(missing, []);
});

test('every problem the backend can report has words', () => {
  const rs = read('src-tauri', 'src', 'cloud', 'link.rs');
  const codes = [...rs.slice(rs.indexOf('fn code(self)')).matchAll(/=> "(\w+)",/g)].map((m) => m[1]);
  assert.ok(codes.length >= 7, `only ${codes.length} problem codes found in link.rs`);
  const { en, hr } = keys();
  const missing = codes.filter((c) => !en.has('account.problem.' + c) || !hr.has('account.problem.' + c));
  assert.deepStrictEqual(missing, []);
});

test('every connection state the backend can report has words and a tone', () => {
  const rs = read('src-tauri', 'src', 'cloud', 'presence.rs');
  const body = rs.slice(rs.indexOf('fn code(self)'), rs.indexOf('/* --------------------------------- the seam'));
  const codes = [...body.matchAll(/=> "(\w+)",/g)].map((m) => m[1]);
  assert.ok(codes.length >= 7, `only ${codes.length} connection states found in presence.rs`);
  assert.deepStrictEqual([...codes].sort(), [...CONNS].sort(), 'tests/account.test.js knows every state');
  const { en, hr } = keys();
  const toneless = codes.filter((c) => c !== 'off' && presenceView({ reachable: true, conn: c }).key !== 'account.presence.' + c);
  assert.deepStrictEqual(toneless, [], 'account.js names every state');
  const missing = codes.filter((c) => !en.has('account.presence.' + c) || !hr.has('account.presence.' + c));
  assert.deepStrictEqual(missing, []);
});

test('nothing is left of the old remote-access strings', () => {
  const { en, hr } = keys();
  const left = [...en, ...hr].filter((k) => k.startsWith('remote.') || k === 'palette.remote');
  assert.deepStrictEqual(left, []);
});

/* ------------------------------ the panel -------------------------------- */

console.log('\nthe panel');

/* Just enough DOM for the panel: elements that keep their innerHTML and hand
 * back buttons for the `data-act`s in it. */
function fakePanel() {
  const parts = {};
  const part = (cls) => (parts[cls] = parts[cls] || {
    innerHTML: '', dataset: {},
    querySelectorAll(sel) {
      if (sel !== '.account-btn') return [];
      return [...this.innerHTML.matchAll(/data-act="(\w+)"/g)].map((m) => {
        const b = { dataset: { act: m[1] } };
        (parts.buttons = parts.buttons || {})[m[1]] = b;
        return b;
      });
    },
    // The connection's line, dot and switch: one element per paint, so a
    // change made in place can be told from a repaint.
    querySelector(sel) {
      const cls = sel.slice(1);
      if (!this.innerHTML.includes(`class="${cls}`)) return null;
      if (this.paintedFor !== this.innerHTML) { this.kids = {}; this.paintedFor = this.innerHTML; }
      return (this.kids[cls] = this.kids[cls] || fakeEl(this.innerHTML, cls));
    },
  });
  return {
    isConnected: true, parts,
    set innerHTML(_) {},
    querySelector(sel) { return part(sel.slice(1)); },
  };
}

function fakeEl(html, cls) {
  const tag = html.match(new RegExp(`<\\w+ class="(${cls}[^"]*)"([^>]*)>([^<]*)`));
  const classes = new Set(tag[1].split(' '));
  const key = (tag[2].match(/data-key="([^"]+)"/) || [])[1];
  return {
    dataset: key ? { key } : {}, textContent: tag[3], title: '', attrs: {},
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); v.split(' ').forEach((c) => classes.add(c)); },
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

test('the panel paints the code while linking', () => {
  const ctx = load({ api: { cloudCheck: () => new Promise(() => {}) } });
  const panel = fakePanel();
  ctx.renderAccountPanel(panel);
  ctx.accountApply(status({ state: 'linking', code: 'KRY-7F3Q-AB2C' }));
  assert.ok(panel.parts['account-state'].innerHTML.includes('KRY-7F3Q-AB2C'));
  assert.ok(panel.parts['account-actions'].innerHTML.includes('data-act="cancel"'));
});

test('the panel checks the link when it is the tab on screen, and only then', () => {
  let checks = 0;
  const api = { cloudCheck: () => { checks++; return new Promise(() => {}); } };
  const shown = load({ api });
  shown.renderAccountPanel(fakePanel());
  shown.renderAccountPanel(fakePanel());       // a re-render while one is out
  assert.strictEqual(checks, 1);
  checks = 0;
  const measuring = load({ api, settingsTab: 'general' });
  measuring.renderAccountPanel(fakePanel());
  assert.strictEqual(checks, 0, 'Settings measuring every tab is no reason to call the cloud');
});

test('linking landing is felt like a reply landing — and only then', () => {
  let landed = 0;
  const ctx = load({ mascotTurnEnded: () => { landed++; } });
  ctx.accountApply(status({ state: 'linking', code: 'K' }));
  ctx.accountApply(status({ state: 'linked', linked: true, email: 'you@example.com' }));
  assert.strictEqual(landed, 1);
  // A link already there at launch is not an event.
  const again = load({ mascotTurnEnded: () => { landed++; } });
  again.accountApply(status({ state: 'linked', linked: true }));
  assert.strictEqual(landed, 1);
});

test('a link landing while nobody asked arrives on cloud-link', () => {
  const ctx = load();
  ctx.listeners['cloud-link']({ payload: status({ state: 'linked', linked: true, email: 'a@b.c' }) });
  assert.strictEqual(ctx.accountView(vm.runInContext('accountStatus', ctx)).kind, 'linked');
});

test('the email is escaped when it is painted', () => {
  const ctx = load({ api: { cloudCheck: () => new Promise(() => {}) } });
  const panel = fakePanel();
  ctx.renderAccountPanel(panel);
  ctx.accountApply(status({ state: 'linked', linked: true, email: '<img>' }));
  assert.ok(!panel.parts['account-state'].innerHTML.includes('<img>'));
});

test('Unlink asks first, then unlinks', async () => {
  let unlinked = 0;
  const ctx = load({
    api: {
      cloudCheck: () => new Promise(() => {}),
      cloudUnlink: async () => { unlinked++; return status(); },
    },
  });
  const panel = fakePanel();
  ctx.renderAccountPanel(panel);
  ctx.accountApply(status({ state: 'linked', linked: true, email: 'a@b.c' }));
  await ctx.accountAct('ask');
  assert.strictEqual(unlinked, 0);
  assert.ok(panel.parts['account-actions'].innerHTML.includes('data-act="unlink"'));
  await ctx.accountAct('unlink');
  assert.strictEqual(unlinked, 1);
  assert.ok(panel.parts['account-actions'].innerHTML.includes('data-act="start"'));
});

test('launch says so once when the link was ended at app.krystal.rip', async () => {
  const notices = [];
  const ctx = load({
    api: {
      cloudStatus: async () => status({ state: 'linked', linked: true }),
      cloudPresence: async () => ({ reachable: true, conn: 'connecting' }),
      cloudCheck: async () => status({ problem: 'unlinkedRemotely' }),
    },
    showNotice: (n) => { notices.push(n); return true; },
  });
  await ctx.accountBootCheck();
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].html, 'account.problem.unlinkedRemotely');
});

test('launch stays quiet when the link holds, or there is none', async () => {
  let checks = 0;
  const quiet = load({
    api: { cloudStatus: async () => status(), cloudPresence: async () => ({ reachable: true, conn: 'off' }), cloudCheck: async () => { checks++; return status(); } },
    showNotice: () => { throw new Error('nothing to say'); },
  });
  await quiet.accountBootCheck();
  assert.strictEqual(checks, 0, 'not linked: nothing to check');
  const linked = load({
    api: {
      cloudStatus: async () => status({ state: 'linked', linked: true }),
      cloudPresence: async () => ({ reachable: true, conn: 'online' }),
      cloudCheck: async () => status({ state: 'linked', linked: true }),
    },
    showNotice: () => { throw new Error('nothing to say'); },
  });
  await linked.accountBootCheck();
});

/* -------------------------- the live connection -------------------------- */

/* ------------------------- the sidebar's Link a device ------------------- */

console.log('\nLink a device');

function footRow() {
  const btn = { hidden: true, onclick: null };
  return { btn, els: { linkBtn: btn } };
}

test('the row waits for the first status, then shows only while not linked', () => {
  const { btn, els } = footRow();
  const ctx = load({ els, showTip: () => {} });
  assert.strictEqual(btn.hidden, true, 'no flash before the backend has said anything');
  ctx.accountApply(status());
  assert.strictEqual(btn.hidden, false);
  ctx.accountApply(status({ state: 'linking', code: 'K' }));
  assert.strictEqual(btn.hidden, false, 'still there while the code waits');
  ctx.accountApply(status({ state: 'linked', linked: true, email: 'a@b.c' }));
  assert.strictEqual(btn.hidden, true);
  ctx.accountApply(status({ problem: 'unlinkedRemotely' }));
  assert.strictEqual(btn.hidden, false, 'back once the link is gone');
});

test('the row opens Settings → Remote with a link started, and never opens the browser', async () => {
  const { btn, els } = footRow();
  const opened = [];
  let started = 0;
  let sites = 0;
  const ctx = load({
    els,
    openSettings: (tab) => opened.push(tab),
    api: {
      cloudCheck: () => new Promise(() => {}),
      cloudLinkStart: async () => { started++; return status({ state: 'linking', code: 'KRY-1' }); },
      cloudLinkOpen: async () => { sites++; },
    },
  });
  ctx.accountApply(status());
  await btn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(opened, ['remote']);
  assert.strictEqual(started, 1);
  assert.strictEqual(sites, 0, 'the site opens only from its own button');
  // Pressed again while the code waits: the panel again, not a second link.
  await btn.onclick();
  assert.strictEqual(started, 1);
  await ctx.accountAct('open');
  assert.strictEqual(sites, 1);
});

console.log('\nthe live connection');

/* A linked panel on screen, with replayClass recording what it replays. */
function linkedPanel(extra) {
  const replayed = [];
  const ctx = load({
    api: { cloudCheck: () => new Promise(() => {}), ...(extra && extra.api) },
    replayClass: (el, cls) => replayed.push(cls),
    ...(extra && { showNotice: extra.showNotice }),
  });
  const panel = fakePanel();
  ctx.renderAccountPanel(panel);
  ctx.accountApply(status({ state: 'linked', linked: true, email: 'you@example.com' }));
  replayed.length = 0;
  const body = panel.parts['account-state'];
  return { ctx, panel, body, replayed, el: (cls) => body.querySelector('.' + cls) };
}

test('linked shows the connection and the switch; not linked shows neither', () => {
  const { ctx, body, el } = linkedPanel();
  assert.ok(el('account-conn'), 'the connection line');
  assert.ok(el('settings-switch'), 'the switch');
  assert.ok(body.innerHTML.includes('account.reach.name'));
  ctx.accountApply(status());
  assert.strictEqual(el('account-conn'), null);
  assert.strictEqual(el('settings-switch'), null);
});

test('the connection changes in place: the line crossfades, the dot changes tone', () => {
  const { ctx, body, el, replayed } = linkedPanel();
  const painted = body.innerHTML;
  ctx.accountPresenceApply({ reachable: true, conn: 'offline' });
  assert.strictEqual(body.innerHTML, painted, 'no repaint of the panel');
  assert.strictEqual(el('account-conn').textContent, 'account.presence.offline');
  assert.strictEqual(el('account-dot').className, 'account-dot tone-idle');
  assert.deepStrictEqual(replayed, ['account-swap']);
  // The same words again: nothing moves.
  ctx.accountPresenceApply({ reachable: true, conn: 'offline' });
  assert.deepStrictEqual(replayed, ['account-swap']);
});

test('the dot lights once when the connection lands, and holds still after', () => {
  const { ctx, el, replayed } = linkedPanel();
  ctx.accountPresenceApply({ reachable: true, conn: 'connecting' });
  ctx.accountPresenceApply({ reachable: true, conn: 'online' });
  assert.strictEqual(el('account-dot').className, 'account-dot tone-on');
  assert.strictEqual(replayed.filter((c) => c === 'land').length, 1);
  ctx.accountPresenceApply({ reachable: true, conn: 'online' });
  assert.strictEqual(replayed.filter((c) => c === 'land').length, 1, 'still online is not news');
  ctx.accountPresenceApply({ reachable: true, conn: 'elsewhere' });
  assert.strictEqual(el('account-dot').className, 'account-dot tone-warn');
});

test('the switch answers at once, then the backend settles it', async () => {
  const asked = [];
  let answer;
  const { ctx, el } = linkedPanel({
    api: { cloudSetReachable: (on) => { asked.push(on); return new Promise((r) => { answer = r; }); } },
  });
  ctx.accountPresenceApply({ reachable: true, conn: 'online' });
  const sw = el('settings-switch');
  const pressed = sw.onclick();
  assert.strictEqual(sw.classList.contains('on'), false, 'the knob moved before any answer');
  assert.strictEqual(sw.attrs['aria-checked'], 'false');
  assert.deepStrictEqual(asked, [false]);
  answer({ reachable: false, conn: 'off' });
  await pressed;
  assert.strictEqual(el('account-conn').textContent, 'account.presence.off');
});

test('the connection arrives on cloud-presence, and a panel opened later shows it', () => {
  const ctx = load({ api: { cloudCheck: () => new Promise(() => {}) } });
  ctx.listeners['cloud-presence']({ payload: { reachable: false, conn: 'off' } });
  const panel = fakePanel();
  ctx.renderAccountPanel(panel);
  ctx.accountApply(status({ state: 'linked', linked: true }));
  const sw = panel.parts['account-state'].querySelector('.settings-switch');
  assert.ok(!sw.classList.contains('on'));
  assert.ok(panel.parts['account-state'].innerHTML.includes('account.presence.off'));
});

test('a link ended while Krystal runs says so once, unless the panel already does', () => {
  const notices = [];
  const showNotice = (n) => { notices.push(n); return true; };
  const away = load({ showNotice });
  away.accountApply(status({ state: 'linked', linked: true }));
  away.listeners['cloud-link']({ payload: status({ problem: 'unlinkedRemotely' }) });
  away.listeners['cloud-link']({ payload: status({ problem: 'unlinkedRemotely' }) });
  assert.strictEqual(notices.length, 1);

  const { ctx } = linkedPanel({ showNotice });
  ctx.listeners['cloud-link']({ payload: status({ problem: 'unlinkedRemotely' }) });
  assert.strictEqual(notices.length, 1, 'the panel on screen says it itself');
});

/* ----------------------------- modal stacking ---------------------------- */
/* Settings is opened from the project picker (the launch notice, the gear),
 * which is a full-screen entry layer rather than an overlay. If a modal's
 * z-index does not clear the picker's it opens behind it: nothing appears, the
 * click seems to do nothing. Cheap to get wrong again, so it is pinned here. */

console.log('\nmodal stacking');

test('a modal opened from the project picker sits above it', () => {
  const css = [...read('src', 'index.html').matchAll(/href="(css\/[^"]+\.css)"/g)]
    .map((m) => read('src', ...m[1].split('/'))).join('\n');
  const zOf = (re) => {
    const m = css.match(re);
    if (!m) throw new Error(`could not find ${re}`);
    return Number(m[1]);
  };
  const picker = zOf(/\.project-screen\s*\{[^}]*z-index:\s*(\d+)/);
  const lifted = zOf(/body:has\(\.project-screen:not\(\[hidden\]\)\)\s*\.modal-overlay\s*\{\s*z-index:\s*(\d+)/);
  assert.ok(lifted > picker, `modal z-index ${lifted} must beat the picker's ${picker}`);
});

Promise.all(pending).then(() => {
  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
});
