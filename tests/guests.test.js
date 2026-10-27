/* Tests for Settings → Remote's "People you share this computer with"
 * (src/app/guests.js): a choice after each change, what the note under the modes
 * says, that its list of modes is the backend's (`models::MODES`, same order),
 * that every string it asks for exists in both languages, and that a save the
 * backend refuses puts the last saved choice back.
 *
 * Run: node tests/guests.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const src = read('src', 'app', 'guests.js');

function load(extra) {
  const ctx = {
    tr: (k) => k,
    escapeHtml: (s) => String(s),
    replayClass: () => {},
    document: { createElement: () => ({}) },
    api: {},
    console, Promise, Set, Array,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + String(e.message).replace(/\n/g, '\n     '));
  }
}

const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const g = load();

  await check('a mode turns on and off, and the list stays most able first', () => {
    const a = { modes: ['ask', 'plan'], approve: false, commands: false, allFiles: false };
    assert.deepStrictEqual(plain(g.guestAccessWith(a, { mode: 'auto' }).modes), ['auto', 'ask', 'plan']);
    assert.deepStrictEqual(plain(g.guestAccessWith(a, { mode: 'ask' }).modes), ['plan']);
    assert.deepStrictEqual(plain(a.modes), ['ask', 'plan'], 'the old choice is left alone');
  });

  await check('a switch flips, and only a known one', () => {
    const a = { modes: [], approve: false, commands: true, allFiles: false };
    assert.strictEqual(g.guestAccessWith(a, { key: 'approve' }).approve, true);
    assert.strictEqual(g.guestAccessWith(a, { key: 'commands' }).commands, false);
    assert.strictEqual(g.guestAccessWith(a, { key: 'modes' }).modes.length, 0, 'not a switch');
  });

  await check('the note says what the modes mean', () => {
    assert.strictEqual(g.guestModesNote([]), 'guests.modes.none');
    assert.strictEqual(g.guestModesNote(['ask', 'plan']), 'guests.modes.capped');
    assert.strictEqual(g.guestModesNote(['auto']), 'guests.modes.full');
  });

  await check("the modes are the backend's, in the backend's order", () => {
    const models = read('src-tauri', 'src', 'models.rs');
    const block = models.match(/pub const MODES: &\[Mode\] = &\[([\s\S]*?)\n\];/);
    assert.ok(block, "can't find MODES in models.rs");
    const ids = [...block[1].matchAll(/Mode \{ id: "([a-z]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(plain(vm.runInContext('GUEST_MODES', g)), ids);
  });

  await check('every string it uses exists in English and Croatian', () => {
    const i18n = read('src', 'i18n.js');
    const keys = new Set([...src.matchAll(/'(guests\.[A-Za-z.]+)'/g)].map((m) => m[1]));
    for (const k of vm.runInContext('GUEST_SWITCHES', g)) { keys.add(`guests.${k}.name`); keys.add(`guests.${k}.desc`); }
    for (const m of vm.runInContext('GUEST_MODES', g)) { keys.add(`mode.${m}.name`); keys.add(`mode.${m}.blurb`); }
    for (const k of keys) {
      const n = i18n.split(`'${k}':`).length - 1;
      assert.strictEqual(n, 2, `${k} appears ${n} times (want EN + HR)`);
    }
  });

  await check('a refused save puts the last saved choice back', async () => {
    const saved = { modes: ['plan'], approve: false, commands: false, allFiles: false };
    const h = load({ api: { setGuestAccess: () => Promise.reject(new Error('disk full')) } });
    vm.runInContext(`guestAccess = ${JSON.stringify(saved)}`, h);
    await h.guestChange({ mode: 'auto' });
    assert.deepStrictEqual(plain(vm.runInContext('guestAccess', h)), saved);
    const ok = load({ api: { setGuestAccess: (a) => Promise.resolve({ ...a, modes: a.modes.filter((m) => m !== 'auto') }) } });
    vm.runInContext(`guestAccess = ${JSON.stringify(saved)}`, ok);
    await ok.guestChange({ key: 'approve' });
    assert.strictEqual(vm.runInContext('guestAccess.approve', ok), true, "the backend's answer is kept");
  });

  if (failures) { console.log(`\n${failures} guests test(s) failed`); process.exit(1); }
  console.log('guests: all passed');
})();
