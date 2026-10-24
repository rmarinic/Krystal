/* Tests for the living light behind the chat (src/app/light.js): how the lamp
 * answers each state of a turn, and that it really does come to rest.
 *
 * Same approach as the other frontend tests: the file runs in a vm context that
 * holds the globals it expects from its siblings. Only the pure step is driven
 * here; painting it is the DOM's job.
 *
 * Run: node tests/light.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'light.js'), 'utf8');
  const ctx = {
    document: { getElementById: () => null, body: { classList: { contains: () => true } } },
    requestAnimationFrame: () => 1,
    performance: { now: () => 0 },
    motionOK: () => true,
    console, Math,
  };
  return vm.runInNewContext(`${src}\n;({ lightStep, lightState, LIGHT_BASE, lightMode, lightRest, lightWords, lightKey, lightBeat, lightAnchor, lightTurnBegan })`,
    ctx, { filename: 'light.js' });
}

function fresh() {
  return { mode: 'rest', I: 0, energy: 0, floorE: 0, amber: 0, y: 0, yT: 0, t: 0 };
}
/* Run `secs` of frames at 60fps; returns whether the light still wanted frames. */
function run(L, secs, env = {}) {
  let more = true;
  for (let i = 0; i < Math.round(secs * 60); i++) more = M.lightStep(L, 1 / 60, env);
  return more;
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg}: ${a} not within ${tol} of ${b}`); }

const M = load();
console.log('light');

check('at rest, with nothing happening, there is nothing to animate', () => {
  const L = fresh();
  ok(M.lightStep(L, 1 / 60, {}) === false, 'a resting light asked for another frame');
  ok(L.I === 0, 'a resting light lit up');
});

check('thinking brings the lamp up to its level and flickers only a little', () => {
  const L = fresh(); L.mode = 'thinking';
  run(L, 3);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 600; i++) { M.lightStep(L, 1 / 60, {}); lo = Math.min(lo, L.I); hi = Math.max(hi, L.I); }
  near((lo + hi) / 2, M.LIGHT_BASE.thinking, 0.05, 'centre of the flicker');
  ok(hi - lo > 0.01, 'no flicker at all');
  ok(hi - lo < 0.12, `flicker too strong (${hi - lo})`);
});

check('under reduced motion it holds still at the same level', () => {
  const L = fresh(); L.mode = 'thinking';
  run(L, 4, { reduced: true });
  const a = L.I; run(L, 1, { reduced: true });
  near(L.I, a, 0.001, 'moved under reduced motion');
  near(L.I, M.LIGHT_BASE.thinking, 0.01, 'level');
});

check('words arriving feed the lamp, and it settles once they stop', () => {
  const L = fresh(); L.mode = 'streaming';
  run(L, 3, { reduced: true });
  const calm = L.I;
  for (let i = 0; i < 60; i++) { L.energy = Math.min(0.5, L.energy + 2 * 0.005); M.lightStep(L, 1 / 60, { reduced: true }); }
  ok(L.I > calm + 0.1, `words did not brighten it (${calm} → ${L.I})`);
  run(L, 4, { reduced: true });
  near(L.I, calm, 0.02, 'did not settle back');
});

check('a turn waiting on you goes amber and perfectly still', () => {
  const L = fresh(); L.mode = 'working';
  run(L, 4, { waiting: true });
  near(L.amber, 1, 0.01, 'amber');
  const a = L.I; run(L, 1, { waiting: true });
  near(L.I, a, 0.0005, 'moved while waiting');
  near(L.I, M.LIGHT_BASE.waiting, 0.01, 'level');
  run(L, 4, {});
  near(L.amber, 0, 0.01, 'back to green once answered');
});

check('a finished turn cools slowly, then stops asking for frames', () => {
  const L = fresh(); L.mode = 'streaming';
  run(L, 3);
  L.mode = 'rest';
  run(L, 0.5);
  ok(L.I > 0.15, `cooled too fast (${L.I} after half a second)`);
  ok(run(L, 12) === false, 'still animating long after the turn ended');
});

check('typing warms the floor, which cools again when it stops', () => {
  const L = fresh();
  L.floorE = 1;
  ok(M.lightStep(L, 1 / 60, {}) === true, 'a warm floor should keep the loop going');
  ok(run(L, 6) === false, 'floor never cooled');
});

check('the lamp glides to where Claude is writing, or jumps under reduced motion', () => {
  const L = fresh(); L.mode = 'thinking'; L.y = 600; L.yT = 200;
  M.lightStep(L, 1 / 60, {});
  ok(L.y < 600 && L.y > 200, 'did not glide');
  run(L, 3);
  near(L.y, 200, 1, 'did not arrive');
  L.yT = 400; M.lightStep(L, 1 / 60, { reduced: true });
  ok(L.y === 400, 'reduced motion should place it directly');
});

check('the hooks are safe with no light layer on the page', () => {
  M.lightTurnBegan({ top: 10 }); M.lightAnchor({}); M.lightMode('working');
  M.lightWords(40); M.lightKey(); M.lightBeat({ isConnected: true }); M.lightRest();
  ok(M.lightState.energy <= 0.5, 'energy is capped');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('light.test.js: ok');
