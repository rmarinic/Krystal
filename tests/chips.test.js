/* Tests for the action chips' ways out (src/app/messages.js): the result links
 * pulled out of a web search's output, and how the Open button treats a file —
 * a click meant to look at a file must never run it.
 *
 * Same approach as the other frontend tests — the file is a classic script that
 * shares one global scope, so it is loaded into a vm context holding just the
 * globals it expects.
 *
 * Run: node tests/chips.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadMessages() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'messages.js'), 'utf8');
  const ctx = {
    tr: (k) => k, escapeHtml: (s) => String(s), icon: () => '',
    document: { createElement: () => ({}) }, window: {},
    Set, Map, JSON, String, Array, console,
  };
  const exported = ['webSearchLinks', 'chipOpenKind'];
  return vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'messages.js' });
}

const { webSearchLinks, chipOpenKind } = loadMessages();
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

/* ------------------------------ webSearchLinks ------------------------------ */

const SAMPLE =
  'Web search results for query: "spyro level design"\n\n' +
  'Links: [{"title":"Spyro \\"the\\" Dragon","url":"https://example.com/a"},' +
  '{"title":"StrategyWiki","url":"https://strategywiki.org/wiki/Spyro"}]\n\n' +
  'Some summary text that mentions https://not-a-result.example too.';

test('pulls title + url pairs out of the Links array', () => {
  const links = webSearchLinks(SAMPLE);
  assert.strictEqual(links.length, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(links[0])), { title: 'Spyro "the" Dragon', url: 'https://example.com/a' });
  assert.strictEqual(links[1].url, 'https://strategywiki.org/wiki/Spyro');
});

test('survives the output cap cutting the array mid-entry', () => {
  const cut = 'Links: [{"title":"One","url":"https://one.example/"},{"title":"Tw';
  const links = webSearchLinks(cut);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].url, 'https://one.example/');
});

test('merges several Links blocks, each url once', () => {
  const two = 'Links: [{"title":"A","url":"https://a.example/"}]\nLinks: [{"title":"A again","url":"https://a.example/"},{"title":"B","url":"https://b.example/"}]';
  assert.strictEqual(webSearchLinks(two).map((l) => l.url).join(' '), 'https://a.example/ https://b.example/');
});

test('drops anything that is not http(s), and an empty title falls back to the url', () => {
  const odd = 'Links: [{"title":"x","url":"javascript:alert(1)"},{"title":"","url":"http://plain.example/"}]';
  const links = webSearchLinks(odd);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].title, 'http://plain.example/');
});

test('no output, no links', () => {
  assert.strictEqual(webSearchLinks(undefined).length, 0);
  assert.strictEqual(webSearchLinks('').length, 0);
});

/* ------------------------------- chipOpenKind ------------------------------- */

test('ordinary files open in their own program', () => {
  for (const p of ['C:\\x\\shot.PNG', 'C:/x/notes.md', 'C:\\x\\report.docx', 'C:\\x\\Makefile']) {
    assert.strictEqual(chipOpenKind(p), 'default', p);
  }
});

test('scripts open as text', () => {
  for (const p of ['C:\\x\\build.ps1', 'C:\\x\\run.CMD', 'C:\\x\\a.bat', 'C:\\x\\tool.js', 'C:\\x\\s.vbs', 'C:\\x\\t.reg']) {
    assert.strictEqual(chipOpenKind(p), 'text', p);
  }
});

test('binaries and shortcuts are never opened', () => {
  for (const p of ['C:\\x\\setup.exe', 'C:\\x\\app.msi', 'C:\\x\\a.lnk', 'C:\\x\\b.url', 'C:\\x\\c.scr', 'C:\\x\\d.jar']) {
    assert.strictEqual(chipOpenKind(p), 'never', p);
  }
});

test('matches the backend rule (commands.rs open_kind) extension for extension', () => {
  const rs = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'commands.rs'), 'utf8');
  const list = (name) => {
    const m = rs.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`));
    return m[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  };
  for (const ext of list('AS_TEXT')) assert.strictEqual(chipOpenKind('C:\\x\\f.' + ext), 'text', ext);
  for (const ext of list('NEVER')) assert.strictEqual(chipOpenKind('C:\\x\\f.' + ext), 'never', ext);
});

console.log(`\nchips: ${passed} passed`);
