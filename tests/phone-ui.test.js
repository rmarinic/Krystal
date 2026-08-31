/* Tests for the phone UI (src-tauri/src/webui/) and for locale parity.
 *
 * The phone page is served straight out of the Rust binary and is only ever
 * looked at on a phone, so the two ways it can quietly rot — a `$('#id')` that
 * no longer matches the markup, and a `t('key')` with no string behind it — are
 * exactly the ones nobody would notice until it mattered. Both are checked here
 * by reading the files, no browser required.
 *
 * The last check guards the project rule that every user-facing string ships in
 * BOTH English and Croatian, across the whole desktop dictionary.
 *
 * Run: node tests/phone-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const WEBUI = path.join('src-tauri', 'src', 'webui');
const html = read(WEBUI, 'index.html');
const appJs = read(WEBUI, 'app.js');
const appCss = read(WEBUI, 'app.css');

/* -------------------------------- harness -------------------------------- */

let failures = 0;
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
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

/* ------------------------------ the phone UI ----------------------------- */

console.log('phone UI');

check('every element the script looks up exists in the markup', () => {
  const ids = new Set(all(/\sid="([^"]+)"/g, html));
  const missing = [...new Set(all(/\$\('#([^']+)'\)/g, appJs))].filter((id) => !ids.has(id));
  eq(missing.join(', '), '', 'elements referenced but not in index.html');
});

check('the markup only loads assets the server actually serves', () => {
  const served = new Set(['app.css', 'app.js', 'vendor/marked.js', 'vendor/purify.js']);
  const server = read('src-tauri', 'src', 'server.rs');
  for (const asset of served) {
    if (!server.includes(`"/${asset}"`)) throw new Error(`server.rs does not route /${asset}`);
  }
  const refs = [...all(/<script[^>]+src="([^"]+)"/g, html), ...all(/<link[^>]+href="(app[^"]+)"/g, html)];
  const stray = refs.filter((r) => !served.has(r));
  eq(stray.join(', '), '', 'assets referenced by index.html but not served');
});

// The i18n table is a plain literal at the top of the IIFE, so it can be lifted
// out and evaluated on its own without standing up a DOM.
function phoneStrings() {
  const start = appJs.indexOf('const STRINGS = {');
  if (start < 0) throw new Error('could not find STRINGS in app.js');
  let depth = 0;
  let i = appJs.indexOf('{', start);
  const from = i;
  for (; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}' && --depth === 0) break;
  }
  return vm.runInNewContext('(' + appJs.slice(from, i + 1) + ')');
}

check('the phone speaks both languages, with the same keys in each', () => {
  const S = phoneStrings();
  const flat = (o, prefix) => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, prefix + k + '.') : [prefix + k]);
  const en = flat(S.en, '').sort();
  const hr = flat(S.hr, '').sort();
  eq(en.filter((k) => !hr.includes(k)).join(', '), '', 'keys missing from Croatian');
  eq(hr.filter((k) => !en.includes(k)).join(', '), '', 'keys missing from English');
  eq(en.length > 20, true, 'the dictionary should not be near-empty');
});

check('every string the phone asks for is in the dictionary', () => {
  const S = phoneStrings();
  // `t()` is only ever called with a literal; anything computed is a tool label,
  // which falls back to the raw tool name by design.
  const used = new Set(all(/\bt\('([^']+)'/g, appJs));
  const missing = [...used].filter((k) => !(k in S.en) || !(k in S.hr));
  eq(missing.join(', '), '', 'keys used by app.js but not defined');
});

check('the Croatian strings kept their diacritics', () => {
  const S = phoneStrings();
  const text = Object.values(S.hr).map((v) => (typeof v === 'string' ? v : Object.values(v).join(' '))).join(' ');
  eq(/[čćžšđ]/i.test(text), true, 'no Croatian diacritics survived — check the file encoding');
  eq(/Ã|Å|â€/.test(text), false, 'mojibake in the Croatian strings — the file is not UTF-8');
});

check('every animation has a reduced-motion escape hatch', () => {
  eq(appCss.includes('@media (prefers-reduced-motion: reduce)'), true, 'no reduced-motion block');
  const guard = appCss.slice(appCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  eq(/animation-duration:\s*\.001ms/.test(guard), true, 'animations are not neutralised');
  eq(/transition-duration:\s*\.001ms/.test(guard), true, 'transitions are not neutralised');
});

/* ------------------------- desktop locale parity ------------------------- */

console.log('\ndesktop dictionary');

/* i18n.js is an IIFE that hands out `t` but never the table, so the keys are read
 * off the source. The file's shape is one `'key': …` per line inside an `en:`
 * block followed by an `hr:` block. */
function desktopKeys() {
  const src = read('src', 'i18n.js');
  const hrAt = src.indexOf('\n    hr: {');
  if (hrAt < 0) throw new Error('could not find the hr block in i18n.js');
  const keysIn = (chunk) => new Set(all(/^\s{6}'([^']+)':/gm, chunk));
  return { en: keysIn(src.slice(0, hrAt)), hr: keysIn(src.slice(hrAt)) };
}

check('English and Croatian define exactly the same keys', () => {
  const { en, hr } = desktopKeys();
  eq(en.size > 400, true, `expected a full dictionary, saw ${en.size} keys`);
  eq([...en].filter((k) => !hr.has(k)).join(', '), '', 'keys missing from Croatian');
  eq([...hr].filter((k) => !en.has(k)).join(', '), '', 'keys missing from English');
});

check('the phone-access strings landed in both', () => {
  const { en, hr } = desktopKeys();
  const wanted = ['phone.label', 'phone.start', 'phone.stop', 'phone.step1', 'phone.step2',
    'phone.note', 'settings.phone.name', 'settings.phone.desc', 'settings.tab.phone'];
  for (const key of wanted) {
    if (!en.has(key)) throw new Error(`${key} missing from English`);
    if (!hr.has(key)) throw new Error(`${key} missing from Croatian`);
  }
});

check('every key phone.js asks for is defined', () => {
  const { en, hr } = desktopKeys();
  const used = new Set(all(/\btr\('([^']+)'/g, read('src', 'app', 'phone.js')));
  const missing = [...used].filter((k) => !en.has(k) || !hr.has(k));
  eq(missing.join(', '), '', 'keys used by phone.js but not defined');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
