/* Tests for the crystal face in the logo (src/app/mascot.js): what each state of
 * the app makes it look like, that every movement settles, and that it really
 * does come to rest — and holds still while it waits on you.
 *
 * Same approach as the light's tests: the file runs in a vm context holding the
 * globals it expects from its siblings. The pure target/step are driven
 * directly; the hooks are driven through the mascot's own state.
 *
 * Run: node tests/mascot.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fx = true;
function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'mascot.js'), 'utf8');
  const ctx = {
    document: {
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      body: { classList: { contains: (c) => c === 'fx-on' && fx } },
    },
    window: { addEventListener() {} },
    requestAnimationFrame: () => 1,
    setTimeout: () => 0, clearTimeout() {},
    performance: { now: () => 0 },
    motionOK: () => true,
    state: { live: new Map() },
    console, Math,
  };
  return vm.runInNewContext(`${src}\n;({ mascot, mascotFace, mascotTarget, mascotStep, mascotTalkFor, mascotFidget, MASCOT_GREEN, MASCOT_AMBER, MASCOT_RED,
    mascotTurnBegan, mascotTurnEnded, mascotMode, mascotRest, mascotWords, mascotActivity, mascotNod })`,
    ctx, { filename: 'mascot.js' });
}

/* Run `secs` of frames at 60fps with the mascot state `m`; returns whether the
 * face still wanted frames at the end. */
function run(F, m, secs, env = {}) {
  let more = true;
  for (let i = 0; i < Math.round(secs * 60); i++) {
    const e = { now: i * 16.7, t: i / 60, ...env };
    e.busy = !e.still && !e.waiting && m.mood === 'thinking';
    more = M.mascotStep(F, M.mascotTarget(m, e), 1 / 60, e);
  }
  return more;
}
const st = (mood, extra) => ({ mood, hover: false, caret: 0.6, glance: null, talk: 0, ...extra });

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg}: ${a} not within ${tol} of ${b}`); }

const M = load();
console.log('mascot');

check('at rest, with nothing happening, there is nothing to animate', () => {
  const F = M.mascotFace();
  ok(run(F, st('rest'), 1 / 60) === false, 'a resting face asked for another frame');
});

check('thinking keeps drifting for as long as it lasts, and only a little', () => {
  const F = M.mascotFace();
  ok(run(F, st('thinking'), 3) === true, 'thinking came to rest');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 600; i++) {
    const e = { now: 0, t: 3 + i / 60, busy: true };
    M.mascotStep(F, M.mascotTarget(st('thinking'), e), 1 / 60, e);
    lo = Math.min(lo, F.lx); hi = Math.max(hi, F.lx);
  }
  ok(hi - lo > 0.05, 'no drift at all');
  ok(hi - lo < 0.5, `drift too wide (${hi - lo})`);
  ok(F.ly < -0.4, 'not looking up while thinking');
});

check('waiting on you is amber, looking straight out, and perfectly still', () => {
  const F = M.mascotFace();
  run(F, st('writing', { talk: 0.85 }), 1);
  ok(run(F, st('writing'), 3, { waiting: true }) === false, 'still moving while waiting');
  near(F.tint[0], M.MASCOT_AMBER[0], 1, 'amber');
  near(F.lx, 0, 0.01, 'eyes not straight ahead');
  // Once settled it asks for no frame at all, however long the wait lasts.
  for (let i = 0; i < 120; i++) {
    const e = { now: 0, t: i / 60, waiting: true, busy: false };
    ok(M.mascotStep(F, M.mascotTarget(st('thinking'), e), 1 / 60, e) === false, 'moved again while it waited');
  }
});

check('a failure turns it red and drooping; the colour leaves slower than it came', () => {
  const F = M.mascotFace();
  run(F, st('error'), 1);
  ok(F.tint[0] > 225 && F.tint[1] < 140, `not red after a second (${F.tint.map(Math.round)})`);
  ok(F.droop > 0.6, 'eyes not drooping');
  run(F, st('rest'), 0.5);
  ok(F.tint[1] < 190, 'red left as fast as it came');
  ok(run(F, st('rest'), 8) === false, 'never came back to rest');
  near(F.tint[1], M.MASCOT_GREEN[1], 0.6, 'back to green');
});

check('a hop, a nod and a shake all settle', () => {
  const F = M.mascotFace();
  F.bobV = -70; F.sqV = 14; F.shV = 150; F.beat = 0.6;
  ok(run(F, st('rest'), 0.2) === true, 'settled implausibly fast');
  ok(run(F, st('rest'), 3) === false, 'still bouncing after 3s');
  near(F.bobY, 0, 0.01, 'bob'); near(F.shX, 0, 0.01, 'shake');
});

check('a blink shuts and opens again on its own', () => {
  const F = M.mascotFace();
  F.blink = { t: 0, dur: 0.2, eye: 'both' };
  ok(run(F, st('rest'), 0.1) === true, 'blink ended early');
  ok(run(F, st('rest'), 0.5) === false, 'blink never ended');
  ok(F.blink === null, 'blink left behind');
});

check('still (no Extra effects / reduced motion): no bounce, no blink, no drift — but the state shows', () => {
  const F = M.mascotFace();
  F.bobV = -70; F.blink = { t: 0, dur: 0.2, eye: 'both' };
  run(F, st('thinking'), 1 / 60, { still: true });
  ok(F.bobV === 0 && F.blink === null, 'bounced or blinked while still');
  ok(run(F, st('thinking'), 1, { still: true }) === false, 'thinking drifted while still');
  run(F, st('error'), 1, { still: true });
  ok(F.tint[0] > 230 && F.droop > 0.95, 'the failure did not show while still');
});

check('the pointer is followed only at rest, and never while still', () => {
  const ptr = { x: 1, y: -1 };
  near(M.mascotTarget(st('rest'), { now: 0, t: 0, ptr }).lx, 1, 1e-9, 'rest ignores the pointer');
  near(M.mascotTarget(st('working'), { now: 0, t: 0, ptr }).lx, 0.95, 1e-9, 'working followed the pointer');
  near(M.mascotTarget(st('rest'), { now: 0, t: 0, ptr: null, still: true }).lx, 0, 1e-9, 'followed while still');
});

check('a glance looks away for its moment, then lets go', () => {
  const m = st('rest', { glance: { x: 1, y: -1, happy: 0.6, until: 1000 } });
  near(M.mascotTarget(m, { now: 500, t: 0 }).lx, 1, 1e-9, 'no glance');
  near(M.mascotTarget(m, { now: 1500, t: 0 }).lx, 0, 1e-9, 'the glance never ended');
  near(M.mascotTarget(m, { now: 500, t: 0, waiting: true }).lx, 0, 1e-9, 'glanced away while waiting on you');
});

check('the mouth opens on letters and closes where a word ends', () => {
  ok(M.mascotTalkFor('wor') > 0.5, 'closed mid-word');
  ok(M.mascotTalkFor('ld ') < 0.2, 'open at a space');
  ok(M.mascotTalkFor('end.') < 0.2, 'open at a full stop');
});

check('a turn: thinking → working → writing → done; stopped rests, failed is red until you act', () => {
  const m = M.mascot;
  M.mascotTurnBegan(); ok(m.mood === 'thinking', 'send did not start thinking');
  M.mascotMode('working'); ok(m.mood === 'working', 'tool did not focus');
  M.mascotMode('streaming'); ok(m.mood === 'writing', 'streaming is not writing');
  M.mascotWords('hel'); ok(m.talk > 0.5, 'words did not move the mouth');
  M.mascotTurnEnded({}); ok(m.mood === 'done', 'a landed reply is not done');
  ok(m.talk === 0, 'mouth left open');
  M.mascotTurnBegan(); M.mascotTurnEnded({ stopped: true, failed: true });
  ok(m.mood === 'rest', 'a stopped turn is not rest');
  M.mascotTurnBegan(); M.mascotTurnEnded({ failed: true });
  ok(m.mood === 'error', 'a failed turn is not an error');
  M.mascotActivity(false); ok(m.mood === 'error', 'moving the pointer acknowledged the failure');
  M.mascotActivity(true); ok(m.mood === 'rest', 'input did not acknowledge the failure');
});

check('switching away from a running turn rests the face; words outside writing are ignored', () => {
  const m = M.mascot;
  M.mascotTurnBegan(); M.mascotRest(); ok(m.mood === 'rest', 'still thinking after the view left');
  M.mascotWords('abc'); ok(m.talk === 0, 'talking at rest');
});

check('fidgets: never while waiting or dozing; busy only blinks; at rest a small smile, look or tilt', () => {
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
  ok(M.mascotFidget('waiting', Math.random) === null, 'fidgeted while waiting on you');
  ok(M.mascotFidget('sleep', Math.random) === null, 'fidgeted while dozing');
  for (const p of [0.1, 0.5, 0.7, 0.9, 0.99]) {
    const k = M.mascotFidget('working', seq(p)).kind;
    ok(k === 'blink' || k === 'double', `a busy face did a ${k}`);
  }
  ok(M.mascotFidget('rest', seq(0.1)).kind === 'blink', 'no blink');
  ok(M.mascotFidget('rest', seq(0.5)).kind === 'double', 'no double blink');
  const sm = M.mascotFidget('rest', seq(0.7, 0, 1));
  ok(sm.kind === 'smile', 'no smile change');
  for (const r of [0, 1]) {
    const f = M.mascotFidget('rest', seq(0.7, r));
    ok(f.smile >= -0.08 && f.smile <= 0.22, `smile shift too big (${f.smile})`);
  }
  ok(M.mascotFidget('rest', seq(0.9, 1, 0, 1)).kind === 'look', 'no glance aside');
  const tl = M.mascotFidget('rest', seq(0.99, 1));
  ok(tl.kind === 'tilt' && Math.abs(tl.tilt) <= 4, 'tilt missing or too big');
});

check('a resting fidget changes the face a little, then it settles and stops again', () => {
  const F = M.mascotFace();
  const m = st('rest', { idle: { smile: 0.2, tilt: -3 } });
  ok(run(F, m, 0.1) === true, 'the fidget did not move it');
  ok(run(F, m, 4) === false, 'the fidget never settled');
  near(F.smile, 0.45, 0.01, 'smile'); near(F.tilt, -3, 0.01, 'tilt');
  near(M.mascotTarget(st('working', { idle: { smile: 0.2, tilt: -3 } }), { now: 0, t: 0 }).tilt, 0, 1e-9, 'a busy face kept the fidget');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('all passed');
