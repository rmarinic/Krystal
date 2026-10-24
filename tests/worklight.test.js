/* Tests for the work light (src/worklight.js): the bar and glow behind the
 * full-screen waits (Compact / Clear / Update Claude Code, the self-update).
 * They pin what the design promises: the bar creeps but never claims the end,
 * real progress moves it only forward, an event brightens the light at once
 * and it cools back slowly, and `done` comes to rest.
 *
 * Run: node tests/worklight.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'worklight.js'), 'utf8');
const M = vm.runInNewContext(
  `${src}\n;({ workState, workStep, workKick, workTarget, WORK_FLOOR, WORK_END })`,
  { Math, console }, { filename: 'worklight.js' });

const ENV = { reduced: false, fx: true };
function run(W, secs, env = ENV) {
  let more = true;
  for (let i = 0; i < Math.round(secs * 60); i++) more = M.workStep(W, 1 / 60, env);
  return more;
}
function fresh(cap = 0.14, tau = 5) {
  return Object.assign(M.workState(), { crawlCap: cap, crawlTau: tau });
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

check('with nothing reported the bar creeps, slower and slower, under its cap', () => {
  const W = fresh();
  run(W, 2); const a = W.shown;
  run(W, 2); const b = W.shown;
  run(W, 2); const c = W.shown;
  assert(a > 0 && b > a && c > b, `should keep moving: ${a} ${b} ${c}`);
  assert(c - b < b - a, 'should slow down');
  run(W, 120);
  assert(W.shown <= 0.14 + 1e-9, `crawl passed its cap: ${W.shown}`);
});

check('real progress takes over and only ever moves the bar forward', () => {
  const W = fresh();
  run(W, 1);
  W.real = 0.6; run(W, 3);
  assert(W.shown > 0.55, `should catch up with progress: ${W.shown}`);
  const at = W.shown;
  W.real = 0.2; run(W, 2);
  assert(W.shown >= at, 'went backwards');
});

check('nothing but done reaches the end of the bar', () => {
  const W = fresh();
  W.real = 1; run(W, 30);
  assert(W.shown <= M.WORK_END + 1e-9, `reached ${W.shown} before done`);
});

check('an event brightens the light at once, and it cools back to the floor', () => {
  const W = fresh();
  run(W, 4);
  const before = W.glow;
  M.workKick(W, 0.16);
  assert(W.glow > before + 0.05, 'a kick should show immediately');
  run(W, 8, { reduced: false, fx: false });
  assert(Math.abs(W.glow - M.WORK_FLOOR) < 0.01, `should settle at the floor: ${W.glow}`);
});

check('a burst of events lifts the light without pinning it at full', () => {
  const W = fresh();
  for (let i = 0; i < 40; i++) { M.workKick(W, 0.16); run(W, 0.12); }
  assert(W.glow > 0.5 && W.glow < 0.95, `burst level: ${W.glow}`);
});

check('done runs the bar out, cools the light and comes to rest', () => {
  const W = fresh();
  W.real = 0.5; run(W, 2);
  W.done = true; M.workKick(W, 1);
  const more = run(W, 8);
  assert(!more, 'should stop asking for frames');
  assert(W.shown > 0.998, `bar should be at the end: ${W.shown}`);
  assert(W.light < 0.02, `light should be out: ${W.light}`);
});

check('reduced motion: the bar steps to the work and the light never flickers', () => {
  const W = fresh();
  W.real = 0.5;
  M.workStep(W, 1 / 60, { reduced: true, fx: true });
  assert(W.shown === 0.5, `should step straight there: ${W.shown}`);
  run(W, 6, { reduced: true, fx: true });
  assert(Math.abs(W.light - W.glow) < 1e-12, 'flicker under reduced motion');
});

check('the light stays within 0..1 through a long wait', () => {
  const W = fresh();
  for (let i = 0; i < 6000; i++) {
    if (i % 37 === 0) M.workKick(W, 0.16);
    M.workStep(W, 1 / 60, ENV);
    assert(W.light >= 0 && W.light <= 1, `out of range: ${W.light}`);
  }
});

if (failed) { console.log(`\n${failed} failing`); process.exit(1); }
console.log('\nall work-light tests passed');
