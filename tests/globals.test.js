/* The frontend's scripts are classic scripts sharing one global scope, loaded in
 * order: a function declared twice is not an error, the later file simply wins
 * — for every caller, in every file. That has bitten twice (a second
 * `renderReview` blanked the Changes panel; a second `fmtDur` broke the agent
 * timer), silently both times, so this checks no top-level function name is
 * declared in more than one place.
 *
 * Run: node tests/globals.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dir = path.join(__dirname, '..', 'src', 'app');
const seen = new Map();
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  // Column 0 only: a nested helper is scoped to its function and may repeat.
  for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    if (!seen.has(m[1])) seen.set(m[1], []);
    seen.get(m[1]).push(file);
  }
}

const clashes = [...seen].filter(([, files]) => files.length > 1)
  .map(([name, files]) => `${name} (${files.join(', ')})`);
assert.deepStrictEqual(clashes, [], 'global functions declared more than once: ' + clashes.join('; '));
assert.ok(seen.size > 100, 'expected to find the app\'s functions');

console.log('globals.test.js: ok (' + seen.size + ' global functions, no clashes)');
