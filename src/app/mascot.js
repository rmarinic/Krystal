/* mascot.js     — the crystal in the logo: a small face that answers what the app is doing.
   Part of the chat frontend; shares one global scope (see core.js). Styles live
   in css/mascot.css; every `.logo-mascot` in index.html gets one.

   It follows the same rule as the living light (light.js): every movement it
   makes answers something real, and when nothing is happening it holds still.

     • you type     — it watches, its eyes following the caret along the line;
     • you send     — a small hop, eyes following the message up;
     • thinking     — it looks up, with a slow drift that never repeats (unrelated
                      sines, the light's flicker) — the one ongoing movement, and
                      it lasts exactly as long as the thinking does;
     • a tool runs  — it looks at the work, focused, with a slower, smaller drift
                      than thinking's. Each new step gets a small reaction of its
                      own kind (mascotToolKind): reading or searching sweeps the
                      eyes across like scanning a line, an edit looks down and
                      squints, a command widens the eyes, handing work to a helper
                      agent glances up hopefully. When the step hands back its
                      result it nods once. Both are rate-limited, so parallel steps
                      don't stack;
     • the reply    — it talks: the words the typer reveals give it syllables to
                      say (one per vowel group, a pause where a sentence ends),
                      and it says them at a speaking pace, each one an open and a
                      shut. Text streams far faster than anyone talks, so it only
                      ever owes the text a few syllables (MASCOT_VOICE_MAX): it
                      keeps a steady rhythm while words flow and falls quiet soon
                      after they stop;
     • it lands     — happy eyes, KRYSTAL ripples once, then it settles to rest
                      with a blink;
     • needs you    — a permission prompt (in any chat) turns it amber, looking
                      straight out, perfectly still;
     • failed       — red, eyes drooping, one shake, until you look (any input) or
                      a few seconds pass;
     • elsewhere    — a reply that lands in a chat you can't see makes it glance at
                      the bell;
     • scene change — switching chats, coming back to the window: a blink;
     • left alone   — after a few minutes with no input and no turn running, its
                      eyes close, and nothing moves until you're back.

   Between those, it fidgets now and then, the way a face does: a blink (once in a
   while two), and at rest a slightly different smile, a glance aside, a small tilt
   of the head, and while it works a glance up now and then, as if pondering
   what the step will turn up. These come at random intervals and are picked at random, so there
   is no rhythm for the eye to learn, and each one settles and lets the loop stop
   again. They are the maintainer's deliberate exception to "rest is still" — so
   never while it waits on you (that stillness is the signal) or dozes.

   At rest the pointer is the only thing it follows. Hover makes it happy, a click
   gets a squish and a wink. The rAF loop runs only while something is settling
   and stops at rest. With Extra effects off (body.fx-on) or under reduced motion
   it still shows the state — expression and colour — but without the movement:
   no hops, nods, drift, blinks or pointer following. */

// The crystal's geometry, in its 64×64 viewBox.
const MASCOT_EYES = [[23, 34], [41, 34]];
const MASCOT_EYE_W = 8.5, MASCOT_EYE_H = 10;
const MASCOT_MOUTH = [32, 45.5], MASCOT_MOUTH_W = 7;
const MASCOT_LOOK = [4, 3];        // how far the eyes travel at full look
const MASCOT_GREEN = [143, 224, 170], MASCOT_AMBER = [240, 178, 104], MASCOT_RED = [236, 122, 122];
// [catch, release]: fast toward a new expression, slow letting go of it.
const MASCOT_TAU = { lx: [0.11, 0.16], ly: [0.11, 0.16], open: [0.07, 0.12], happy: [0.12, 0.45],
  smile: [0.18, 0.4], droop: [0.2, 0.5], mw: [0.1, 0.2], glow: [0.14, 0.9], tilt: [0.18, 0.45], talk: [0.035, 0.04] };
const MASCOT_IDLE_MS = 3 * 60 * 1000;   // no input and no turn for this long: it dozes
const MASCOT_DONE_MS = 1500;            // happy after a reply lands, then rest
const MASCOT_ERROR_MS = 6000;           // red after a failure, unless you look sooner
const MASCOT_TYPING_MS = 1500;          // still watching this long after the last key
const MASCOT_NOD_GAP_MS = 350;          // parallel tool results shouldn't stack nods
const MASCOT_FIDGET_MS = [3500, 10000]; // a fidget comes somewhere in this window after the last
const MASCOT_SYLLABLE_MS = [150, 230];  // one syllable, open then shut: about five a second
const MASCOT_PAUSE_MS = 260;            // the mouth rests this long where a sentence ends
const MASCOT_VOICE_MAX = 4;             // syllables it may owe the text, so it stops soon after the text does
const MASCOT_STEP_GAP_MS = 300;         // parallel steps starting together get one reaction
// How long each kind of step's reaction lasts (see mascotApplyReaction).
const MASCOT_REACTION_MS = { look: 600, change: 650, run: 450, agent: 800, other: 350 };
const MASCOT_LOOK_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'NotebookRead']);
const MASCOT_CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'mcp__krystal__artifact']);

function mascotFace() {
  return { lx: 0, ly: 0, open: 1, happy: 0, smile: 0.25, droop: 0, mw: 1, glow: 0.22, tilt: 0, talk: 0,
    tint: MASCOT_GREEN.slice(), beat: 0, bobY: 0, bobV: 0, sqY: 0, sqV: 0, shX: 0, shV: 0, blink: null };
}

const mascot = {
  mood: 'rest',     // rest | typing | thinking | working | writing | done | error | sleep (waiting is read live)
  face: mascotFace(),
  hover: false,
  ptrAt: null,      // the pointer in client coordinates, while it's in the window
  caret: 0.6,       // how far along the line the caret is, 0..1
  glance: null,     // { x, y, happy, until } — a look somewhere for a moment
  talk: 0,          // the mouth's target, set each frame by the voice while it writes
  voice: mascotVoice(),   // the syllables the revealed text has given it to say
  idle: { smile: 0, tilt: 0 },   // the resting face's current fidget: a touch more or less smile, a tilt
  react: null,      // { kind, at } — the reaction to the step that just started
  steps: [],        // ids of the steps already reacted to (a step's event comes twice)
  moodT: 0, typingT: 0, idleT: 0, fidgetT: 0, nodAt: 0, stepAt: -1e9,
  lastAct: 0,
  raf: 0, last: 0,
  insts: [],
};

/* What the face should look like: one expression per mood, then the glance, the
 * hover and the pointer on top. Pure — `m` is the mascot's state, `env` the world
 * ({ now (ms), t (s), waiting, still, ptr: {x, y} relative to the face }). */
function mascotTarget(m, env) {
  const mood = env.waiting ? 'waiting' : m.mood;
  const t = { lx: 0, ly: 0, open: 1, happy: 0, smile: 0.25, droop: 0, mw: 1, glow: 0.22, tilt: 0, talk: 0, tint: MASCOT_GREEN };
  if (mood === 'typing') { t.lx = m.caret; t.ly = 0.75; t.open = 1.08; t.smile = 0.35; t.glow = 0.36; }
  else if (mood === 'thinking') {
    t.lx = -0.55; t.ly = -0.75; t.open = 0.82; t.smile = 0; t.glow = 0.42;
    if (!env.still) {
      t.lx += 0.22 * (Math.sin(env.t * 1.31) + Math.sin(env.t * 2.07 + 1.3)) / 2;
      t.ly += 0.18 * (Math.sin(env.t * 1.73 + 0.4) + Math.sin(env.t * 0.93 + 2)) / 2;
    }
  }
  else if (mood === 'working') {
    t.lx = 0.95; t.ly = 0.15; t.open = 0.84; t.droop = -0.35; t.smile = 0.05; t.glow = 0.48;
    if (!env.still) {   // its eyes move over the work: slower and smaller than thinking's drift
      t.lx += 0.12 * (Math.sin(env.t * 1.07 + 0.6) + Math.sin(env.t * 1.89 + 2.1)) / 2;
      t.ly += 0.1 * (Math.sin(env.t * 1.51) + Math.sin(env.t * 0.71 + 1.1)) / 2;
    }
  }
  else if (mood === 'writing') { t.lx = 0.9; t.ly = 0.3; t.smile = 0.3; t.glow = 0.5; t.talk = env.still ? 0.25 : m.talk; }
  else if (mood === 'waiting') { t.open = 1.12; t.smile = 0; t.mw = 0.5; t.talk = 0.45; t.glow = 0.6; t.tint = MASCOT_AMBER; }
  else if (mood === 'done') { t.happy = 1; t.smile = 0.85; t.glow = 0.66; t.tilt = -5; }
  else if (mood === 'error') { t.droop = 1; t.open = 0.72; t.smile = -0.75; t.glow = 0.45; t.ly = 0.35; t.tint = MASCOT_RED; }
  else if (mood === 'sleep') { t.open = 0.04; t.ly = 0.45; t.smile = 0.12; t.glow = 0.06; t.tilt = 4; }
  else if (mood === 'rest' && m.idle) { t.smile += m.idle.smile; t.tilt += m.idle.tilt; }
  if ((mood === 'working' || mood === 'thinking') && m.react) mascotApplyReaction(t, m.react, env.now);

  const calm = mood === 'rest' || mood === 'done';
  if (m.glance && env.now < m.glance.until && mood !== 'waiting') {
    t.lx = m.glance.x; t.ly = m.glance.y;
    t.happy = Math.max(t.happy, m.glance.happy || 0);
    t.smile = Math.max(t.smile, 0.5);
  } else if (m.hover && (calm || mood === 'typing')) {
    t.happy = Math.max(t.happy, 0.85); t.smile = 0.7; t.tilt = 6; t.glow += 0.2;
  } else if (!env.still && env.ptr && calm) {
    t.lx = env.ptr.x; t.ly = env.ptr.y;
  }
  return t;
}

/* What kind of step a tool is, for the face's reaction to it starting. */
function mascotToolKind(name) {
  if (MASCOT_LOOK_TOOLS.has(name)) return 'look';
  if (MASCOT_CHANGE_TOOLS.has(name)) return 'change';
  if (isShellTool(name)) return 'run';
  if (isAgentTool(name)) return 'agent';
  return 'other';
}

/* The reaction to a step that just started, laid over the working face while it
 * lasts. Pure; says whether it is still going. */
function mascotApplyReaction(t, react, now) {
  const age = now - react.at, dur = MASCOT_REACTION_MS[react.kind] || 0;
  if (age < 0 || age >= dur) return false;
  const p = age / dur;
  if (react.kind === 'look') { t.lx = 0.35 + 0.65 * p; t.ly = 0.45 - 0.35 * p; t.open = 0.95; }   // scans a line
  else if (react.kind === 'change') { t.lx = 0.75; t.ly = 0.55; t.open = 0.7; t.droop = -0.55; } // looks down, concentrating
  else if (react.kind === 'run') { t.lx = 1; t.ly = 0; t.open = 1.1; }                           // eyes widen: off it goes
  else if (react.kind === 'agent') { t.lx = 0.85; t.ly = -0.65; t.happy = 0.45; t.smile = 0.4; } // a hopeful glance up
  else { t.lx = 0.6; t.ly = -0.3; }
  return true;
}

function mascotSpring(y, v, dt, k, c) {
  const n = Math.ceil(dt / 0.008), h = dt / n;
  for (let i = 0; i < n; i++) { v += (-k * y - c * v) * h; y += v * h; }
  return [y, v];
}

/* One step of the face toward `t`, pure. `busy` says something time-driven is
 * going on (thinking's drift, a glance); returns whether there is anything left
 * to animate. Under `still`, expressions snap over a short fade and nothing
 * bounces. */
function mascotStep(F, t, dt, env) {
  for (const k in MASCOT_TAU) {
    const tau = env.still ? 0.09 : (Math.abs(t[k]) >= Math.abs(F[k]) ? MASCOT_TAU[k][0] : MASCOT_TAU[k][1]);
    F[k] = t[k] + (F[k] - t[k]) * Math.exp(-dt / tau);
  }
  const away = t.tint !== MASCOT_GREEN;   // colour comes fast and leaves slowly
  for (let i = 0; i < 3; i++) {
    const tau = env.still ? 0.1 : (away ? 0.3 : 1.4);
    F.tint[i] = t.tint[i] + (F.tint[i] - t.tint[i]) * Math.exp(-dt / tau);
  }
  F.beat *= Math.exp(-dt / 0.45);
  if (env.still) {
    F.bobY = F.bobV = F.sqY = F.sqV = F.shX = F.shV = 0;
    F.blink = null;
  } else {
    [F.bobY, F.bobV] = mascotSpring(F.bobY, F.bobV, dt, 240, 15);
    [F.sqY, F.sqV] = mascotSpring(F.sqY, F.sqV, dt, 300, 14);
    [F.shX, F.shV] = mascotSpring(F.shX, F.shV, dt, 700, 9);
    if (F.blink) { F.blink.t += dt; if (F.blink.t >= F.blink.dur) F.blink = null; }
  }
  if (env.busy || F.blink) return true;
  for (const k in MASCOT_TAU) if (Math.abs(F[k] - t[k]) > 0.003) return true;
  for (let i = 0; i < 3; i++) if (Math.abs(F.tint[i] - t.tint[i]) > 0.5) return true;
  return [F.bobY, F.bobV, F.sqY, F.sqV, F.shX, F.shV].some((v) => Math.abs(v) > 0.01) || F.beat > 0.004;
}

/* Pick a fidget, pure: `r` is a source of random numbers in 0..1. Busy moods
 * mostly blink (the face is watching the work), and while a step runs it may
 * look up to ponder; at rest it may also change its smile, glance aside or tilt
 * its head. Waiting on you and dozing get nothing at all. */
function mascotFidget(mood, r) {
  if (mood === 'waiting' || mood === 'sleep') return null;
  const p = r();
  if (p < 0.45) return { kind: 'blink' };
  if (p < 0.55) return { kind: 'double' };
  if (mood === 'working' && p < 0.85) return { kind: 'look', x: -0.3 - r() * 0.3, y: -0.6 - r() * 0.2, ms: 800 + r() * 600 };
  if (mood !== 'rest') return { kind: 'blink' };
  if (p < 0.8) return { kind: 'smile', smile: -0.08 + r() * 0.3 };
  if (p < 0.92) return { kind: 'look', x: (r() * 2 - 1) * 0.7, y: (r() * 2 - 1) * 0.5, ms: 700 + r() * 900 };
  return { kind: 'tilt', tilt: (r() * 2 - 1) * 4 };
}

/* The face's voice: what the revealed text has given it to say ('s' a syllable,
 * 'p' a pause) and the one it is saying now. */
function mascotVoice() {
  return { queue: [], cur: null };
}

/* Revealed text gives it something to say: a syllable per vowel group, and a
 * pause where a sentence or line ends. It never owes more than MASCOT_VOICE_MAX
 * syllables — text streams much faster than speech, and a long debt would keep
 * it talking well after the words stopped. */
function mascotVoiceFeed(v, chunk) {
  const syllables = (chunk.match(/[aeiouyáéíóúàèìòùäëïöüâêîôû]+/gi) || []).length;
  for (let i = 0; i < syllables && v.queue.length < MASCOT_VOICE_MAX; i++) v.queue.push('s');
  if (/[.!?…]\s*$|\n/.test(chunk) && v.queue[v.queue.length - 1] !== 'p') v.queue.push('p');
}

/* One step of the voice, pure: how open the mouth is now. Each syllable opens and
 * shuts within its first 60%, then the mouth stays shut for the rest, so even a
 * full queue reads as separate syllables, never as a mouth held open. `r` gives
 * each syllable its own length and size, so the rhythm doesn't tick. */
function mascotVoiceStep(v, dt, r) {
  if (!v.cur && v.queue.length) {
    const [lo, hi] = MASCOT_SYLLABLE_MS;
    v.cur = v.queue.shift() === 'p'
      ? { pause: true, t: 0, dur: MASCOT_PAUSE_MS, amp: 0 }
      : { pause: false, t: 0, dur: lo + r() * (hi - lo), amp: 0.55 + r() * 0.4 };
  }
  if (!v.cur) return 0;
  const p = v.cur.t / v.cur.dur;
  const open = v.cur.pause || p >= 0.6 ? 0 : v.cur.amp * Math.sin(Math.PI * p / 0.6);
  v.cur.t += dt * 1000;
  if (v.cur.t >= v.cur.dur) v.cur = null;
  return open;
}

function mascotVoiceBusy(v) {
  return !!v.cur || v.queue.length > 0;
}

/* ------------------------------ drawing -------------------------------- */

/* A rounded lens that bends into a ^ arch as `happy` rises. */
function mascotEyePath(cx, cy, w, h, happy) {
  const l = cx - w / 2, r = cx + w / 2, a = h * 0.667 * (1 + 0.3 * happy), b = h * 0.667 * (1 - 1.65 * happy);
  const f = (n) => n.toFixed(2);
  return `M${f(l)},${f(cy)}C${f(l)},${f(cy - a)} ${f(r)},${f(cy - a)} ${f(r)},${f(cy)}C${f(r)},${f(cy + b)} ${f(l)},${f(cy + b)} ${f(l)},${f(cy)}Z`;
}
function mascotMouthPath(mx, my, w, smile, talk) {
  const l = mx - w / 2, r = mx + w / 2, ey = my - smile * 1.4;
  const tc = my + smile * 3 - talk * 1.2, bc = my + smile * 3 + talk * 5.5;
  const f = (n) => n.toFixed(2);
  return `M${f(l)},${f(ey)}Q${f(mx)},${f(tc)} ${f(r)},${f(ey)}Q${f(mx)},${f(bc)} ${f(l)},${f(ey)}Z`;
}
function mascotBlinkFactor(F, side) {
  const b = F.blink;
  if (!b || (b.eye !== 'both' && b.eye !== side)) return 1;
  const p = b.t / b.dur, shut = p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6;   // shuts fast, opens slower
  return 1 - 0.95 * Math.max(0, Math.min(1, shut));
}

function mascotSvg(u) {
  return `<div class="mascot-lamp"></div><svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${u}s" x1="0" y1="0" x2=".6" y2="1"><stop class="s1" offset="0"/><stop class="s2" offset=".55"/><stop class="s3" offset="1"/></linearGradient>
      <linearGradient id="${u}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17221b"/><stop offset="1" stop-color="#0a110c"/></linearGradient>
      <filter id="${u}b" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="2.4"/></filter>
    </defs>
    <g class="head">
      <polygon points="32,2.5 58,16.5 58,46.5 32,61.5 6,46.5 6,16.5" fill="url(#${u}f)" stroke="url(#${u}s)" stroke-width="2.2" stroke-linejoin="round"/>
      <g class="facet" fill="none" stroke-width="1" stroke-linejoin="round" opacity=".22">
        <polyline points="6,16.5 19,21 32,12 45,21 58,16.5"/><line x1="32" y1="2.5" x2="32" y2="12"/>
        <line x1="19" y1="21" x2="45" y2="21"/><polyline points="6,46.5 20,52 32,61.5 44,52 58,46.5"/>
      </g>
      <polygon points="8.5,18.5 18,22 17,42 8.5,45" fill="#fff" opacity=".05"/>
      <path class="gl" filter="url(#${u}b)"/><path class="gr" filter="url(#${u}b)"/>
      <path class="el" stroke-width="1.5" stroke-linejoin="round"/><path class="er" stroke-width="1.5" stroke-linejoin="round"/>
      <path class="mouth" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </g></svg>`;
}

/* Every logo gets a face; they are one creature, drawn from one state. */
function mascotBuild() {
  mascot.insts = [...document.querySelectorAll('.logo-mascot')].map((wrap, i) => {
    wrap.innerHTML = mascotSvg('mascot' + i);
    const q = (s) => wrap.querySelector(s);
    const inst = { wrap, svg: q('svg'), lamp: q('.mascot-lamp'), head: q('.head'),
      s1: q('.s1'), s2: q('.s2'), s3: q('.s3'), facet: q('.facet'),
      el: q('.el'), er: q('.er'), gl: q('.gl'), gr: q('.gr'), mouth: q('.mouth') };
    wrap.addEventListener('pointerenter', () => { mascot.hover = true; mascotWake(); });
    wrap.addEventListener('pointerleave', () => { mascot.hover = false; mascotWake(); });
    wrap.addEventListener('click', mascotBoop);
    return inst;
  });
}

function mascotDraw(inst) {
  const F = mascot.face;
  const [cr, cg, cb] = F.tint.map((v) => Math.round(v));
  const light = `rgb(${cr},${cg},${cb})`;
  inst.s1.setAttribute('stop-color', light);
  inst.s2.setAttribute('stop-color', `rgb(${Math.round(cr * 0.76)},${Math.round(cg * 0.89)},${Math.round(cb * 0.84)})`);
  inst.s3.setAttribute('stop-color', `rgb(${Math.round(cr * 0.44)},${Math.round(cg * 0.62)},${Math.round(cb * 0.58)})`);
  inst.facet.style.stroke = light;
  const lx = F.lx * MASCOT_LOOK[0], ly = F.ly * MASCOT_LOOK[1];
  inst.head.setAttribute('transform',
    `translate(${(F.shX * 0.08).toFixed(2)} ${F.bobY.toFixed(2)}) rotate(${(F.tilt + F.shX).toFixed(2)} 32 60) ` +
    `translate(32 60) scale(${(1 + F.sqY * 0.05).toFixed(3)} ${(1 - F.sqY * 0.07).toFixed(3)}) translate(-32 -60)`);
  const ink = `rgb(${cr + Math.round((255 - cr) * 0.3)},${cg + Math.round((255 - cg) * 0.3)},${cb + Math.round((255 - cb) * 0.3)})`;
  const g = Math.max(0, Math.min(1, F.glow + F.beat));
  ['l', 'r'].forEach((side, i) => {
    const cx = MASCOT_EYES[i][0] + lx, cy = MASCOT_EYES[i][1] + ly;
    const h = MASCOT_EYE_H * Math.max(0.05, F.open * mascotBlinkFactor(F, side));
    const d = mascotEyePath(cx, cy, MASCOT_EYE_W, h, Math.max(0, Math.min(1, F.happy)));
    // Droop tips the outer corners down (sad); a negative droop is a focused frown.
    const tf = `rotate(${((i ? 1 : -1) * F.droop * 15).toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)})`;
    const eye = inst['e' + side], glow = inst['g' + side];
    eye.setAttribute('d', d); eye.setAttribute('transform', tf);
    eye.style.fill = ink; eye.style.stroke = ink;
    glow.setAttribute('d', d); glow.setAttribute('transform', tf);
    glow.style.fill = light; glow.style.opacity = (0.2 + 0.8 * g).toFixed(3);
  });
  inst.mouth.setAttribute('d', mascotMouthPath(MASCOT_MOUTH[0] + lx * 0.55, MASCOT_MOUTH[1] + ly * 0.5, MASCOT_MOUTH_W * F.mw, F.smile, F.talk));
  inst.mouth.style.fill = ink; inst.mouth.style.stroke = ink;
  inst.wrap.style.setProperty('--mascot-tint', `${cr},${cg},${cb}`);
  inst.lamp.style.opacity = (g * 0.95).toFixed(3);
  inst.svg.style.filter = `drop-shadow(0 0 ${(2 + g * 6).toFixed(1)}px rgba(${cr},${cg},${cb},${(0.15 + g * 0.3).toFixed(3)}))`;
}

/* ------------------------------ the loop ------------------------------- */

/* Movement is an Extra effect, and reduced motion keeps only the state. */
function mascotStill() {
  return !document.body.classList.contains('fx-on') || !motionOK();
}
function mascotWaiting() {
  if (typeof threadAwaitsPermission !== 'function') return false;
  for (const id of state.live.keys()) if (threadAwaitsPermission(id)) return true;
  return false;
}
/* The pointer relative to the face on screen, -1..1 each way (or null). */
function mascotPointer() {
  const at = mascot.ptrAt;
  if (!at) return null;
  const inst = mascot.insts.find((i) => i.wrap.offsetParent);
  if (!inst) return null;
  const r = inst.wrap.getBoundingClientRect();
  const c = (v) => Math.max(-1, Math.min(1, v));
  return { x: c((at.x - (r.left + r.width / 2)) / 260), y: c((at.y - (r.top + r.height / 2)) / 200) };
}

function mascotWake() {
  if (mascot.raf || !mascot.insts.length) return;
  mascot.last = 0;
  mascot.raf = requestAnimationFrame(mascotFrame);
}

function mascotFrame(now) {
  mascot.raf = 0;
  const dt = mascot.last ? Math.min(0.05, (now - mascot.last) / 1000) : 1 / 60;
  mascot.last = now;
  const still = mascotStill(), waiting = mascotWaiting();
  const env = { now, t: now / 1000, still, waiting, ptr: still ? null : mascotPointer() };
  const glancing = !!(mascot.glance && now < mascot.glance.until);
  const reacting = !!(mascot.react && now - mascot.react.at < (MASCOT_REACTION_MS[mascot.react.kind] || 0));
  const talking = mascot.mood === 'writing' && mascotVoiceBusy(mascot.voice);
  if (mascot.mood === 'writing' && !still) mascot.talk = mascotVoiceStep(mascot.voice, dt, Math.random);
  env.busy = glancing || (!still && !waiting && (reacting || talking || mascot.mood === 'thinking' || mascot.mood === 'working'));
  const more = mascotStep(mascot.face, mascotTarget(mascot, env), dt, env);
  mascot.insts.forEach(mascotDraw);
  if (more) mascot.raf = requestAnimationFrame(mascotFrame);
}

function mascotSetMood(mood, holdMs) {
  mascot.mood = mood;
  clearTimeout(mascot.moodT);
  if (holdMs) {
    mascot.moodT = setTimeout(() => {
      if (mascot.mood !== mood) return;
      mascotSetMood('rest');
      if (mood === 'done') mascotBlink();   // the reply has landed: settle with a blink
    }, holdMs);
  }
  mascotWake();
}

function mascotImpulse(kind) {
  if (mascotStill()) return;
  const F = mascot.face;
  if (kind === 'hop') F.bobV -= 70;
  else if (kind === 'nod') F.bobV += 45;
  else if (kind === 'squash') F.sqV += 14;
  else if (kind === 'shake') F.shV += 150;
  mascotWake();
}
function mascotBeat(n) {
  mascot.face.beat = Math.min(0.6, mascot.face.beat + n);
  mascotWake();
}
function mascotLook(x, y, ms, happy) {
  if (mascotStill()) return;
  mascot.glance = { x, y, happy, until: performance.now() + ms };
  mascotWake();
}

/* -------------------------- input and idleness -------------------------- */

/* You did something. Wakes a dozing face; any real input acknowledges a failure. */
function mascotActivity(input) {
  mascot.lastAct = performance.now();
  if (mascot.mood === 'sleep') {
    mascotSetMood('rest');
    mascotImpulse('hop');
    mascotBlink();
  } else if (input && mascot.mood === 'error') {
    mascotSetMood('rest');
  }
}
/* Now and then, at random, a fidget (see mascotFidget); then the next is scheduled. */
function mascotFidgetTick() {
  const [lo, hi] = MASCOT_FIDGET_MS;
  mascot.fidgetT = setTimeout(mascotFidgetTick, lo + Math.random() * (hi - lo));
  if (document.hidden || mascotStill()) return;
  const f = mascotFidget(mascotWaiting() ? 'waiting' : mascot.mood, Math.random);
  if (!f) return;
  if (f.kind === 'blink') mascotBlink();
  else if (f.kind === 'double') { mascotBlink(); setTimeout(() => mascotBlink(), 280); }
  else if (f.kind === 'smile') { mascot.idle.smile = f.smile; mascotWake(); }
  else if (f.kind === 'tilt') { mascot.idle.tilt = f.tilt; mascotWake(); }
  else if (f.kind === 'look' && !mascot.hover) mascotLook(f.x, f.y, f.ms);
}

/* Nothing for MASCOT_IDLE_MS and no turn running anywhere: eyes close, and from
 * then on nothing moves until you're back. */
function mascotIdleCheck() {
  const quiet = performance.now() - mascot.lastAct;
  if (quiet >= MASCOT_IDLE_MS && !state.live.size && mascot.mood === 'rest') mascotSetMood('sleep');
  // Not quiet long enough yet: look again when it would be. Quiet but busy (a turn
  // is running): look again a whole stretch later rather than polling.
  mascot.idleT = setTimeout(mascotIdleCheck, quiet < MASCOT_IDLE_MS ? MASCOT_IDLE_MS - quiet : MASCOT_IDLE_MS);
}

document.addEventListener('pointermove', (e) => {
  mascot.ptrAt = { x: e.clientX, y: e.clientY };
  mascotActivity(false);
  if (mascot.mood === 'rest' || mascot.mood === 'done') mascotWake();
}, { passive: true });
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;   // left the window, not just an element
  mascot.ptrAt = null;
  mascotWake();
});
document.addEventListener('pointerdown', () => mascotActivity(true), true);
document.addEventListener('keydown', () => mascotActivity(true), true);
window.addEventListener('focus', () => mascotBlink());   // back to the window: a new scene

/* ------------------------------ the hooks ------------------------------- *
 * Called from stream.js, typer.js, composer.js, chat.js, permissions.js,
 * notifications.js and logo.js. Each is cheap and safe to call at any time. */

/* A blink: a scene changed (chat switch, back to the window, a reply landed). */
function mascotBlink(eye, dur) {
  if (mascotStill()) return;
  mascot.face.blink = { t: 0, dur: dur || 0.2, eye: eye || 'both' };
  mascotWake();
}

/* The app (or a project) has just opened: it wakes up — eyes open, a hop, a blink. */
function mascotGreet() {
  mascot.lastAct = performance.now();
  if (mascot.mood === 'sleep') mascot.mood = 'rest';
  if (mascotStill()) { mascotWake(); return; }
  mascot.face.open = 0;
  mascotImpulse('hop');
  mascotBeat(0.25);
}

/* Clicked: a squish and a wink. */
function mascotBoop() {
  mascotImpulse('squash');
  mascotBlink('l', 0.28);
  mascotBeat(0.25);
}

/* A key went into the composer: it watches, eyes on the caret. Not mid-turn —
 * then it's watching the turn. */
function mascotKey() {
  if (!['rest', 'typing', 'done', 'error', 'sleep'].includes(mascot.mood)) return;
  const el = els.input;
  const line = el.value.slice(0, el.selectionStart || 0).split('\n').pop();
  mascot.caret = Math.max(0.2, Math.min(1, 0.2 + (line.length * 7.4) / Math.max(200, el.clientWidth || 0)));
  mascotSetMood('typing');
  clearTimeout(mascot.typingT);
  mascot.typingT = setTimeout(() => { if (mascot.mood === 'typing') mascotSetMood('rest'); }, MASCOT_TYPING_MS);
}

/* A turn started on screen: a hop, and the eyes follow the message up. */
function mascotTurnBegan() {
  clearTimeout(mascot.typingT);
  mascotSetMood('thinking');
  mascotImpulse('hop');
  mascotLook(0.9, -0.9, 420);
}

/* What the turn on screen is doing now (the typer's thinking/working/streaming). */
function mascotMode(mode) {
  const mood = mode === 'streaming' ? 'writing' : mode;
  if (mascot.mood === mood) return;
  if (mood !== 'writing') mascotHush();
  mascotSetMood(mood);
}

/* Text was revealed: it gives the face more to say. */
function mascotWords(chunk) {
  if (!chunk || mascot.mood !== 'writing') return;
  mascotVoiceFeed(mascot.voice, chunk);
  mascotWake();
}

/* Nothing more to say: the mouth shuts and whatever it still owed is dropped. */
function mascotHush() {
  mascot.talk = 0;
  mascot.voice = mascotVoice();
}

/* A tool on screen handed back its result: one nod. */
function mascotNod() {
  const now = performance.now();
  if (now - mascot.nodAt < MASCOT_NOD_GAP_MS) return;
  mascot.nodAt = now;
  mascotImpulse('nod');
  mascotBeat(0.35);
}

/* A step started on screen (a tool event): a small reaction of its kind and a
 * touch of light. A step's event comes twice (start, then with its detail), and
 * parallel steps start together, so each id counts once and close starts share
 * one reaction. */
function mascotTool(msg) {
  if (!msg || mascotStill()) return;
  if (msg.id) {
    if (mascot.steps.includes(msg.id)) return;
    mascot.steps.push(msg.id);
    if (mascot.steps.length > 32) mascot.steps.shift();
  }
  const now = performance.now();
  if (now - mascot.stepAt < MASCOT_STEP_GAP_MS) return;
  mascot.stepAt = now;
  mascot.react = { kind: mascotToolKind(msg.name || ''), at: now };
  mascotBeat(0.12);
}

/* The turn on screen ended: happy if it landed, red if it failed, plain rest if
 * you stopped it. */
function mascotTurnEnded(live) {
  mascotHush();
  mascot.lastAct = performance.now();
  if (live && live.stopped) { mascotSetMood('rest'); return; }
  if (live && live.failed) {
    mascotSetMood('error', MASCOT_ERROR_MS);
    mascotImpulse('shake');
    mascotBeat(0.3);
    return;
  }
  mascotSetMood('done', MASCOT_DONE_MS);
  mascotBeat(0.3);
  if (!mascotStill() && typeof logoWave === 'function') logoWave(document.querySelector('aside.sidebar .logo'));
}

/* The view left the turn (switched chats): nothing on screen is running. */
function mascotRest() {
  mascotHush();
  if (['thinking', 'working', 'writing'].includes(mascot.mood)) mascotSetMood('rest');
}

/* Something happened in a chat you can't see: a glance at the bell. */
function mascotGlance(kind) {
  mascotLook(1, -1, 1100, kind === 'failed' ? 0 : 0.6);
  mascotBeat(0.25);
}

mascotBuild();
mascot.lastAct = performance.now();
mascot.idleT = setTimeout(mascotIdleCheck, MASCOT_IDLE_MS);
mascot.fidgetT = setTimeout(mascotFidgetTick, MASCOT_FIDGET_MS[0]);
mascotWake();
