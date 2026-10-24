/* light.js      — the living light behind the chat: it answers what Claude is
                   doing instead of pulsing on a timer.
   Part of the chat frontend; shares one global scope (see core.js). Styles live
   in chat.css ("Living light"); the layers themselves are in index.html.

   A loop that runs whatever happens is a screensaver: the eye learns it within a
   minute and from then on it is wallpaper, or an irritant. Light that *answers*
   something reads as alive. So there is no backlight any more, only light where
   the work is:

     • the lamp   — a soft source behind the line Claude is writing, following it
                    down the page. It rises from the composer when you send, flickers
                    faintly while Claude thinks or works, and while text streams its
                    brightness is fed by the words being revealed, so the flicker is
                    the rhythm of the reply rather than a sine wave;
     • a beat     — one soft breath sideways, at a step's own height, when a tool
                    hands back its result: the heartbeat, set by the work;
     • the floor  — warms a little under the composer with each keystroke, cools
                    when you stop;
     • needs you  — a turn stopped on a permission prompt turns the lamp amber and
                    perfectly still; waiting is the one state with no motion at all;
     • rest       — when the turn ends the lamp cools like a filament and the loop
                    stops. Nothing happening means nothing moves.

   Only the chat on screen lights anything. Everything is gated on Extra effects
   (body.fx-on); under reduced motion the lamp still shows the state, but without
   the flicker, the beats or the glide. */

const LIGHT_BASE = { rest: 0, thinking: 0.34, working: 0.42, streaming: 0.5, waiting: 0.55 };
const LIGHT_WORD_KICK = 0.005;    // energy per revealed character
const LIGHT_ENERGY_MAX = 0.5;
const LIGHT_BEAT_GAP_MS = 350;    // parallel tool results shouldn't stack their beats

const lightState = {
  mode: 'rest',     // rest | thinking | working | streaming (waiting is read live)
  I: 0,             // lamp intensity
  energy: 0,        // kicks from text being revealed, decaying
  floorE: 0,        // kicks from keystrokes, decaying
  amber: 0,         // 0 → green, 1 → amber
  y: 0, yT: 0,      // lamp height in .chat, eased toward yT
  t: 0,             // flicker clock
  anchor: null,     // the live reply's element; the lamp sits at its bottom edge
  raf: 0, last: 0, beatAt: 0,
};

/* One step of the light, pure: given the state, the elapsed time and what the
 * world looks like (`env`: waiting / still / reduced), move the state on and say
 * whether there is anything left to animate. Kept free of the DOM for the tests. */
function lightStep(L, dt, env) {
  L.t += dt;
  L.energy *= Math.exp(-dt * 2.4);
  L.floorE *= Math.exp(-dt * 1.5);
  const waiting = !!env.waiting && L.mode !== 'rest';
  const busy = !waiting && L.mode !== 'rest';
  // Three sines at unrelated rates: a flicker that never comes round the same way.
  const t = L.t;
  const flick = env.reduced ? 0 : (Math.sin(t * 2.1) + Math.sin(t * 3.43 + 1.3) + Math.sin(t * 5.71 + 0.4)) / 3;
  const target = waiting ? LIGHT_BASE.waiting
    : LIGHT_BASE[L.mode] + L.energy + (busy ? 0.045 * flick : 0);
  // It catches quickly and lets go slowly — and slowest of all once the turn is
  // over, which is the filament cooling.
  const k = target > L.I ? 5 : (L.mode === 'rest' ? 0.85 : 2.2);
  L.I += (target - L.I) * (1 - Math.exp(-dt * k));
  L.amber += ((waiting ? 1 : 0) - L.amber) * (1 - Math.exp(-dt * 2.5));
  L.y = env.reduced ? L.yT : L.y + (L.yT - L.y) * (1 - Math.exp(-dt * 3.2));
  if (L.mode !== 'rest') return true;
  return L.I > 0.003 || L.floorE > 0.003 || L.amber > 0.01;
}

function lightOn() { return document.body.classList.contains('fx-on'); }

const lightEls = (() => {
  const root = document.getElementById('chat-light');
  if (!root) return null;
  return {
    root,
    chat: root.parentElement,
    lamp: root.querySelector('.cl-lamp'),
    green: root.querySelectorAll('.cl-lamp .g'),
    amber: root.querySelectorAll('.cl-lamp .a'),
    floor: root.querySelector('.cl-floor'),
  };
})();

function lightWake() {
  if (!lightEls || lightState.raf || !lightOn()) return;
  lightState.last = 0;
  lightState.raf = requestAnimationFrame(lightFrame);
}

function lightFrame(now) {
  const L = lightState;
  L.raf = 0;
  if (!lightOn()) { lightPaint(true); return; }
  const dt = L.last ? Math.min(0.05, (now - L.last) / 1000) : 1 / 60;
  L.last = now;

  // Where the lamp should sit: the bottom of the reply being written, kept inside
  // the part of the feed you can see — scrolled away from it, the light waits at
  // the edge nearest the work, as if coming from just out of frame.
  const box = lightEls.chat.getBoundingClientRect();
  if (L.anchor && L.anchor.isConnected) {
    const feed = els.feed.getBoundingClientRect();
    const dock = els.composer && !els.composer.hidden ? els.composer.getBoundingClientRect().top : feed.bottom;
    const y = L.anchor.getBoundingClientRect().bottom - 8;
    L.yT = Math.max(feed.top + 60, Math.min(dock - 24, y)) - box.top;
  }

  const waiting = typeof threadAwaitsPermission === 'function' && threadAwaitsPermission(state.activeId);
  const more = lightStep(L, dt, { waiting, reduced: !motionOK() });
  lightPaint(false);
  if (more) L.raf = requestAnimationFrame(lightFrame);
  else { L.I = L.floorE = L.amber = 0; lightPaint(true); }
}

function lightPaint(off) {
  const L = lightState, e = lightEls;
  const I = off ? 0 : Math.min(1.4, L.I);
  e.lamp.style.transform = `translateY(${L.y.toFixed(1)}px)`;
  e.lamp.style.opacity = I.toFixed(3);
  const g = (1 - L.amber).toFixed(3), a = L.amber.toFixed(3);
  e.green.forEach((n) => { n.style.opacity = g; });
  e.amber.forEach((n) => { n.style.opacity = a; });
  e.floor.style.opacity = off ? '0' : Math.min(1, L.floorE * 0.85).toFixed(3);
}

/* ------------------------------ the hooks ------------------------------- *
 * Called from stream.js, typer.js and composer.js. Each is cheap and safe to call with effects off. */

/* A turn is starting on screen. `from` is where the message left the composer:
 * the lamp starts there and rises to where the answer will appear. */
function lightTurnBegan(from) {
  if (!lightEls || !from) return;
  const box = lightEls.chat.getBoundingClientRect();
  lightState.y = lightState.yT = from.top - box.top;
  lightMode('thinking');   // so lightAnchor lets it rise rather than placing it
}

/* The live reply now on screen (sent just now, or re-attached on a chat switch). */
function lightAnchor(el) {
  lightState.anchor = el || null;
  if (el && lightState.mode === 'rest' && lightState.I < 0.01 && lightEls) {
    // Re-attached without a send to rise from: appear in place, not fly in.
    const box = lightEls.chat.getBoundingClientRect();
    lightState.y = lightState.yT = el.getBoundingClientRect().bottom - 8 - box.top;
  }
}

function lightMode(mode) {
  lightState.mode = mode;
  if (mode !== 'rest') lightWake();
}

/* The turn on screen ended, or the view left it. */
function lightRest() {
  lightState.mode = 'rest';
  lightWake();
}

/* Text was revealed (`n` characters): it feeds the lamp. */
function lightWords(n) {
  if (!n) return;
  lightState.energy = Math.min(LIGHT_ENERGY_MAX, lightState.energy + n * LIGHT_WORD_KICK);
  lightWake();
}

/* A key went into the composer. */
function lightKey() {
  if (!lightEls || !lightOn()) return;
  lightState.floorE = Math.min(1.1, lightState.floorE + 0.16);
  lightWake();
}

/* A step finished (its chip, `el`): one soft breath at its height. */
function lightBeat(el) {
  if (!lightEls || !el || !el.isConnected || !lightOn() || !motionOK()) return;
  const now = performance.now();
  if (now - lightState.beatAt < LIGHT_BEAT_GAP_MS) return;
  lightState.beatAt = now;
  const box = lightEls.chat.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const b = document.createElement('i');
  b.className = 'cl-beat';
  b.style.top = (r.top + r.height / 2 - box.top) + 'px';
  lightEls.root.appendChild(b);
  b.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(.55)' },
    { opacity: 0.9, transform: 'translate(-50%, -50%) scaleX(.95)', offset: 0.22 },
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(1.25)' },
  ], { duration: 1700, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => b.remove();
}
