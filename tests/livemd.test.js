/* Tests for live markdown (src/app/livemd.js): where finished blocks end
 * (`mdSplit`), and how a half-written block is healed so it renders as what it
 * is going to be (`mdHeal`) — checked against the real `marked` the app ships,
 * over every prefix of a reply, as the stream would reveal it.
 *
 * Run: node tests/livemd.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', 'src');
const ctx = { window: {}, console, String, Math, RegExp };
ctx.self = ctx.window;
vm.createContext(ctx);
// marked's UMD build attaches itself to whatever global it finds.
vm.runInContext(fs.readFileSync(path.join(root, 'vendor', 'marked.min.js'), 'utf8'), ctx);
const marked = ctx.marked || ctx.window.marked;
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'livemd.js'), 'utf8'), ctx);
const { mdSplit, mdHeal, mdOpenFence } = vm.runInContext('({ mdSplit, mdHeal, mdOpenFence })', ctx);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
const text = (html) => html.replace(/<[^>]+>/g, '');

/* --------------------------------- mdSplit -------------------------------- */

test('a paragraph is finished by the blank line after it', () => {
  const s = 'First paragraph.\n\nSecond, still go';
  assert.strictEqual(s.slice(0, mdSplit(s)), 'First paragraph.\n\n');
});

test('nothing is finished until a line has ended', () => {
  assert.strictEqual(mdSplit('Just one line so far'), 0);
  assert.strictEqual(mdSplit(''), 0);
});

test('a heading is finished as soon as its line is', () => {
  const s = '## Setup\nRun the';
  assert.strictEqual(s.slice(0, mdSplit(s)), '## Setup\n');
});

test('nothing inside an open code fence is finished, blank lines and all', () => {
  const s = 'Intro.\n\n```js\nconst a = 1;\n\nconst b';
  assert.strictEqual(s.slice(0, mdSplit(s)), 'Intro.\n\n');
});

test('a closed fence is finished, and so is the text before it', () => {
  const s = 'Look:\n```\ncode\n```\nAfter';
  assert.strictEqual(s.slice(0, mdSplit(s)), 'Look:\n```\ncode\n```\n');
  const open = 'Look:\n```\ncode';
  assert.strictEqual(open.slice(0, mdSplit(open)), 'Look:\n');
});

test('a fence only closes on the same kind, at least as long', () => {
  const s = '````\n```\nstill code\n';
  assert.strictEqual(mdSplit(s), 0);
  assert.strictEqual(mdOpenFence(s), '````');
});

/* ---------------------------------- mdHeal --------------------------------- */

test('an unclosed bold is closed', () => {
  assert.strictEqual(mdHeal('This is **very imp'), 'This is **very imp**');
});

test('an unclosed inline code is closed', () => {
  assert.strictEqual(mdHeal('Run `npm te'), 'Run `npm te`');
});

test('a marker typed halfway is held back', () => {
  assert.strictEqual(mdHeal('This is *'), 'This is ');
  assert.strictEqual(mdHeal('Done. **'), 'Done. ');
  assert.strictEqual(mdHeal('Intro\n##'), 'Intro\n');
});

test('a half-written link shows as its text', () => {
  assert.strictEqual(mdHeal('See [the docs](https://exa'), 'See the docs');
  assert.strictEqual(mdHeal('See [the do'), 'See the do');
});

test('an open code fence is closed so the code so far shows as code', () => {
  assert.strictEqual(mdHeal('```js\nconst a = 1;'), '```js\nconst a = 1;\n```');
  // …and nothing inside it is "healed" as if it were prose.
  assert.strictEqual(mdHeal('```\nlet x = a ** b'), '```\nlet x = a ** b\n```');
});

test('list bullets and complete markup are left alone', () => {
  assert.strictEqual(mdHeal('* one\n* two'), '* one\n* two');
  assert.strictEqual(mdHeal('Some **bold** and `code`'), 'Some **bold** and `code`');
});

/* ------------------- every prefix, through the real marked ------------------ */

const REPLY = [
  '## What changed',
  '',
  'I updated **three files** and added a `--watch` flag. See [the README](https://example.com/readme) for *details*.',
  '',
  '- First, the **parser** now handles `#include`',
  '- Then the [tests](https://example.com/t) were *extended*',
  '',
  '```js',
  'const total = a ** 2 + b;',
  '```',
  '',
  'All done.',
].join('\n');

test('no prefix of a reply ever shows stray ** or backticks', () => {
  for (let i = 1; i <= REPLY.length; i++) {
    const shown = REPLY.slice(0, i);
    const cut = mdSplit(shown);
    const tail = shown.slice(cut);
    if (!tail.trim()) continue;
    const healed = mdHeal(tail);
    const html = marked.parse(healed);
    // Code blocks may legitimately contain `**`; prose may not.
    const prose = text(html.replace(/<pre>[\s\S]*?<\/pre>/g, ''));
    assert.ok(!/\*/.test(prose), `stray * at ${i}: ${JSON.stringify(tail)} → ${prose}`);
    assert.ok(!/`/.test(prose), `stray backtick at ${i}: ${JSON.stringify(tail)} → ${prose}`);
  }
});

test('finished blocks plus the tail render the same text as the whole reply', () => {
  const cut = mdSplit(REPLY);
  const parts = text(marked.parse(REPLY.slice(0, cut)) + marked.parse(mdHeal(REPLY.slice(cut))));
  assert.strictEqual(parts.replace(/\s+/g, ' ').trim(), text(marked.parse(REPLY)).replace(/\s+/g, ' ').trim());
});

console.log(`\nlivemd: ${passed} passed`);
