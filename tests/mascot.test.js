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
let clock = 0;   // what performance.now() says
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
    performance: { now: () => clock },
    motionOK: () => true,
    isShellTool: (n) => n === 'Bash' || n === 'PowerShell',
    isAgentTool: (n) => n === 'Task' || n === 'Agent',
    state: { live: new Map() },
    els: { input: { value: '', selectionStart: 0, clientWidth: 400 } },
    console, Math, Date,
  };
  return vm.runInNewContext(`${src}\n;({ mascot, mascotFace, mascotTarget, mascotStep, mascotVoice, mascotVoiceFeed, mascotVoiceStep, mascotVoiceBusy, MASCOT_VOICE_MAX, mascotFidget, mascotToolKind, mascotApplyReaction, mascotTool, MASCOT_REACTION_MS, MASCOT_GREEN, MASCOT_AMBER, MASCOT_RED,
    mascotTurnBegan, mascotTurnEnded, mascotMode, mascotRest, mascotWords, mascotActivity, mascotNod,
    MASCOT_ACTS, mascotActPose, mascotApplyAct, mascotQuirk, mascotBoopKind, mascotBoop, mascotPetFeed, mascotNight,
    mascotKey, mascotPlay, MASCOT_QUIRK_GAP_MS, MASCOT_BORED_MS, els,
    mascotThinkBeat, MASCOT_THINK_BEAT_S, mascotTypeReaction })`,
    ctx, { filename: 'mascot.js' });
}

/* Run `secs` of frames at 60fps with the mascot state `m`; returns whether the
 * face still wanted frames at the end. */
function run(F, m, secs, env = {}) {
  let more = true;
  for (let i = 0; i < Math.round(secs * 60); i++) {
    const e = { now: i * 16.7, t: i / 60, ...env };
    e.busy = !e.still && !e.waiting && (m.mood === 'thinking' || m.mood === 'working');
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

check('thinking works through its beats for as long as it lasts, always looking up', () => {
  const F = M.mascotFace();
  ok(run(F, st('thinking'), 3) === true, 'thinking came to rest');
  let lo = Infinity, hi = -Infinity, lift = 0;
  const beats = new Set(), brows = new Set();
  for (let i = 0; i < 1200; i++) {
    const e = { now: 0, t: 3 + i / 60, busy: true };
    M.mascotStep(F, M.mascotTarget(st('thinking'), e), 1 / 60, e);
    lo = Math.min(lo, F.lx); hi = Math.max(hi, F.lx);
    ok(F.ly < -0.25, `stopped looking up (${F.ly.toFixed(2)})`);
    beats.add(M.mascotThinkBeat(e.t));
    brows.add(Math.sign(Math.round(F.browQ * 2)));
    lift = Math.max(lift, Math.abs(F.browA));
  }
  ok(beats.size >= 3, `twenty seconds of thinking used ${beats.size} beats`);
  ok(hi - lo > 0.6, `the eyes never moved from one thought to the next (${hi - lo})`);
  ok(brows.has(1) && brows.has(-1), 'never raised one brow and then the other');
  ok(lift > 0.5, 'the brows never knit');
});

check('thinking beats never repeat back to back, and under still it holds one pose', () => {
  for (let i = 0; i < 400; i++) {
    const t = i * M.MASCOT_THINK_BEAT_S + 0.1;
    ok(M.mascotThinkBeat(t) !== M.mascotThinkBeat(t + M.MASCOT_THINK_BEAT_S), `the same beat twice at ${i}`);
  }
  const a = M.mascotTarget(st('thinking'), { now: 0, t: 1, still: true });
  const b = M.mascotTarget(st('thinking'), { now: 0, t: 40, still: true });
  ok(JSON.stringify(a) === JSON.stringify(b), 'thinking changed while still');
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
  near(M.mascotTarget(st('working'), { now: 0, t: 0, ptr }).lx, M.mascotTarget(st('working'), { now: 0, t: 0 }).lx, 1e-9, 'working followed the pointer');
  near(M.mascotTarget(st('rest'), { now: 0, t: 0, ptr: null, still: true }).lx, 0, 1e-9, 'followed while still');
});

check('a glance looks away for its moment, then lets go', () => {
  const m = st('rest', { glance: { x: 1, y: -1, happy: 0.6, until: 1000 } });
  near(M.mascotTarget(m, { now: 500, t: 0 }).lx, 1, 1e-9, 'no glance');
  near(M.mascotTarget(m, { now: 1500, t: 0 }).lx, 0, 1e-9, 'the glance never ended');
  near(M.mascotTarget(m, { now: 500, t: 0, waiting: true }).lx, 0, 1e-9, 'glanced away while waiting on you');
});

check('revealed text gives it syllables to say, never more than a few, and a pause at a full stop', () => {
  const v = M.mascotVoice();
  M.mascotVoiceFeed(v, 'hel');
  ok(v.queue.length === 1, `one vowel group is not one syllable (${v.queue.length})`);
  M.mascotVoiceFeed(v, 'a long stretch of words arriving all at once');
  ok(v.queue.filter((x) => x === 's').length === M.MASCOT_VOICE_MAX, `owed too much or too little (${v.queue.length})`);
  M.mascotVoiceFeed(v, 'end.');
  ok(v.queue[v.queue.length - 1] === 'p', 'no pause at the end of a sentence');
  M.mascotVoiceFeed(v, ' ');
  ok(v.queue.filter((x) => x === 'p').length === 1, 'pauses stacked');
  const w = M.mascotVoice(); M.mascotVoiceFeed(w, '```');
  ok(w.queue.length === 0, 'talked over text with nothing to say');
});

check('fed faster than speech, it still talks in separate syllables at a speaking pace', () => {
  const v = M.mascotVoice();
  let opens = 0, wasOpen = false, openFor = 0, longest = 0;
  for (let i = 0; i < 180; i++) {   // three seconds of a reply pouring in every frame
    M.mascotVoiceFeed(v, 'streaming words ');
    const open = M.mascotVoiceStep(v, 1 / 60, () => 0.5) > 0.2;
    if (open && !wasOpen) opens++;
    openFor = open ? openFor + 1 : 0;
    longest = Math.max(longest, openFor);
    wasOpen = open;
  }
  ok(opens >= 10 && opens <= 18, `not a speaking pace (${opens} syllables in 3s)`);
  ok(longest * 1000 / 60 < 200, `the mouth stayed open ${Math.round(longest * 1000 / 60)}ms`);
});

check('when the words stop it falls quiet within a second, and stops asking for frames', () => {
  const v = M.mascotVoice();
  for (let i = 0; i < 30; i++) M.mascotVoiceFeed(v, 'more words ');
  let last = 1;
  for (let i = 0; i < 60; i++) last = M.mascotVoiceStep(v, 1 / 60, Math.random);
  ok(!M.mascotVoiceBusy(v), 'still talking a second after the words stopped');
  ok(last === 0, 'mouth left open');
});

check('a turn: thinking → working → writing → done; stopped rests, failed is red until you act', () => {
  const m = M.mascot;
  M.mascotTurnBegan(); ok(m.mood === 'thinking', 'send did not start thinking');
  M.mascotMode('working'); ok(m.mood === 'working', 'tool did not focus');
  M.mascotMode('streaming'); ok(m.mood === 'writing', 'streaming is not writing');
  M.mascotWords('hel'); ok(m.voice.queue.length > 0, 'words gave it nothing to say');
  M.mascotTurnEnded({}); ok(m.mood === 'done', 'a landed reply is not done');
  ok(m.talk === 0 && !M.mascotVoiceBusy(m.voice), 'mouth left open, or still owing words');
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
  M.mascotWords('abc'); ok(!M.mascotVoiceBusy(m.voice), 'talking at rest');
});

check('fidgets: never while waiting or dozing; working may ponder, other busy moods only blink; at rest a small smile, look or tilt', () => {
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
  ok(M.mascotFidget('waiting', Math.random) === null, 'fidgeted while waiting on you');
  ok(M.mascotFidget('sleep', Math.random) === null, 'fidgeted while dozing');
  for (const p of [0.1, 0.5, 0.7, 0.9, 0.99]) {
    const k = M.mascotFidget('writing', seq(p)).kind;
    ok(k === 'blink' || k === 'double', `a writing face did a ${k}`);
  }
  for (const r of [0, 1]) {
    const f = M.mascotFidget('working', seq(0.7, r));
    ok(f.kind === 'look' && f.x < 0 && f.y < -0.5 && f.ms <= 1400, `working did not ponder upward (${JSON.stringify(f)})`);
  }
  ok(M.mascotFidget('working', seq(0.9)).kind === 'blink', 'working never just blinks');
  // At rest (blinks have their own clock) it settles into new poses or does something small.
  ok(M.mascotFidget('rest', seq(0.05)).kind === 'double', 'no double blink');
  for (const r of [0, 1]) {
    const f = M.mascotFidget('rest', seq(0.2, r));
    ok(f.kind === 'smile' && f.smile >= -0.08 && f.smile <= 0.27, `smile shift missing or too big (${JSON.stringify(f)})`);
  }
  ok(M.mascotFidget('rest', seq(0.35, 1, 0)).kind === 'look', 'no glance aside');
  for (const r of [0, 1]) {
    const tl = M.mascotFidget('rest', seq(0.5, r));
    ok(tl.kind === 'tilt' && Math.abs(tl.tilt) <= 6, `tilt missing or too big (${JSON.stringify(tl)})`);
  }
  const mo = M.mascotFidget('rest', seq(0.65, 1, 0));
  ok(mo.kind === 'mouth' && Math.abs(mo.mx) <= 0.7 && Math.abs(mo.skew) <= 0.45, `no mouth shift (${JSON.stringify(mo)})`);
  ok(M.mascotFidget('rest', seq(0.75, 1)).kind === 'brow', 'no brow shift');
  const acts = [0.85, 0.9, 0.99].map((p) => M.mascotFidget('rest', seq(p)));
  ok(acts.every((f) => f.kind === 'act' && M.MASCOT_ACTS[f.act]), `small acts missing (${JSON.stringify(acts)})`);
  ok(new Set(acts.map((f) => f.act)).size === 3, 'the small acts are all the same');
});

check('a settled pose (mouth aside, brows up) shows only at rest, and holds still', () => {
  const F = M.mascotFace();
  const m = st('rest', { idle: { smile: 0, tilt: 0, mx: 0.6, skew: -0.3, brow: 0.25 } });
  ok(run(F, m, 4) === false, 'the pose never settled');
  near(F.mx, 0.6, 0.01, 'mouth aside'); near(F.skew, -0.3, 0.01, 'skew'); near(F.brow, 0.25, 0.01, 'brows');
  const w = M.mascotTarget(st('writing', { idle: m.idle }), { now: 0, t: 0 });
  ok(w.mx === 0 && w.skew === 0, 'a busy face kept the resting pose');
});

check('eye darts move the eyes at rest only — not while busy, hovered, waiting or still', () => {
  const sacc = { x: 0.2, y: -0.1 };
  near(M.mascotTarget(st('rest', { sacc }), { now: 0, t: 0 }).lx, 0.2, 1e-9, 'no dart at rest');
  near(M.mascotTarget(st('rest', { sacc }), { now: 0, t: 0, still: true }).lx, 0, 1e-9, 'darted while still');
  near(M.mascotTarget(st('rest', { sacc, hover: true }), { now: 0, t: 0 }).lx, 0, 1e-9, 'darted while hovered');
  near(M.mascotTarget(st('working', { sacc }), { now: 0, t: 0, still: true }).lx,
    M.mascotTarget(st('working'), { now: 0, t: 0, still: true }).lx, 1e-9, 'darted while working');
  near(M.mascotTarget(st('rest', { sacc }), { now: 0, t: 0, waiting: true }).lx, 0, 1e-9, 'darted while waiting on you');
});

check('following the pointer, it turns its head toward it', () => {
  const t = M.mascotTarget(st('rest'), { now: 0, t: 0, ptr: { x: 1, y: -1 } });
  ok(t.tilt > 2 && t.brow > 0.2, `no head turn or brow lift (${t.tilt}, ${t.brow})`);
});

check('a resting fidget changes the face a little, then it settles and stops again', () => {
  const F = M.mascotFace();
  const m = st('rest', { idle: { smile: 0.2, tilt: -3 } });
  ok(run(F, m, 0.1) === true, 'the fidget did not move it');
  ok(run(F, m, 4) === false, 'the fidget never settled');
  near(F.smile, 0.45, 0.01, 'smile'); near(F.tilt, -3, 0.01, 'tilt');
  near(M.mascotTarget(st('working', { idle: { smile: 0.2, tilt: -3 } }), { now: 0, t: 0 }).tilt, 0, 1e-9, 'a busy face kept the fidget');
});

check('each kind of step is told apart', () => {
  const kinds = { Read: 'look', Grep: 'look', WebSearch: 'look', Edit: 'change', Write: 'change',
    mcp__krystal__artifact: 'change', Bash: 'run', PowerShell: 'run', Task: 'agent', TodoWrite: 'other', '': 'other' };
  for (const [name, kind] of Object.entries(kinds)) ok(M.mascotToolKind(name) === kind, `${name || '(none)'} is not ${kind}`);
});

check('a step reaction shows while it lasts, then gives the face back to the work', () => {
  const work = () => M.mascotTarget(st('working'), { now: 0, t: 0, still: true });
  for (const kind of Object.keys(M.MASCOT_REACTION_MS)) {
    const react = { kind, at: 1000 };
    const t = work();
    ok(M.mascotApplyReaction(t, react, 1000 + M.MASCOT_REACTION_MS[kind] / 2) === true, `${kind} ended early`);
    ok(JSON.stringify(t) !== JSON.stringify(work()), `${kind} changed nothing`);
    const after = work();
    ok(M.mascotApplyReaction(after, react, 1000 + M.MASCOT_REACTION_MS[kind]) === false, `${kind} never ended`);
    ok(JSON.stringify(after) === JSON.stringify(work()), `${kind} left a trace`);
  }
  // A scan sweeps across: the eyes start left and finish right.
  const a = work(), b = work();
  M.mascotApplyReaction(a, { kind: 'look', at: 0 }, 10);
  M.mascotApplyReaction(b, { kind: 'look', at: 0 }, M.MASCOT_REACTION_MS.look - 10);
  ok(b.lx - a.lx > 0.5, 'the scan did not sweep');
  // Only while it works or thinks, and never over a face that waits on you.
  const r = { kind: 'agent', at: 0 };
  ok(M.mascotTarget(st('working', { react: r }), { now: 100, t: 0, still: true }).happy > 0.3, 'no reaction while working');
  ok(M.mascotTarget(st('working', { react: r }), { now: 100, t: 0, still: true, waiting: true }).happy === 0, 'reacted while waiting');
  ok(M.mascotTarget(st('rest', { react: r }), { now: 100, t: 0, still: true }).happy === 0, 'reacted at rest');
});

check('working drifts over the work, less than thinking, and holds still when still', () => {
  const span = (mood, still) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 1200; i++) {
      const x = M.mascotTarget(st(mood), { now: 0, t: i / 30, still }).lx;
      lo = Math.min(lo, x); hi = Math.max(hi, x);
    }
    return hi - lo;
  };
  const w = span('working', false);
  ok(w > 0.08, `working did not drift (${w})`);
  ok(w < span('thinking', false), 'working drifted as much as thinking');
  ok(span('working', true) === 0, 'drifted while still');
  const F = M.mascotFace();
  ok(run(F, st('working'), 3) === true, 'working came to rest while the step ran');
});

check('a step reacts once, however often its event comes, and parallel steps share a reaction', () => {
  const m = M.mascot;
  clock = 10000;
  M.mascotTool({ id: 'a', name: 'Read' });
  ok(m.react && m.react.kind === 'look' && m.react.at === 10000, 'no reaction to a new step');
  clock = 10500;
  M.mascotTool({ id: 'a', name: 'Read', detail: 'x' });
  ok(m.react.at === 10000, 'the same step reacted twice');
  clock = 10600;
  M.mascotTool({ id: 'b', name: 'Edit' });
  ok(m.react.kind === 'change', 'a new step did not react');
  clock = 10700;
  M.mascotTool({ id: 'c', name: 'Bash' });
  ok(m.react.kind === 'change', 'a parallel step stacked a second reaction');
  fx = false; clock = 20000;
  M.mascotTool({ id: 'd', name: 'Bash' });
  ok(m.react.kind === 'change', 'reacted with Extra effects off');
  fx = true;
});

/* Play act `name` over mood `mood` from a resting face; returns the face, the
 * biggest change it made, and whether it asked for frames once the act was over. */
function playAct(name, mood = 'rest') {
  const F = M.mascotFace();
  const m = st(mood, { act: { name, at: 0, cue: 0 } });
  const ms = M.MASCOT_ACTS[name].ms;
  let moved = 0;
  const rest = M.mascotTarget(st(mood), { now: 0, t: 0, still: true });
  for (let i = 0; i < Math.round((ms + 5000) / 16.7); i++) {
    const now = i * 16.7;
    const e = { now, t: now / 1000, busy: now < ms };
    const t = M.mascotTarget(m, e);
    for (const k of ['open', 'happy', 'smile', 'brow', 'browA', 'browQ', 'blush', 'scrunch', 'talk', 'lx', 'ly', 'tilt'])
      moved = Math.max(moved, Math.abs(t[k] - rest[k]));
    M.mascotStep(F, t, 1 / 60, e);
  }
  const e = { now: ms + 5100, t: 0, busy: false };
  return { F, moved, more: M.mascotStep(F, M.mascotTarget(m, e), 1 / 60, e) };
}

check('every act changes the face while it plays, then hands it back and lets the loop stop', () => {
  for (const name of Object.keys(M.MASCOT_ACTS)) {
    const { F, moved, more } = playAct(name);
    ok(moved > 0.3, `${name} hardly showed (${moved.toFixed(2)})`);
    ok(more === false, `${name} never settled`);
    near(F.open, 1, 0.02, `${name} open`); near(F.blush, 0, 0.02, `${name} blush`);
    near(F.scrunch, 0, 0.02, `${name} scrunch`); near(F.brow, 0, 0.02, `${name} brow`);
  }
});

check('acts never show over a face that waits on you, sleeps, or is still', () => {
  const m = st('rest', { act: { name: 'giggle', at: 0, cue: 0 } });
  const mid = { now: 300, t: 0 };
  ok(M.mascotTarget(m, mid).scrunch > 0.5, 'the giggle did not show');
  ok(M.mascotTarget(m, { ...mid, waiting: true }).scrunch === 0, 'giggled while waiting on you');
  ok(M.mascotTarget(m, { ...mid, still: true }).scrunch === 0, 'giggled while still');
  ok(M.mascotTarget(st('sleep', { act: m.act }), mid).scrunch === 0, 'giggled asleep');
  ok(M.mascotTarget(m, { now: 2000, t: 0 }).scrunch === 0, 'the giggle never ended');
});

check('quirks: never waiting or asleep; boredom only after a while and spaced out; sooner at night', () => {
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
  const ctx = (o) => ({ quiet: 0, since: 1e9, night: false, steps: 0, ...o });
  for (const mood of ['waiting', 'sleep']) ok(M.mascotQuirk(mood, seq(0), ctx({ quiet: 1e9 })) === null, `a quirk while ${mood}`);
  ok(M.mascotQuirk('rest', seq(0.2), ctx({ quiet: 1000 })) === null, 'bored after a second');
  ok(M.mascotQuirk('rest', seq(0.01), ctx({ quiet: 1000 })).act === 'sneeze', 'never sneezes');
  const bored = M.mascotQuirk('rest', seq(0.2, 0.5), ctx({ quiet: M.MASCOT_BORED_MS + 1 }));
  ok(bored && M.MASCOT_ACTS[bored.act].idle, `not bored after a while (${JSON.stringify(bored)})`);
  ok(M.mascotQuirk('rest', seq(0.2), ctx({ quiet: 1e9, since: M.MASCOT_QUIRK_GAP_MS - 1 })) === null, 'quirks not spaced out');
  ok(M.mascotQuirk('rest', seq(0.9), ctx({ quiet: 1e9 })) === null, 'a quirk on every tick');
  const q = M.MASCOT_BORED_MS * 0.7;
  ok(M.mascotQuirk('rest', seq(0.2, 0.9), ctx({ quiet: q })) === null, 'bored early by day');
  ok(M.mascotQuirk('rest', seq(0.2, 0.9), ctx({ quiet: q, night: true })) !== null, 'not bored sooner at night');
  ok(['nodoff', 'yawn'].includes(M.mascotQuirk('drowsy', seq(0.3), ctx({})).act), 'drowsy without nodding off');
  ok(M.mascotQuirk('thinking', seq(0.1), ctx({})).act === 'ponder', 'a long think never pondered');
  ok(M.mascotQuirk('working', seq(0.1), ctx({ steps: 3 })) === null, 'sweating over three steps');
  ok(M.mascotQuirk('working', seq(0.1), ctx({ steps: 30 })).puff === 'drop', 'no sweat after many steps');
  ok(M.mascotQuirk('writing', seq(0.01), ctx({ quiet: 1e9 })) === null, 'a quirk while writing');
});

check('clicks add up: a wink, a giggle, dizzy, then a huff that ignores more clicks', () => {
  const kinds = [1, 2, 3, 4, 6, 7, 12].map(M.mascotBoopKind);
  ok(kinds.join() === 'wink,giggle,giggle,dizzy,dizzy,huff,huff', kinds.join());
  const m = M.mascot;
  m.act = null; m.mood = 'rest'; m.boops = 0;
  clock = 50000;
  M.mascotBoop(); ok(!m.act, 'one click played an act');
  clock += 300; M.mascotBoop(); ok(m.act && m.act.name === 'giggle', 'two clicks no giggle');
  clock += 300; M.mascotBoop(); clock += 300; M.mascotBoop();
  ok(m.act.name === 'dizzy', 'four clicks not dizzy');
  for (let i = 0; i < 3; i++) { clock += 300; M.mascotBoop(); }
  ok(m.act.name === 'huff', 'seven clicks no huff');
  const at = m.act.at;
  clock += 300; M.mascotBoop();
  ok(m.act.name === 'huff' && m.act.at === at, 'clicking a huffing face started something else');
  clock += 10000; M.mascotBoop();
  ok(m.boops === 1, 'clicks far apart still added up');
  m.act = null;
});

check('petting is a rub back and forth, not just passing over', () => {
  const pet = () => ({ x: null, dir: 0, flips: [] });
  let p = pet(), on = false;
  [0, 20, 0, 20, 0, 20].forEach((x, i) => { on = M.mascotPetFeed(p, x, i * 100); });
  ok(on, 'a quick rub was not petting');
  p = pet(); on = false;
  [0, 20, 0, 20, 0, 20].forEach((x, i) => { on = M.mascotPetFeed(p, x, i * 600); });
  ok(!on, 'slow sweeps counted as petting');
  p = pet(); on = false;
  for (let i = 0; i < 20; i++) on = M.mascotPetFeed(p, i * 5, i * 30);
  ok(!on, 'passing straight over counted as petting');
});

check('drowsy: heavy lids, then it holds still', () => {
  const F = M.mascotFace();
  ok(run(F, st('drowsy'), 5) === false, 'drowsy kept moving');
  ok(F.open < 0.5 && F.open > 0.2, `lids not heavy (${F.open})`);
  ok(M.mascotNight(23) && M.mascotNight(3) && !M.mascotNight(12) && !M.mascotNight(7), 'night is the wrong hours');
});

check('typing: a "?" makes it curious, wiping out text a wince, a thanks a blush (once a message)', () => {
  const m = M.mascot, input = M.els.input;
  const type = (value) => { input.value = value; input.selectionStart = value.length; M.mascotKey(); };
  m.mood = 'rest'; m.act = null; m.inLen = 0; m.kind = false;
  clock = 100000;
  type('how does this work?');   // a paste: grew by more than one, so no reaction
  ok(!m.act, 'reacted to a paste');
  type('how does this work??');
  ok(m.act && m.act.name === 'curious', 'no curiosity at a "?"');
  m.act = null; clock += 5000;
  type('');
  ok(m.act && m.act.name === 'wince', 'wiping it all out got no wince');
  m.act = null;
  type('great, thanks'); type('great, thanks!');
  ok(m.act && m.act.name === 'shy', 'a thanks got no blush');
  m.act = null;
  type('great, thanks! thanks'); type('great, thanks! thanks!');
  ok(!m.act || m.act.name !== 'shy', 'blushed twice in one message');
  m.mood = 'rest'; m.act = null;
});

check('what you type gets its own reaction', () => {
  const R = (before, ch) => M.mascotTypeReaction(before + ch, (before + ch).length, ch.length, false);
  ok(R('so', '!') === 'excite', '"!" no excitement');
  ok(R('well..', '.') === 'skeptic', '"..." no raised brow');
  ok(R('ok :', ')') === 'grin' && R('lol x', 'D') === 'grin', 'a smiley got no grin');
  ok(R('oh no :', '(') === 'pout', 'a sad face got no pout');
  ok(R('THIS IS BROKE', 'N') === 'shout', 'caps got no reaction');
  ok(R('OK', 'S') !== 'shout', 'a short acronym read as shouting');
  ok(R('one', ' ') === 'nod' && R('one', '\n') === 'nod', 'no nod at the end of a word');
  ok(R('wor', 'd') === null, 'reacted to an ordinary letter');
  ok(M.mascotTypeReaction('abc', 3, -1, false) === 'oops', 'a backspace got no oops');
  ok(M.mascotTypeReaction('a'.repeat(300), 300, 1, false) === 'whoa', 'a long message got no whoa');
  ok(M.mascotTypeReaction('a'.repeat(301), 301, 1, false) === null, 'whoa again past the mark');
  ok(M.mascotTypeReaction('cool thanks!', 12, 1, true) === 'excite', 'a second thanks blushed again');
});

check('typing mouths along under its breath — smaller than speaking — and a send hushes it', () => {
  const m = M.mascot, input = M.els.input;
  m.mood = 'rest'; m.inLen = 0; m.act = null;
  input.value = 'a'; input.selectionStart = 1; M.mascotKey();
  ok(M.mascotVoiceBusy(m.voice), 'typing a vowel gave it nothing to mouth');
  const t = M.mascotTarget({ ...st('typing'), talk: 1 }, { now: 0, t: 0 });
  ok(t.talk > 0 && t.talk < 0.5, `mouthing as loud as speech (${t.talk})`);
  M.mascotTurnBegan();
  ok(!M.mascotVoiceBusy(m.voice), 'still mouthing after the send');
  M.mascotTurnEnded({}); m.act = null; m.mood = 'rest';
});

check('a long turn lands with a celebration; a quick one or a failure does not', () => {
  const m = M.mascot;
  clock = 200000;
  M.mascotTurnBegan(); clock += 1000; M.mascotTurnEnded({});
  ok(!m.act, 'a quick reply got a celebration');
  M.mascotTurnBegan(); clock += 60000; M.mascotTurnEnded({});
  ok(m.act && m.act.name === 'wiggle', 'a long haul landed without a celebration');
  M.mascotTurnBegan(); clock += 60000; M.mascotTurnEnded({ failed: true });
  ok(!m.act && m.mood === 'error', 'celebrated a failure');
  M.mascotTurnBegan();
  for (let i = 0; i < 16; i++) { clock += 400; M.mascotTool({ id: 'many' + i, name: 'Read' }); }
  clock += 2000; M.mascotTurnEnded({});
  ok(m.act && m.act.name === 'wiggle', 'many steps landed without a celebration');
  m.act = null;
});

check('a long think that turns into words lights it up', () => {
  const m = M.mascot;
  clock = 300000;
  M.mascotTurnBegan(); clock += 1000; M.mascotMode('streaming');
  ok(!m.act, 'eureka after a second');
  M.mascotTurnBegan(); clock += 8000; M.mascotMode('streaming');
  ok(m.act && m.act.name === 'eureka', 'no eureka after a long think');
  M.mascotTurnEnded({}); m.act = null;
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('all passed');
