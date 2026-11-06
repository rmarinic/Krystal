/* In the app, `window.confirm` is the dialog plugin's: async, returning a
 * Promise. A Promise is truthy, so `if (!confirm(…)) return` never returned:
 * Clear, Delete chat, Remove project … all went ahead before the question was
 * answered. Questions go through `askYes` (utils.js), which awaits the answer.
 * This checks the helper, and that no script asks `confirm` directly again.
 *
 * Run: node tests/confirm.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = path.join(__dirname, '..', 'src');
const utils = fs.readFileSync(path.join(src, 'app', 'utils.js'), 'utf8');
const fnSrc = utils.match(/^async function askYes\([\s\S]*?\n}\n/m);
assert.ok(fnSrc, 'askYes should be declared in utils.js');
const makeAskYes = (confirm) => new Function('confirm', fnSrc[0] + '\nreturn askYes;')(confirm);

(async () => {
  // The plugin's confirm: a Promise of the answer.
  assert.strictEqual(await makeAskYes(async () => false)('Clear?'), false, 'a Promise of "no" is no');
  assert.strictEqual(await makeAskYes(async () => true)('Clear?'), true, 'a Promise of "yes" is yes');
  // A browser's confirm (the harness): a plain boolean.
  assert.strictEqual(await makeAskYes(() => false)('Clear?'), false);
  assert.strictEqual(await makeAskYes(() => true)('Clear?'), true);
  // A dialog that can't open must not count as consent.
  assert.strictEqual(await makeAskYes(async () => { throw new Error('denied'); })('Clear?'), false);
  assert.strictEqual(await makeAskYes(async () => undefined)('Clear?'), false);

  // Nobody calls confirm() themselves: it has to be awaited, and askYes does that.
  const files = [
    ...fs.readdirSync(path.join(src, 'app')).filter((f) => f.endsWith('.js')).map((f) => path.join('app', f)),
    ...fs.readdirSync(src).filter((f) => f.endsWith('.js')).map((f) => f),
  ];
  const bare = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(src, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;      // a comment may name it
      if (/(^|[^.\w$])confirm\s*\(/.test(line) && !/await confirm\(text\)/.test(line)) {
        bare.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(bare, [], 'call askYes(…) instead of confirm(…):\n' + bare.join('\n'));

  console.log('confirm.test.js: ok (askYes waits for the answer; no bare confirm() in ' + files.length + ' scripts)');
})().catch((e) => { console.error(e); process.exit(1); });
