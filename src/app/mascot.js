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

   Its personality lives in *acts*: short scripted bits laid over whatever the
   mood is (MASCOT_ACTS, posed by the pure mascotActPose), each with cues on its
   timeline (a hop, a blink, a little ♪ or ✦ floating off it — mascotPuff).
     • left alone   — after a while it gets bored: it hums, sighs, peeks around,
                      stretches, and very rarely sneezes (mascotQuirk). Later its
                      lids get heavy (drowsy), it nods off and jerks awake, yawns,
                      and finally falls asleep, breathing slowly under a few z's.
                      Late at night all of that comes sooner;
     • you type     — a "?" gets a curious head tilt, wiping out a lot of text a
                      wince, typing fast raised brows, and a "thanks" a blush;
     • a long think — it ponders (one brow up, mouth pulled aside, a "?"), and
                      when the answer finally starts it lights up (eureka);
     • a long turn  — a lot of steps furrow its brow, and many more bring out a
                      sweat drop; landing one gets a little celebration;
     • you poke it  — one click a wink; a few a giggle; more and it gets dizzy;
                      keep going and it huffs and looks away for a moment;
     • you pet it   — rubbing the pointer back and forth over it: eyes shut,
                      blushing, a heart;
     • greetings    — it stretches in the morning, yawns late at night, and
                      bounces when you come back after a long while.

   At rest the pointer is the only thing it follows. Hover makes it happy, a click
   gets a squish and a wink. The rAF loop runs only while something is settling
   and stops at rest; it draws only the face that is actually on screen
   (IntersectionObserver), writes only attributes that changed, and runs at half
   rate while the only movement is a slow drift. With Extra effects off (body.fx-on)
   or under reduced motion it still shows the state — expression and colour — but
   without the movement: no hops, nods, drift, blinks, acts or pointer following. */

// The crystal's geometry, in its 64×64 viewBox.
const MASCOT_EYES = [[23, 34], [41, 34]];
const MASCOT_EYE_W = 7, MASCOT_EYE_H = 8.2;
const MASCOT_MOUTH = [32, 45.5], MASCOT_MOUTH_W = 7;
const MASCOT_LOOK = [4, 3];        // how far the eyes travel at full look
const MASCOT_GREEN = [143, 224, 170], MASCOT_AMBER = [240, 178, 104], MASCOT_RED = [236, 122, 122];
// [catch, release]: fast toward a new expression, slow letting go of it.
const MASCOT_TAU = { lx: [0.11, 0.16], ly: [0.11, 0.16], open: [0.07, 0.12], happy: [0.12, 0.45],
  smile: [0.18, 0.4], droop: [0.2, 0.5], mw: [0.1, 0.2], glow: [0.14, 0.9], tilt: [0.18, 0.45], talk: [0.035, 0.04],
  brow: [0.09, 0.22], browA: [0.11, 0.28], browQ: [0.12, 0.3], blush: [0.16, 0.7], scrunch: [0.05, 0.11],
  mx: [0.12, 0.25], skew: [0.1, 0.22] };
// The brows sit above the eyes; the cheeks, where a blush shows, below them.
const MASCOT_BROW_Y = 25.6, MASCOT_BROW_W = 6.2;
const MASCOT_CHEEKS = [[15.5, 43.5], [48.5, 43.5]];
const MASCOT_BORED_MS = 45 * 1000;      // no input this long at rest: it starts amusing itself
const MASCOT_DROWSY_MS = 2 * 60 * 1000; // …this long: its lids get heavy
const MASCOT_QUIRK_GAP_MS = 18000;      // at least this long between two bits of boredom
const MASCOT_BOOP_MS = 1600;            // clicks closer together than this add up
const MASCOT_AWAY_MS = 10 * 60 * 1000;  // back to the window after this long: it says hi
const MASCOT_IDLE_MS = 3 * 60 * 1000;   // no input and no turn for this long: it dozes
const MASCOT_DONE_MS = 1500;            // happy after a reply lands, then rest
const MASCOT_ERROR_MS = 6000;           // red after a failure, unless you look sooner
const MASCOT_TYPING_MS = 1500;          // still watching this long after the last key
const MASCOT_NOD_GAP_MS = 350;          // parallel tool results shouldn't stack nods
const MASCOT_FIDGET_MS = [1800, 5200];  // a fidget comes somewhere in this window after the last
const MASCOT_BLINK_MS = [2200, 6000];   // a natural blink, on its own clock
const MASCOT_SACCADE_MS = [600, 2400];  // at rest the eyes dart a little, the way eyes never quite hold still
const MASCOT_SYLLABLE_MS = [150, 230];  // one syllable, open then shut: about five a second
const MASCOT_PAUSE_MS = 260;            // the mouth rests this long where a sentence ends
const MASCOT_VOICE_MAX = 4;             // syllables it may owe the text, so it stops soon after the text does
const MASCOT_STEP_GAP_MS = 300;         // parallel steps starting together get one reaction
// How long each kind of step's reaction lasts (see mascotApplyReaction).
const MASCOT_REACTION_MS = { look: 600, change: 650, run: 450, agent: 800, other: 350 };
const MASCOT_LOOK_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'NotebookRead']);
const MASCOT_CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'mcp__krystal__artifact']);

/* Each act: how long it lasts, whether it is just the face amusing itself (any
 * real input ends those), and what happens along the way ([progress, cue] —
 * see mascotCue). The face it pulls is in mascotActPose. */
const MASCOT_ACTS = {
  yawn:    { ms: 2000, idle: true, cues: [[0.92, 'blink']] },
  sneeze:  { ms: 1500, idle: true, cues: [[0.56, 'achoo']] },
  sigh:    { ms: 1700, idle: true, cues: [[0.12, 'rise'], [0.5, 'nod']] },
  hum:     { ms: 2800, idle: true, cues: [[0.08, 'puff:note'], [0.55, 'puff:note']] },
  peek:    { ms: 2000, idle: true },
  stretch: { ms: 1500, idle: true, cues: [[0.08, 'stretch'], [0.85, 'blink']] },
  nodoff:  { ms: 2600, idle: true, cues: [[0.78, 'hop']] },
  giggle:  { ms: 1000, cues: [[0.02, 'wobble'], [0.4, 'wobble']] },
  dizzy:   { ms: 2300, cues: [[0.97, 'blink']] },
  huff:    { ms: 3600, cues: [[0.03, 'shake']] },
  startle: { ms: 750, cues: [[0, 'hop'], [0, 'puff:bang']] },
  perk:    { ms: 600, cues: [[0, 'hop']] },
  wince:   { ms: 900, cues: [[0, 'squash']] },
  curious: { ms: 1500, cues: [[0.1, 'puff:q']] },
  ponder:  { ms: 2000, cues: [[0.25, 'puff:q']] },
  eureka:  { ms: 800, cues: [[0, 'hop'], [0.05, 'puff:bang']] },
  shy:     { ms: 1800, cues: [[0.1, 'puff:heart']] },
  purr:    { ms: 1100 },
  wiggle:  { ms: 1500, cues: [[0, 'hop'], [0.05, 'puff:spark'], [0.42, 'hop'], [0.45, 'puff:spark']] },
  hi:      { ms: 1100, cues: [[0, 'hop'], [0.1, 'puff:spark']] },
  flick:   { ms: 550 },                     // the small ones: idle fidgets at rest
  squint:  { ms: 900 },
  bop:     { ms: 700, cues: [[0, 'bop']] },
  excite:  { ms: 750, cues: [[0, 'bop']] },  // reactions to what you type (mascotTypeReaction)
  skeptic: { ms: 1400 },
  grin:    { ms: 1100 },
  pout:    { ms: 1200 },
  shout:   { ms: 850, cues: [[0, 'wobble']] },
  oops:    { ms: 450 },
  whoa:    { ms: 1000, cues: [[0.05, 'puff:bang']] },
  expect:  { ms: 1700 },
};
const MASCOT_BORED_ACTS = ['hum', 'sigh', 'peek', 'stretch', 'hum', 'peek'];
/* The beats of a think, worked through while it lasts (mascotThinkBeat). The face
 * eases from one to the next on its own springs, so a switch reads as a shift of
 * thought, not a cut. Every beat looks up. */
const MASCOT_THINK_BEATS = [
  // hmm…: eyes up and aside, the left brow up, the mouth pulled to one side
  { lx: -0.6, ly: -0.8, open: 0.85, brow: 0.3, browQ: 0.95, browA: 0.15, mx: -0.8, skew: 0.35, mw: 0.65, tilt: -3 },
  // …or: the other way — the other brow, the other side
  { lx: 0.55, ly: -0.75, open: 0.85, brow: 0.3, browQ: -0.95, browA: 0.15, mx: 0.8, skew: -0.35, mw: 0.65, tilt: 3 },
  // focus: brows knit, eyes narrow, lips pressed
  { lx: -0.2, ly: -0.55, open: 0.66, brow: -0.1, browQ: 0, browA: 0.8, mx: 0, skew: 0, mw: 0.5, smile: -0.1, tilt: 0 },
  // wondering: both brows up, eyes high, a small "o"
  { lx: 0.1, ly: -0.95, open: 0.98, brow: 0.8, browQ: 0.2, browA: -0.2, mx: 0.2, skew: 0, mw: 0.5, talk: 0.22, tilt: -1.5 },
];
const MASCOT_THINK_BEAT_S = 2.6;
const MASCOT_KIND = /\b(thanks|thank you|thx|ty|cheers|love (it|you)|awesome|amazing|perfect|nice|great job|good job|well done|bravo|hvala|super|odlično|svaka čast|volim te)[\s!.,:)]+$/i;   // the word has ended — not "ty" on its way to "type"
// How far apart each typing reaction may come (a nod is spaced in mascotKey).
const MASCOT_TYPE_GAP_MS = { curious: 6000, wince: 4000, excite: 2500, skeptic: 4000, grin: 3000, pout: 3000,
  shout: 5000, oops: 1500, whoa: 0, shy: 0 };
const MASCOT_TYPE_MILESTONES = [300, 1000];   // a message this long gets a "whoa"
const MASCOT_PUFFS = { note: '♪', spark: '✦', q: '?', bang: '!', heart: '♥', drop: '' };

function mascotFace() {
  return { lx: 0, ly: 0, open: 1, happy: 0, smile: 0.25, droop: 0, mw: 1, glow: 0.22, tilt: 0, talk: 0,
    brow: 0, browA: 0, browQ: 0, blush: 0, scrunch: 0, mx: 0, skew: 0,
    tint: MASCOT_GREEN.slice(), beat: 0, bobY: 0, bobV: 0, sqY: 0, sqV: 0, shX: 0, shV: 0, blink: null };
}

const mascot = {
  mood: 'rest',     // rest | typing | thinking | working | writing | done | error | drowsy | sleep (waiting is read live)
  face: mascotFace(),
  hover: false,
  ptrAt: null,      // the pointer in client coordinates, while it's in the window
  caret: 0.6,       // how far along the line the caret is, 0..1
  glance: null,     // { x, y, happy, until } — a look somewhere for a moment
  talk: 0,          // the mouth's target, set each frame by the voice while it writes
  voice: mascotVoice(),   // the syllables the revealed text has given it to say
  idle: { smile: 0, tilt: 0, mx: 0, skew: 0, brow: 0 },   // the pose the resting face has settled into (fidgets move it)
  sacc: { x: 0, y: 0 },   // the small dart the eyes are making at rest
  shown: null,      // the mood the faces were last marked with (data-mood, for the CSS idle loop)
  react: null,      // { kind, at } — the reaction to the step that just started
  steps: [],        // ids of the steps already reacted to (a step's event comes twice)
  act: null,        // { name, at, cue } — the bit of personality playing now (MASCOT_ACTS)
  turnAt: 0, turnSteps: 0,   // when the turn on screen began, and how many steps it has taken
  fast: false,      // typing quickly (brows up)
  keys: [],         // when the last few keys went in, to tell fast typing
  inLen: 0,         // the composer's length at the last key
  kind: false,      // this message already got its blush
  pet: { x: null, dir: 0, flips: [] },   // the pointer rubbing back and forth over the face
  hoverAt: 0, boops: 0, boopAt: 0, petAt: 0, heartAt: 0,
  moodAt: 0, quirkAt: -1e9, startleAt: -1e9, blurAt: 0,
  typeAt: {},       // when each typing reaction last played, to space them out
  ptrPrev: null,    // the last pointer sample, for its speed
  rect: null, rectAt: -1e9,   // the face on screen, measured at most once a second
  moodT: 0, typingT: 0, idleT: 0, fidgetT: 0, nodAt: 0, stepAt: -1e9,
  lastAct: 0,
  raf: 0, last: 0, drawnAt: 0, lazy: false,
  insts: [],
};

/* What the face should look like: one expression per mood, then the glance, the
 * hover and the pointer on top. Pure — `m` is the mascot's state, `env` the world
 * ({ now (ms), t (s), waiting, still, ptr: {x, y} relative to the face }). */
function mascotTarget(m, env) {
  const mood = env.waiting ? 'waiting' : m.mood;
  const t = { lx: 0, ly: 0, open: 1, happy: 0, smile: 0.25, droop: 0, mw: 1, glow: 0.22, tilt: 0, talk: 0,
    brow: 0, browA: 0, browQ: 0, blush: 0, scrunch: 0, mx: 0, skew: 0, tint: MASCOT_GREEN };
  if (mood === 'typing') {
    t.lx = m.caret; t.ly = 0.75; t.open = 1.08; t.smile = 0.35; t.glow = 0.36; t.brow = 0.25;
    if (m.fast) { t.open = 1.16; t.brow = 0.6; }   // keeping up with you
    if (!env.still) t.talk = (m.talk || 0) * 0.4;   // mouthing along with what you type, under its breath
  }
  else if (mood === 'thinking') {
    // A real "hmm": it works through beats (MASCOT_THINK_BEATS) — one brow up and
    // the mouth pulled aside, then the other way, brows knitting in focus, eyes
    // up wondering — with the brows giving a little lift now and then.
    t.smile = 0; t.glow = 0.42;
    Object.assign(t, MASCOT_THINK_BEATS[env.still ? 0 : mascotThinkBeat(env.t)]);
    if (!env.still) {
      t.brow += 0.18 * Math.pow(Math.max(0, Math.sin(env.t * 2.3)), 6);   // a quick brow lift, now and then
      t.lx += 0.13 * (Math.sin(env.t * 1.31) + Math.sin(env.t * 2.07 + 1.3)) / 2;
      t.ly += 0.1 * (Math.sin(env.t * 1.73 + 0.4) + Math.sin(env.t * 0.93 + 2)) / 2;
    }
  }
  else if (mood === 'working') {
    t.lx = 0.95; t.ly = 0.15; t.open = 0.84; t.droop = -0.35; t.smile = 0.05; t.glow = 0.48;
    t.brow = -0.15; t.browA = m.turnSteps >= 15 ? 0.75 : 0.4;   // a long run of steps: real determination
    if (!env.still) {   // its eyes move over the work: slower and smaller than thinking's drift
      t.lx += 0.12 * (Math.sin(env.t * 1.07 + 0.6) + Math.sin(env.t * 1.89 + 2.1)) / 2;
      t.ly += 0.1 * (Math.sin(env.t * 1.51) + Math.sin(env.t * 0.71 + 1.1)) / 2;
    }
  }
  else if (mood === 'writing') { t.lx = 0.9; t.ly = 0.3; t.smile = 0.3; t.glow = 0.5; t.brow = 0.2; t.talk = env.still ? 0.25 : m.talk; }
  else if (mood === 'waiting') { t.open = 1.12; t.smile = 0; t.mw = 0.5; t.talk = 0.45; t.glow = 0.6; t.brow = 0.7; t.tint = MASCOT_AMBER; }
  else if (mood === 'done') { t.happy = 1; t.smile = 0.85; t.glow = 0.66; t.tilt = -5; t.brow = 0.45; }
  else if (mood === 'error') { t.droop = 1; t.open = 0.72; t.smile = -0.75; t.glow = 0.45; t.ly = 0.35; t.brow = 0.1; t.browA = -0.8; t.tint = MASCOT_RED; }
  else if (mood === 'drowsy') { t.open = 0.42; t.ly = 0.3; t.smile = 0.1; t.glow = 0.12; t.brow = -0.3; t.tilt = 2; }
  else if (mood === 'sleep') { t.open = 0.04; t.ly = 0.45; t.smile = 0.12; t.glow = 0.06; t.tilt = 4; t.brow = -0.35; }
  else if (mood === 'rest' && m.idle) {   // the pose it has settled into: never quite the same twice
    t.smile += m.idle.smile; t.tilt += m.idle.tilt;
    t.mx = m.idle.mx || 0; t.skew = m.idle.skew || 0; t.brow = m.idle.brow || 0;
  }
  if ((mood === 'working' || mood === 'thinking') && m.react) mascotApplyReaction(t, m.react, env.now);

  const calm = mood === 'rest' || mood === 'done';
  if (m.glance && env.now < m.glance.until && mood !== 'waiting') {
    t.lx = m.glance.x; t.ly = m.glance.y;
    t.happy = Math.max(t.happy, m.glance.happy || 0);
    t.smile = Math.max(t.smile, 0.5);
  } else if (m.hover && (calm || mood === 'typing')) {
    t.happy = Math.max(t.happy, 0.85); t.smile = 0.7; t.tilt = 6; t.glow += 0.2; t.brow = 0.35;
    if (m.hoverAt && env.now - m.hoverAt > 1500) t.blush = 0.4;   // lingering attention makes it shy
  } else if (!env.still && env.ptr && calm) {
    // Following the pointer it turns its head a little too, and lifts its brows to look up.
    t.lx = env.ptr.x; t.ly = env.ptr.y;
    t.tilt += env.ptr.x * 3.5;
    t.brow += Math.max(0, -env.ptr.y) * 0.3;
  }
  // Eyes never hold perfectly still: at rest they make small darts (saccades).
  if (!env.still && m.sacc && (calm || mood === 'drowsy') && !m.hover) { t.lx += m.sacc.x; t.ly += m.sacc.y; }
  // An act plays over all of it — but never over a face that waits on you or sleeps.
  if (m.act && !env.still && mood !== 'waiting' && mood !== 'sleep') mascotApplyAct(t, m.act, env.now);
  return t;
}

/* Which thinking beat it is at time t (seconds), pure: a new one every
 * MASCOT_THINK_BEAT_S. Each run of n segments plays every beat once in an order
 * shuffled by a hash of the run, so there's no rhythm to learn; where two runs
 * meet, the new run's first two swap if its first would repeat the last. */
function mascotThinkBeat(t) {
  const n = MASCOT_THINK_BEATS.length;
  const order = (run) => {
    const o = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const x = Math.sin((run * n + i + 1) * 12.9898) * 43758.5453;
      const j = Math.floor((x - Math.floor(x)) * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };
  const seg = Math.floor(t / MASCOT_THINK_BEAT_S), run = Math.floor(seg / n), at = seg - run * n;
  const o = order(run);
  if (o[0] === order(run - 1)[n - 1]) [o[0], o[1]] = [o[1], o[0]];   // the last never moves, so this holds
  return o[at];
}

/* 0 before a, rising to 1 by b, holding to c, gone by d — smoothly. */
function mascotBump(p, a, b, c, d) {
  const s = (x) => x * x * (3 - 2 * x);
  if (p <= a || p >= d) return 0;
  if (p < b) return s((p - a) / (b - a));
  if (p <= c) return 1;
  return s(1 - (p - c) / (d - c));
}

/* The face an act pulls at progress p (0..1): the pose, and how much of it shows
 * (w). Pure. Poses name only the features they move. */
function mascotActPose(name, p) {
  const B = mascotBump, wave = (n) => Math.sin(p * Math.PI * 2 * n);
  switch (name) {
    case 'yawn':    return { w: B(p, 0, 0.25, 0.7, 1), v: { open: 0.18, brow: 0.75, ly: -0.5, mw: 0.85, talk: 1, smile: 0, tilt: -4, glow: 0.3 } };
    case 'sneeze': {   // ah… ah… (eyes going, head back) — choo! (scrunched, forward) — sheepish
      const w = B(p, 0, 0.05, 0.85, 1);
      if (p < 0.55) { const a = p / 0.55; return { w, v: { open: 1 - 0.55 * a, brow: 0.9 * a, ly: -0.6 * a, talk: 0.55 * a, mw: 0.7, tilt: -5 * a, smile: 0 } }; }
      if (p < 0.72) return { w, v: { scrunch: 1, talk: 0, smile: -0.1, ly: 0.5, brow: -0.3, tilt: 2 } };
      return { w, v: { blush: 0.5, smile: 0.5, happy: 0.4, brow: 0.3 } };
    }
    case 'sigh':    return { w: B(p, 0, 0.15, 0.7, 1), v: { open: 0.55, ly: 0.4, brow: -0.1, browA: -0.5, smile: -0.1, mw: 0.75, talk: p < 0.5 ? 0.3 : 0 } };
    case 'hum':     return { w: B(p, 0, 0.12, 0.85, 1), v: { happy: 0.7, smile: 0.45, mw: 0.55, talk: 0.22 + 0.12 * Math.sin(p * 30), tilt: 4 * wave(2), brow: 0.3 } };
    case 'peek':    return { w: B(p, 0, 0.08, 0.9, 1), v: { lx: p < 0.45 ? -0.95 : 0.95, ly: -0.1, brow: 0.35, smile: 0.1 } };
    case 'stretch': return { w: B(p, 0, 0.15, 0.75, 1), v: { happy: 0.9, brow: 0.6, talk: 0.35, mw: 0.6, ly: -0.4, smile: 0.3 } };
    case 'nodoff':   // the lids sink and the head dips… then it jerks awake
      if (p < 0.78) { const a = p / 0.78; return { w: B(p, 0, 0.1, 0.9, 1), v: { open: 0.45 * (1 - a), ly: 0.7, tilt: 7 * a, brow: -0.4 } }; }
      return { w: B(p, 0, 0.1, 0.9, 1), v: { open: 1.25, brow: 1, ly: 0, tilt: 0, talk: 0.25, mw: 0.5 } };
    case 'giggle':  return { w: B(p, 0, 0.06, 0.75, 1), v: { scrunch: 1, happy: 1, smile: 1, blush: 0.6, tilt: 5 * wave(4), mw: 1.1 } };
    case 'dizzy': {
      const a = p * Math.PI * 8;
      return { w: B(p, 0, 0.08, 0.85, 1), v: { lx: 0.8 * Math.cos(a), ly: 0.6 * Math.sin(a), tilt: 7 * wave(3), open: 0.85, smile: -0.15, skew: 0.6 * Math.sin(p * 12), browA: -0.4, brow: 0.3 } };
    }
    case 'huff':    return { w: B(p, 0, 0.06, 0.8, 1), v: { browA: 0.9, brow: -0.2, open: 0.75, lx: -1, ly: 0.1, smile: -0.45, mw: 0.6, mx: -1, tilt: -7, happy: 0, blush: 0 } };
    case 'startle': return { w: B(p, 0, 0.04, 0.5, 1), v: { open: 1.3, brow: 1, mw: 0.5, talk: 0.55, smile: 0, happy: 0 } };
    case 'perk':    return { w: B(p, 0, 0.05, 0.4, 1), v: { open: 1.2, brow: 0.8, smile: 0.3 } };
    case 'wince':   return { w: B(p, 0, 0.05, 0.5, 1), v: { scrunch: 0.75, browA: -0.6, smile: -0.45, skew: 0.4, mw: 0.9 } };
    case 'curious': return { w: B(p, 0, 0.12, 0.75, 1), v: { tilt: 9, browQ: 1, lx: 0.3, ly: -0.25, mw: 0.55, talk: 0.18, smile: 0.1 } };
    case 'ponder':  return { w: B(p, 0, 0.15, 0.8, 1), v: { browQ: 1, lx: -0.85, ly: -0.85, mx: -1, skew: 0.5, smile: 0.05, mw: 0.7 } };
    case 'eureka':  return { w: B(p, 0, 0.04, 0.55, 1), v: { open: 1.25, brow: 1, happy: 0.25, smile: 0.7 } };
    case 'shy':     return { w: B(p, 0, 0.1, 0.75, 1), v: { blush: 1, happy: 0.55, smile: 0.55, lx: -0.65, ly: 0.45, tilt: -5, brow: 0.2 } };
    case 'purr':    return { w: B(p, 0, 0.1, 0.6, 1), v: { happy: 1, blush: 0.8, smile: 0.8, tilt: 5 * wave(1.4), brow: 0.3 } };
    case 'wiggle':  return { w: B(p, 0, 0.05, 0.8, 1), v: { happy: 1, smile: 1, blush: 0.35, brow: 0.6, tilt: 7 * wave(2.5) } };
    case 'hi':      return { w: B(p, 0, 0.05, 0.7, 1), v: { happy: 0.9, smile: 0.9, brow: 0.7, tilt: 5 } };
    // Typing reactions leave the eyes on the caret (no lx/ly) unless they look up at you.
    case 'excite':  return { w: B(p, 0, 0.08, 0.4, 1), v: { open: 1.18, brow: 0.9, happy: 0.3, smile: 0.8 } };
    case 'skeptic': return { w: B(p, 0, 0.12, 0.7, 1), v: { browQ: -1, browA: 0.35, open: 0.8, mx: 0.7, skew: -0.4, smile: 0 } };
    case 'grin':    return { w: B(p, 0, 0.1, 0.6, 1), v: { happy: 0.8, smile: 1, blush: 0.25, brow: 0.4 } };
    case 'pout':    return { w: B(p, 0, 0.1, 0.65, 1), v: { smile: -0.55, browA: -0.65, droop: 0.4, mw: 0.7 } };
    case 'shout':   return { w: B(p, 0, 0.04, 0.45, 1), v: { open: 1.3, brow: 1, mw: 0.55, talk: 0.5, smile: 0, happy: 0 } };
    case 'oops':    return { w: B(p, 0, 0.1, 0.4, 1), v: { browA: 0.55, open: 0.82, scrunch: 0.25 } };
    case 'whoa':    return { w: B(p, 0, 0.06, 0.55, 1), v: { open: 1.22, brow: 0.9, mw: 0.6, talk: 0.3, smile: 0.1 } };
    case 'expect':  return { w: B(p, 0, 0.12, 0.75, 1), v: { lx: 0, ly: -0.15, brow: 0.55, open: 1.08, smile: 0.45, tilt: 5 } };
    case 'flick':   return { w: B(p, 0, 0.12, 0.35, 1), v: { brow: 0.95, open: 1.12 } };
    case 'squint':  return { w: B(p, 0, 0.15, 0.6, 1), v: { happy: 0.55, smile: 0.6, open: 0.85 } };
    case 'bop':     return { w: B(p, 0, 0.1, 0.5, 1), v: { happy: 0.35, smile: 0.55, brow: 0.3 } };
  }
  return { w: 0, v: {} };
}

/* Lay the act playing now over the target `t`, pure; says whether it is still going. */
function mascotApplyAct(t, act, now) {
  const def = MASCOT_ACTS[act.name];
  if (!def) return false;
  const p = (now - act.at) / def.ms;
  if (p < 0 || p >= 1) return false;
  const { w, v } = mascotActPose(act.name, p);
  for (const k in v) t[k] += (v[k] - t[k]) * w;
  return true;
}

/* A bit of personality for the fidget timer to play, pure — or null. `ctx` says
 * how long you've been quiet, how long since the last quirk, whether it's late
 * at night, and how many steps the turn on screen has taken. Asleep or waiting
 * on you, never; bored, only once you've been gone a while, and spaced out. */
function mascotQuirk(mood, r, ctx) {
  if (mood === 'waiting' || mood === 'sleep') return null;
  const p = r();
  if (mood === 'drowsy') {
    if (ctx.since < 6000) return null;
    return p < 0.5 ? { act: 'nodoff' } : p < 0.75 ? { act: 'yawn' } : null;
  }
  if (mood === 'thinking') return ctx.since > 6000 && p < 0.3 ? { act: 'ponder' } : null;
  if (mood === 'working') return ctx.steps > 25 && ctx.since > 12000 && p < 0.2 ? { puff: 'drop' } : null;
  if (mood !== 'rest' || ctx.since < MASCOT_QUIRK_GAP_MS) return null;
  if (p < 0.03) return { act: 'sneeze' };   // rare, and bored or not
  const bored = ctx.quiet > MASCOT_BORED_MS * (ctx.night ? 0.6 : 1);
  if (!bored || p >= 0.35) return null;
  if (ctx.night && r() < 0.4) return { act: 'yawn' };
  return { act: MASCOT_BORED_ACTS[Math.floor(r() * MASCOT_BORED_ACTS.length) % MASCOT_BORED_ACTS.length] };
}

/* What a run of clicks has come to, pure: one wink, then a giggle, then dizzy,
 * then it has had enough. */
function mascotBoopKind(n) {
  return n >= 7 ? 'huff' : n >= 4 ? 'dizzy' : n >= 2 ? 'giggle' : 'wink';
}

/* The pointer moved to `x` over the face: is it being petted (rubbed back and
 * forth — three turns within a second)? Pure on `p`. */
function mascotPetFeed(p, x, now) {
  if (p.x != null && Math.abs(x - p.x) >= 2) {
    const dir = Math.sign(x - p.x);
    if (p.dir && dir !== p.dir) p.flips.push(now);
    p.dir = dir;
  }
  if (p.x == null || Math.abs(x - p.x) >= 2) p.x = x;
  while (p.flips.length && now - p.flips[0] > 1000) p.flips.shift();
  return p.flips.length >= 3;
}

/* Late at night it tires sooner. */
function mascotNight(h) {
  return h >= 23 || h < 5;
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
  if (react.kind === 'look') { t.lx = 0.35 + 0.65 * p; t.ly = 0.45 - 0.35 * p; t.open = 0.95; t.brow = 0.25; }   // scans a line
  else if (react.kind === 'change') { t.lx = 0.75; t.ly = 0.55; t.open = 0.7; t.droop = -0.55; t.browA = 0.8; t.mx = 0.6; } // looks down, concentrating
  else if (react.kind === 'run') { t.lx = 1; t.ly = 0; t.open = 1.1; t.brow = 0.8; }                           // eyes widen: off it goes
  else if (react.kind === 'agent') { t.lx = 0.85; t.ly = -0.65; t.happy = 0.45; t.smile = 0.4; t.brow = 0.55; } // a hopeful glance up
  else { t.lx = 0.6; t.ly = -0.3; t.brow = 0.2; }
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
 * look up to ponder. At rest — where blinks have their own clock — it shifts
 * into a new pose, the way an animated character's hold is never dead: a
 * different smile, a tilt of the head, the mouth pulled to one side, the brows
 * a touch up or down; or it does something small: a glance aside, a brow flick,
 * a little bop, a pleased squint. Waiting on you and dozing get nothing at all. */
function mascotFidget(mood, r) {
  if (mood === 'waiting' || mood === 'sleep') return null;
  const p = r();
  if (mood === 'rest') {
    const s = () => r() * 2 - 1;
    if (p < 0.08) return { kind: 'double' };
    if (p < 0.26) return { kind: 'smile', smile: -0.08 + r() * 0.35 };
    if (p < 0.44) return { kind: 'look', x: s() * 0.75, y: s() * 0.55, ms: 700 + r() * 1000 };
    if (p < 0.58) return { kind: 'tilt', tilt: s() * 6 };
    if (p < 0.7) return { kind: 'mouth', mx: s() * 0.7, skew: s() * 0.45 };
    if (p < 0.8) return { kind: 'brow', brow: -0.2 + r() * 0.5 };
    if (p < 0.88) return { kind: 'act', act: 'flick' };
    if (p < 0.95) return { kind: 'act', act: 'squint' };
    return { kind: 'act', act: 'bop' };
  }
  if (p < 0.45) return { kind: 'blink' };
  if (p < 0.55) return { kind: 'double' };
  if (mood === 'working' && p < 0.85) return { kind: 'look', x: -0.3 - r() * 0.3, y: -0.6 - r() * 0.2, ms: 800 + r() * 600 };
  return { kind: 'blink' };
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
/* `skew` lifts one corner and drops the other: a smirk, a wobble, a pout. */
function mascotMouthPath(mx, my, w, smile, talk, skew) {
  const l = mx - w / 2, r = mx + w / 2, ey = my - smile * 1.4, k = (skew || 0) * 1.6;
  const tc = my + smile * 3 - talk * 1.2, bc = my + smile * 3 + talk * 5.5;
  const f = (n) => n.toFixed(2);
  return `M${f(l)},${f(ey + k)}Q${f(mx)},${f(tc)} ${f(r)},${f(ey - k)}Q${f(mx)},${f(bc)} ${f(l)},${f(ey + k)}Z`;
}
/* A brow: a short arc over the eye. `raise` lifts it, `angle` tips its inner end
 * down (focus, annoyance) or up (worry); `dir` is which way is inward. */
function mascotBrowPath(cx, cy, dir, angle) {
  const h = MASCOT_BROW_W / 2, f = (n) => n.toFixed(2);
  const ix = cx + dir * h, iy = cy + angle * 1.9, ox = cx - dir * h, oy = cy - angle * 1.2;
  return `M${f(ox)},${f(oy)}Q${f(cx)},${f(cy - 1.3 + angle * 0.3)} ${f(ix)},${f(iy)}`;
}
/* A scrunched-shut eye: > on the left, < on the right. */
function mascotScrunchPath(cx, cy, dir) {
  const f = (n) => n.toFixed(2);
  return `M${f(cx - dir * 2.8)},${f(cy - 2.8)}L${f(cx + dir * 2.5)},${f(cy)}L${f(cx - dir * 2.8)},${f(cy + 2.8)}`;
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
      <ellipse class="cl" rx="4.2" ry="2.3" fill="#ff8fa8" opacity="0"/><ellipse class="cr" rx="4.2" ry="2.3" fill="#ff8fa8" opacity="0"/>
      <path class="gl" filter="url(#${u}b)"/><path class="gr" filter="url(#${u}b)"/>
      <path class="el" stroke-width="1.5" stroke-linejoin="round"/><path class="er" stroke-width="1.5" stroke-linejoin="round"/>
      <path class="xl" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
      <path class="xr" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
      <path class="bl" fill="none" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
      <path class="br" fill="none" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
      <path class="mouth" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </g></svg>`;
}

/* Every logo gets a face; they are one creature, drawn from one state. Only the
 * ones on screen are drawn: an IntersectionObserver keeps `seen` current, and a
 * face coming into view wakes the loop so it shows the current expression. */
function mascotBuild() {
  mascot.insts = [...document.querySelectorAll('.logo-mascot')].map((wrap, i) => {
    wrap.innerHTML = mascotSvg('mascot' + i);
    const q = (s) => wrap.querySelector(s);
    const inst = { wrap, svg: q('svg'), lamp: q('.mascot-lamp'), head: q('.head'),
      s1: q('.s1'), s2: q('.s2'), s3: q('.s3'), facet: q('.facet'),
      el: q('.el'), er: q('.er'), gl: q('.gl'), gr: q('.gr'), xl: q('.xl'), xr: q('.xr'),
      bl: q('.bl'), br: q('.br'), cl: q('.cl'), cr: q('.cr'), mouth: q('.mouth'), seen: true };
    if (typeof IntersectionObserver === 'function') {
      inst.seen = false;
      new IntersectionObserver((entries) => {
        inst.seen = entries[entries.length - 1].isIntersecting;
        mascot.rectAt = -1e9;
        if (inst.seen) mascotWake();
      }).observe(wrap);
    }
    wrap.addEventListener('pointerenter', () => {
      mascot.hover = true; mascot.hoverAt = performance.now();
      mascot.pet = { x: null, dir: 0, flips: [] };
      setTimeout(mascotWake, 1600);   // still here then: it turns a little shy
      mascotWake();
    });
    wrap.addEventListener('pointerleave', () => { mascot.hover = false; mascotWake(); });
    wrap.addEventListener('pointermove', mascotPetMove, { passive: true });
    wrap.addEventListener('click', mascotBoop);
    return inst;
  });
}

/* Writes only what changed since this element was last drawn — most frames at a
 * steady expression change a handful of attributes, not thirty. */
function mascotAttr(el, name, val) {
  const k = '_m_' + name;
  if (el[k] === val) return;
  el[k] = val;
  el.setAttribute(name, val);
}
function mascotCss(el, prop, val) {
  const k = '_mc_' + prop;
  if (el[k] === val) return;
  el[k] = val;
  el.style.setProperty(prop, val);
}

function mascotDraw(inst) {
  const F = mascot.face;
  const [cr, cg, cb] = F.tint.map((v) => Math.round(v));
  const light = `rgb(${cr},${cg},${cb})`;
  mascotAttr(inst.s1, 'stop-color', light);
  mascotAttr(inst.s2, 'stop-color', `rgb(${Math.round(cr * 0.76)},${Math.round(cg * 0.89)},${Math.round(cb * 0.84)})`);
  mascotAttr(inst.s3, 'stop-color', `rgb(${Math.round(cr * 0.44)},${Math.round(cg * 0.62)},${Math.round(cb * 0.58)})`);
  mascotCss(inst.facet, 'stroke', light);
  const lx = F.lx * MASCOT_LOOK[0], ly = F.ly * MASCOT_LOOK[1];
  mascotAttr(inst.head, 'transform',
    `translate(${(F.shX * 0.08).toFixed(2)} ${F.bobY.toFixed(2)}) rotate(${(F.tilt + F.shX).toFixed(2)} 32 60) ` +
    `translate(32 60) scale(${(1 + F.sqY * 0.05).toFixed(3)} ${(1 - F.sqY * 0.07).toFixed(3)}) translate(-32 -60)`);
  const ink = `rgb(${cr + Math.round((255 - cr) * 0.3)},${cg + Math.round((255 - cg) * 0.3)},${cb + Math.round((255 - cb) * 0.3)})`;
  // The glow is quantised so a steady glow doesn't rewrite the (costly) drop-shadow every frame.
  const g = Math.round(Math.max(0, Math.min(1, F.glow + F.beat)) * 50) / 50;
  const scrunch = Math.max(0, Math.min(1, F.scrunch));
  const brow = MASCOT_BROW_Y - F.brow * 2.4 + ly * 0.5;
  ['l', 'r'].forEach((side, i) => {
    const cx = MASCOT_EYES[i][0] + lx, cy = MASCOT_EYES[i][1] + ly, dir = i ? -1 : 1;
    const h = MASCOT_EYE_H * Math.max(0.05, F.open * mascotBlinkFactor(F, side) * (1 - scrunch));
    const d = mascotEyePath(cx, cy, MASCOT_EYE_W, h, Math.max(0, Math.min(1, F.happy)));
    // Droop tips the outer corners down (sad); a negative droop is a focused frown.
    const tf = `rotate(${((i ? 1 : -1) * F.droop * 15).toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)})`;
    const eye = inst['e' + side], glow = inst['g' + side], x = inst['x' + side], b = inst['b' + side];
    mascotAttr(eye, 'd', d); mascotAttr(eye, 'transform', tf);
    mascotCss(eye, 'fill', ink); mascotCss(eye, 'stroke', ink);
    mascotAttr(glow, 'd', d); mascotAttr(glow, 'transform', tf);
    mascotCss(glow, 'fill', light); mascotCss(glow, 'opacity', (0.2 + 0.8 * g).toFixed(2));
    mascotAttr(x, 'opacity', scrunch.toFixed(2));
    if (scrunch > 0.01) { mascotAttr(x, 'd', mascotScrunchPath(cx, cy, dir)); mascotCss(x, 'stroke', ink); }
    // One brow can rise on its own (browQ): positive lifts the left, negative the
    // right, and the other settles a touch.
    const up = Math.max(0, i ? -F.browQ : F.browQ), down = Math.max(0, i ? F.browQ : -F.browQ);
    const q = up * 2.4 - down * 0.6;
    mascotAttr(b, 'd', mascotBrowPath(cx * 0.6 + MASCOT_EYES[i][0] * 0.4, brow - q, dir, F.browA - F.droop * 0.4));
    mascotCss(b, 'stroke', ink);
    const ch = inst['c' + side];
    mascotAttr(ch, 'opacity', (Math.max(0, Math.min(1, F.blush)) * 0.55).toFixed(2));
    mascotAttr(ch, 'cx', (MASCOT_CHEEKS[i][0] + lx * 0.3).toFixed(1));
    mascotAttr(ch, 'cy', (MASCOT_CHEEKS[i][1] + ly * 0.3).toFixed(1));
  });
  mascotAttr(inst.mouth, 'd', mascotMouthPath(MASCOT_MOUTH[0] + lx * 0.55 + F.mx * 2.6, MASCOT_MOUTH[1] + ly * 0.5,
    MASCOT_MOUTH_W * F.mw, F.smile, F.talk, F.skew));
  mascotCss(inst.mouth, 'fill', ink); mascotCss(inst.mouth, 'stroke', ink);
  mascotCss(inst.wrap, '--mascot-tint', `${cr},${cg},${cb}`);
  mascotCss(inst.lamp, 'opacity', (g * 0.95).toFixed(2));
  mascotCss(inst.svg, 'filter', `drop-shadow(0 0 ${(2 + g * 6).toFixed(1)}px rgba(${cr},${cg},${cb},${(0.15 + g * 0.3).toFixed(2)}))`);
}

/* A little something floating off the face — a note, a spark, a "?", a heart, a
 * sweat drop — on the face that's on screen. CSS animates it (transform and
 * opacity only) and it removes itself; a few at most at once. */
function mascotPuff(kind) {
  if (mascotStill() || !(kind in MASCOT_PUFFS)) return;
  const inst = mascot.insts.find((i) => i.seen);
  if (!inst) return;
  const old = inst.wrap.querySelectorAll('.mascot-puff');
  if (old.length >= 3) old[0].remove();
  const el = document.createElement('span');
  el.className = 'mascot-puff mascot-puff-' + kind;
  el.textContent = MASCOT_PUFFS[kind];
  el.style.setProperty('--dx', (Math.random() * 8 - 4).toFixed(1) + 'px');
  el.addEventListener('animationend', () => el.remove());
  inst.wrap.appendChild(el);
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
/* The face on screen, in client coordinates. Measured at most once a second (and
 * again when a face comes into view or the window resizes), so following the
 * pointer never forces a layout on every frame of a streaming reply. */
function mascotRect() {
  const now = performance.now();
  if (now - mascot.rectAt < 1000) return mascot.rect;
  mascot.rectAt = now;
  const inst = mascot.insts.find((i) => i.seen);
  mascot.rect = inst ? inst.wrap.getBoundingClientRect() : null;
  return mascot.rect;
}
/* The pointer relative to the face on screen, -1..1 each way (or null). */
function mascotPointer() {
  const at = mascot.ptrAt, r = at && mascotRect();
  if (!r) return null;
  const c = (v) => Math.max(-1, Math.min(1, v));
  return { x: c((at.x - (r.left + r.width / 2)) / 260), y: c((at.y - (r.top + r.height / 2)) / 200) };
}

function mascotWake() {
  if (mascot.raf || !mascot.insts.length) return;
  mascot.last = 0;
  mascot.raf = requestAnimationFrame(mascotFrame);
}

/* Play an act now (or `delay` ms from now). Not while still, waiting on you, or
 * asleep — those hold their face. */
function mascotPlay(name, delay) {
  if (!MASCOT_ACTS[name] || mascotStill() || mascotWaiting() || mascot.mood === 'sleep') return false;
  mascot.act = { name, at: performance.now() + (delay || 0), cue: 0 };
  mascotWake();
  return true;
}
/* Fire the act's cues that its progress has reached; drop it once it's over. */
function mascotActCues(now) {
  const a = mascot.act;
  if (!a) return;
  const def = MASCOT_ACTS[a.name], cues = def.cues || [];
  const p = (now - a.at) / def.ms;
  while (a.cue < cues.length && p >= cues[a.cue][0]) mascotCue(cues[a.cue++][1]);
  if (p >= 1) mascot.act = null;
}
function mascotCue(kind) {
  if (kind.startsWith('puff:')) mascotPuff(kind.slice(5));
  else if (kind === 'blink') mascotBlink();
  else if (kind === 'achoo') { mascotImpulse('squash'); mascotImpulse('nod'); mascotImpulse('wobble'); mascotBeat(0.3); }
  else mascotImpulse(kind);
}

function mascotFrame(now) {
  mascot.raf = 0;
  if (document.hidden) { mascot.last = 0; return; }   // picked up again on visibilitychange
  // Only a slow drift going on (thinking, working): half the frames are plenty.
  if (mascot.lazy && now - mascot.drawnAt < 30) { mascot.raf = requestAnimationFrame(mascotFrame); return; }
  const dt = mascot.last ? Math.min(0.05, (now - mascot.last) / 1000) : 1 / 60;
  mascot.last = now;
  mascotActCues(now);
  const still = mascotStill(), waiting = mascotWaiting();
  mascotMark(waiting ? 'waiting' : mascot.mood);
  const env = { now, t: now / 1000, still, waiting, ptr: still ? null : mascotPointer() };
  const glancing = !!(mascot.glance && now < mascot.glance.until);
  const reacting = !!(mascot.react && now - mascot.react.at < (MASCOT_REACTION_MS[mascot.react.kind] || 0));
  const voiced = mascot.mood === 'writing' || mascot.mood === 'typing';
  const talking = voiced && mascotVoiceBusy(mascot.voice);
  const acting = !!mascot.act && !still && !waiting;
  if (voiced && !still) mascot.talk = mascotVoiceStep(mascot.voice, dt, Math.random);
  const drifting = mascot.mood === 'thinking' || mascot.mood === 'working';
  env.busy = glancing || (!still && !waiting && (reacting || talking || acting || drifting));
  const F = mascot.face;
  const more = mascotStep(F, mascotTarget(mascot, env), dt, env);
  for (const inst of mascot.insts) if (inst.seen) mascotDraw(inst);
  mascot.drawnAt = now;
  mascot.lazy = drifting && !glancing && !reacting && !acting && !F.blink && !mascot.hover &&
    Math.abs(F.bobV) + Math.abs(F.sqV) + Math.abs(F.shV) < 0.5;
  if (more) mascot.raf = requestAnimationFrame(mascotFrame);
}

/* Mark the faces with the mood they show, for the CSS idle loop (mascot.css):
 * how much it breathes, bobs and sways — and not at all while it waits on you.
 * Written only when it changes. */
function mascotMark(mood) {
  if (mascot.shown === mood) return;
  mascot.shown = mood;
  for (const inst of mascot.insts) {
    inst.wrap.dataset.mood = mood;
    inst.wrap.classList.toggle('asleep', mood === 'sleep');
  }
}

function mascotSetMood(mood, holdMs) {
  if (mood !== mascot.mood) mascot.moodAt = performance.now();
  mascot.mood = mood;
  mascotMark(mood);
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
  else if (kind === 'stretch') F.sqV -= 11;   // tall and thin
  else if (kind === 'shake') F.shV += 150;
  else if (kind === 'wobble') F.shV += (Math.random() < 0.5 ? -1 : 1) * 55;
  else if (kind === 'rise') F.bobV -= 28;     // a breath in
  else if (kind === 'bop') F.bobV -= 34;      // a little bounce on the spot
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
  } else if (mascot.mood === 'drowsy') {
    mascotSetMood('rest');
    if (mascot.act && MASCOT_ACTS[mascot.act.name].idle) mascot.act = null;
    mascotPlay('perk');   // oh! — awake, awake
  } else if (input && mascot.mood === 'error') {
    mascotSetMood('rest');
  }
  // Real input ends whatever it was amusing itself with: you're back.
  if (input && mascot.act && MASCOT_ACTS[mascot.act.name].idle) { mascot.act = null; mascotWake(); }
}
/* Now and then, at random, a bit of personality (mascotQuirk) or a fidget (see
 * mascotFidget); then the next is scheduled. */
function mascotFidgetTick() {
  const [lo, hi] = MASCOT_FIDGET_MS;
  mascot.fidgetT = setTimeout(mascotFidgetTick, lo + Math.random() * (hi - lo));
  if (document.hidden || mascotStill()) return;
  const now = performance.now();
  if (mascot.act && now - mascot.act.at < MASCOT_ACTS[mascot.act.name].ms) return;   // let it finish
  const mood = mascotWaiting() ? 'waiting' : mascot.mood;
  const quirk = !mascot.hover && mascotQuirk(mood, Math.random, {
    quiet: now - mascot.lastAct, since: now - mascot.quirkAt,
    night: mascotNight(new Date().getHours()), steps: mascot.turnSteps });
  if (quirk) {
    mascot.quirkAt = now;
    if (quirk.act) mascotPlay(quirk.act); else mascotPuff(quirk.puff);
    return;
  }
  const f = mascotFidget(mood, Math.random);
  if (!f) return;
  if (f.kind === 'blink') mascotBlink('both', mood === 'drowsy' ? 0.5 : 0.2);   // drowsy blinks are slow
  else if (f.kind === 'double') { mascotBlink(); setTimeout(() => mascotBlink(), 280); }
  else if (f.kind === 'smile') { mascot.idle.smile = f.smile; mascotWake(); }
  else if (f.kind === 'tilt') { mascot.idle.tilt = f.tilt; mascotWake(); }
  else if (f.kind === 'mouth') { mascot.idle.mx = f.mx; mascot.idle.skew = f.skew; mascotWake(); }
  else if (f.kind === 'brow') { mascot.idle.brow = f.brow; mascotWake(); }
  else if (f.kind === 'act') mascotPlay(f.act);
  else if (f.kind === 'look' && !mascot.hover) mascotLook(f.x, f.y, f.ms);
}

/* Blinks keep their own clock — every few seconds, now and then two — so the
 * face blinks like a face, whatever else it is doing. Drowsy blinks are slow. */
function mascotBlinkTick() {
  const [lo, hi] = MASCOT_BLINK_MS;
  setTimeout(mascotBlinkTick, lo + Math.random() * (hi - lo));
  if (document.hidden || mascotStill() || mascotWaiting() || mascot.mood === 'sleep') return;
  if (mascot.act && performance.now() - mascot.act.at < MASCOT_ACTS[mascot.act.name].ms) return;
  if (mascot.mood === 'drowsy') { mascotBlink('both', 0.55); return; }
  mascotBlink();
  if (Math.random() < 0.15) setTimeout(() => mascotBlink(), 260);
}

/* At rest the eyes make small darts — a living eye never quite holds still. A
 * dart is a short burst of frames; between them the loop stops again. */
function mascotSaccadeTick() {
  const [lo, hi] = MASCOT_SACCADE_MS;
  setTimeout(mascotSaccadeTick, lo + Math.random() * (hi - lo));
  if (document.hidden || mascotStill() || mascot.hover) return;
  if (!['rest', 'done', 'drowsy'].includes(mascot.mood) || mascotWaiting()) return;
  // Mostly a small hop back toward centre, now and then a bigger look.
  const big = Math.random() < 0.25, a = big ? 0.32 : 0.14;
  mascot.sacc = { x: (Math.random() * 2 - 1) * a, y: (Math.random() * 2 - 1) * a * 0.7 };
  mascotWake();
}

/* Nothing for a while and no turn running anywhere: first its lids get heavy
 * (drowsy), then it yawns and its eyes close, and from then on nothing moves but
 * its breath until you're back. Sooner late at night. */
function mascotIdleCheck() {
  const quiet = performance.now() - mascot.lastAct;
  const k = mascotNight(new Date().getHours()) ? 0.6 : 1;
  const drowsyAt = MASCOT_DROWSY_MS * k, sleepAt = MASCOT_IDLE_MS * k;
  const free = !state.live.size;
  if (free && mascot.mood === 'rest' && quiet >= drowsyAt) mascotSetMood('drowsy');
  if (free && mascot.mood === 'drowsy' && quiet >= sleepAt) mascotFallAsleep();
  // Look again when the next step would be due; quiet but busy (a turn is
  // running): a whole stretch later rather than polling.
  const next = quiet < drowsyAt ? drowsyAt - quiet : quiet < sleepAt ? sleepAt - quiet : sleepAt;
  mascot.idleT = setTimeout(mascotIdleCheck, Math.max(1000, next));
}
function mascotFallAsleep() {
  if (!mascotPlay('yawn')) { mascotSetMood('sleep'); return; }
  setTimeout(() => { if (mascot.mood === 'drowsy') mascotSetMood('sleep'); }, MASCOT_ACTS.yawn.ms);
}

/* The pointer over the face: rubbing it back and forth is petting. */
function mascotPetMove(e) {
  if (!mascotPetFeed(mascot.pet, e.clientX, performance.now())) return;
  const now = performance.now();
  if (mascot.act && mascot.act.name === 'huff') return;   // not now
  if (now - mascot.petAt > 300) {
    mascot.petAt = now;
    if (mascot.act && mascot.act.name === 'purr') mascot.act.at = now - MASCOT_ACTS.purr.ms * 0.15;   // keep purring
    else mascotPlay('purr');
  }
  if (now - mascot.heartAt > 1400) { mascot.heartAt = now; mascotPuff('heart'); }
}

/* The pointer whipping past close by makes it jump — now and then, not every time. */
function mascotStartleCheck(e) {
  const prev = mascot.ptrPrev;
  mascot.ptrPrev = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  if (!prev || mascot.hover || mascot.act || !['rest', 'done'].includes(mascot.mood)) return;
  const dt = e.timeStamp - prev.t, now = performance.now();
  if (dt <= 0 || dt > 60 || now - mascot.startleAt < 20000) return;
  if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) / dt < 3.5) return;
  const r = mascotRect();
  if (!r || Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) > 110) return;
  mascot.startleAt = now;
  if (Math.random() < 0.6 && !mascotStill()) mascotPlay('startle');
}

document.addEventListener('pointermove', (e) => {
  mascot.ptrAt = { x: e.clientX, y: e.clientY };
  mascotActivity(false);
  mascotStartleCheck(e);
  if (mascot.mood === 'rest' || mascot.mood === 'done') mascotWake();
}, { passive: true });
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;   // left the window, not just an element
  mascot.ptrAt = null;
  mascotWake();
});
document.addEventListener('pointerdown', () => mascotActivity(true), true);
document.addEventListener('keydown', () => mascotActivity(true), true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) mascotWake(); });
window.addEventListener('resize', () => { mascot.rectAt = -1e9; });
window.addEventListener('blur', () => { mascot.blurAt = performance.now(); });
window.addEventListener('focus', () => {   // back to the window: a new scene — or, after a long while, hello
  const away = mascot.blurAt && performance.now() - mascot.blurAt > MASCOT_AWAY_MS;
  mascot.blurAt = 0;
  if (away && mascot.mood !== 'sleep' && mascotPlay('hi')) return;
  mascotBlink();
});

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
  if (mascot.mood === 'sleep' || mascot.mood === 'drowsy') mascotSetMood('rest');
  if (mascotStill()) { mascotWake(); return; }
  mascot.face.open = 0;
  mascotImpulse('hop');
  mascotBeat(0.25);
  // …and how it's feeling about the hour: a yawn late at night, a stretch in the morning.
  const h = new Date().getHours();
  if (mascotNight(h)) mascotPlay('yawn', 700);
  else if (h >= 6 && h < 10) mascotPlay('stretch', 600);
  else if (Math.random() < 0.5) mascotPlay('hi', 450);
}

/* Clicked: a squish and a wink. Keep clicking and it giggles, then gets dizzy,
 * then has had enough and huffs, looking away — clicks then just get a shake. */
function mascotBoop() {
  const now = performance.now();
  mascotImpulse('squash');
  mascotBeat(0.25);
  if (mascot.act && mascot.act.name === 'huff' && now - mascot.act.at < MASCOT_ACTS.huff.ms) {
    mascotImpulse('wobble');
    return;
  }
  mascot.boops = now - mascot.boopAt < MASCOT_BOOP_MS ? mascot.boops + 1 : 1;
  mascot.boopAt = now;
  const kind = mascotBoopKind(mascot.boops);
  if (kind === 'wink') mascotBlink('l', 0.28);
  else if (kind === 'giggle') mascotPlay('giggle');
  else if (kind === 'dizzy') { if (!mascot.act || mascot.act.name !== 'dizzy') mascotPlay('dizzy'); }
  else { mascotPlay('huff'); mascot.boops = 0; }
}

/* What you just typed makes it react, pure: `value` is the composer, `pos` the
 * caret, `grew` how much longer it got with this key, `kindDone` whether this
 * message already got its blush. Returns the act to play (or `nod` for the end
 * of a word, or null). */
function mascotTypeReaction(value, pos, grew, kindDone) {
  if (grew <= -12) return 'wince';                    // a lot wiped out at once
  if (grew === -1) return 'oops';                     // a backspace: a little "oops"
  const len = value.length, before = len - grew;
  for (const mark of MASCOT_TYPE_MILESTONES) if (before < mark && len >= mark) return 'whoa';   // a long one!
  if (grew !== 1) return null;                        // a paste, or nothing new
  const ch = value[pos - 1], prev = value.slice(Math.max(0, pos - 3), pos);
  if (!kindDone && MASCOT_KIND.test(value.slice(Math.max(0, pos - 30), pos))) return 'shy';
  if (ch === '?') return 'curious';
  if (ch === '!') return 'excite';
  if (prev === '...') return 'skeptic';
  if (/[:;=]-?\)$|\bxd$/i.test(prev)) return 'grin';
  if (/[:;=]-?\($/.test(prev)) return 'pout';
  const tail = value.slice(Math.max(0, pos - 6), pos);
  if (/^[A-ZČĆŽŠĐ]{6}$/.test(tail)) return 'shout';    // CAPS LOCK ENERGY
  if (ch === ' ' || ch === '\n') return 'nod';
  return null;
}

/* A key went into the composer: it watches, eyes on the caret, mouthing along
 * under its breath, and reacts to what you write (mascotTypeReaction): a "?" a
 * curious tilt, a "!" a little jump, "..." a raised brow, a smiley a grin, a
 * backspace an "oops", wiping out a lot a wince, a "thanks" a blush, a long
 * message a "whoa", typing fast raised brows, a nod at the end of each word.
 * When you pause with something written, it looks up at you: go on? Not mid-turn
 * — then it's watching the turn. */
function mascotKey() {
  if (!['rest', 'typing', 'done', 'error', 'drowsy', 'sleep'].includes(mascot.mood)) return;
  const el = els.input, now = performance.now();
  const pos = el.selectionStart || 0, len = el.value.length, grew = len - mascot.inLen;
  mascot.inLen = len;
  const line = el.value.slice(0, pos).split('\n').pop();
  mascot.caret = Math.max(0.2, Math.min(1, 0.2 + (line.length * 7.4) / Math.max(200, el.clientWidth || 0)));
  mascot.keys = mascot.keys.filter((t) => now - t < 1000);
  mascot.keys.push(now);
  mascot.fast = mascot.keys.length >= 9;
  if (!len) mascot.kind = false;
  mascotSetMood('typing');
  if (grew === 1) { mascotVoiceFeed(mascot.voice, el.value[pos - 1] || ''); mascotWake(); }
  const react = mascotTypeReaction(el.value, pos, grew, mascot.kind);
  if (react === 'nod') {
    if (now - (mascot.typeAt.nod || -1e9) > 140 && !mascotStill()) { mascot.typeAt.nod = now; mascot.face.bobV += 9; mascotWake(); }
  } else if (react && now - (mascot.typeAt[react] || -1e9) > (MASCOT_TYPE_GAP_MS[react] || 0)) {
    mascot.typeAt[react] = now;
    if (react === 'shy') mascot.kind = true;
    mascotPlay(react);
  }
  clearTimeout(mascot.typingT);
  mascot.typingT = setTimeout(() => {
    mascot.fast = false;
    mascotHush();
    if (mascot.mood !== 'typing') return;
    mascotSetMood('rest');
    // Paused with something written: it looks up at you — go on?
    const t = performance.now();
    if (els.input.value.trim() && !mascot.act && t - (mascot.typeAt.expect || -1e9) > 8000) {
      mascot.typeAt.expect = t;
      mascotPlay('expect');
    }
  }, MASCOT_TYPING_MS);
}

/* A turn started on screen: a hop, and the eyes follow the message up. */
function mascotTurnBegan() {
  clearTimeout(mascot.typingT);
  mascot.act = null;   // whatever it was doing, it's on the job now
  mascotHush();        // and it stops mouthing along with your typing
  mascot.fast = false; mascot.kind = false; mascot.inLen = 0;
  mascot.turnAt = performance.now(); mascot.turnSteps = 0;
  mascotSetMood('thinking');
  mascotImpulse('hop');
  mascotLook(0.9, -0.9, 420);
}

/* What the turn on screen is doing now (the typer's thinking/working/streaming).
 * A long think that turns into words lights it up. */
function mascotMode(mode) {
  const mood = mode === 'streaming' ? 'writing' : mode;
  if (mascot.mood === mood) return;
  const thought = mascot.mood === 'thinking' ? performance.now() - mascot.moodAt : 0;
  if (mood !== 'writing') mascotHush();
  if (mascot.act && mascot.act.name === 'ponder') mascot.act = null;
  mascotSetMood(mood);
  if (mood === 'writing' && thought > 5000) mascotPlay('eureka');
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
  mascot.turnSteps++;
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
  const now = performance.now();
  mascot.lastAct = now;
  // A long haul (a minute's work, or a lot of steps) earns a little celebration.
  const long = !!mascot.turnAt && (now - mascot.turnAt > 45000 || mascot.turnSteps >= 15);
  mascot.turnAt = 0; mascot.turnSteps = 0;
  if (mascot.act && mascot.act.name !== 'eureka') mascot.act = null;
  if (live && live.stopped) { mascotSetMood('rest'); return; }
  if (live && live.failed) {
    mascotSetMood('error', MASCOT_ERROR_MS);
    mascotImpulse('shake');
    mascotBeat(0.3);
    mascotPuff('drop');
    return;
  }
  mascotSetMood('done', MASCOT_DONE_MS);
  mascotBeat(0.3);
  if (long) mascotPlay('wiggle', 150);
  else if (Math.random() < 0.35) mascotPuff('spark');
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
setTimeout(mascotBlinkTick, MASCOT_BLINK_MS[0]);
setTimeout(mascotSaccadeTick, MASCOT_SACCADE_MS[1]);
mascotMark('rest');
mascotWake();
