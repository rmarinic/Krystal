/* Work light — how a full-screen wait looks while something real goes on behind
 * it: Compact / Clear / Update Claude Code (the proc overlay, controls.js and
 * settings.js) and Krystal's own self-update (updater.js). The updater runs
 * before the app/ modules load, which is why this lives here and loads first.
 *
 * What it replaced: an icon bobbing on a 1.5s loop and a sheen sweeping the bar
 * every 1.1s, over a bar that crept to 88% in a few seconds and sat there. The
 * eye learned the loop almost at once, and a long compact looked busy and stuck
 * at the same time.
 *
 * What answers what:
 *  - The bar's fill is how far the work has got. Real progress (the summary's
 *    characters, the download's bytes) sets it. Until any arrives it creeps on
 *    time toward a small cap, slower and slower, so it never claims work that
 *    hasn't happened and never stops dead either. It only moves forward, and
 *    only `done` takes it to the end.
 *  - Light sits behind the icon and at the bar's leading edge. Each real event
 *    (a piece of the summary, a log line, a downloaded chunk) brightens it at
 *    once, then it cools slowly (catch fast, release slow), so the rhythm on
 *    screen is the work's own. Between events it holds a dim floor with a faint
 *    aperiodic flicker (incommensurate sines, Extra effects only): a quiet
 *    stretch reads as "still on it", never as a cycle.
 *  - Done: the bar runs to the end, the light swells once and cools, and the
 *    frame loop stops.
 * Reduced motion: the bar steps to where the work is, the light shows its level
 * without flicker. */

const WORK_FLOOR = 0.3;     // the light while working with nothing new arriving
const WORK_COOL_S = 1.1;    // how slowly a brightening fades back to the floor
const WORK_EASE_S = 0.35;   // how quickly the bar catches up with the work
const WORK_KICK = 0.16;     // one event's brightening (a share of the way to full)
const WORK_KICK_GAP_MS = 90;  // events closer than this count once (downloads send hundreds)
const WORK_END = 0.97;      // the furthest real progress may take the bar before `done`

function workState() {
  return { t: 0, shown: 0, real: 0, crawlCap: 0.1, crawlTau: 4, glow: 0, light: 0, done: false };
}

/* Where the bar should be: the work's real progress, or the time crawl while
 * there is none yet (whichever is further). */
function workTarget(W) {
  if (W.done) return 1;
  const crawl = W.crawlCap * (1 - Math.exp(-W.t / W.crawlTau));
  return Math.min(WORK_END, Math.max(crawl, W.real));
}

/* An event brightens the light by a share of what's left, so a burst of them
 * lifts it smoothly toward full instead of pinning it there. */
function workKick(W, k) {
  W.glow = Math.max(W.glow, WORK_FLOOR);
  W.glow += (1 - W.glow) * k;
}

/* One frame. Returns whether the light still wants frames: always while
 * working; after `done`, until the bar has arrived and the light has cooled. */
function workStep(W, dt, env) {
  W.t += dt;
  const target = workTarget(W);
  if (env.reduced) W.shown = Math.max(W.shown, target);
  else {
    const ease = W.done ? WORK_EASE_S / 2 : WORK_EASE_S;
    W.shown = Math.max(W.shown, W.shown + (target - W.shown) * (1 - Math.exp(-dt / ease)));
  }
  W.glow += ((W.done ? 0 : WORK_FLOOR) - W.glow) * (1 - Math.exp(-dt / WORK_COOL_S));
  let flicker = 0;
  if (!W.done && env.fx && !env.reduced) {
    const t = W.t;
    flicker = 0.05 * (Math.sin(t * 1.9) + 0.6 * Math.sin(t * 3.1 + 1.3) + 0.35 * Math.sin(t * 5.3 + 0.4)) / 1.95;
  }
  W.light = Math.max(0, Math.min(1, W.glow + flicker));
  if (!W.done) return true;
  return W.glow > 0.01 || 1 - W.shown > 0.002;
}

/* The light for one overlay. `root` carries `--work-light` (the CSS draws the
 * glow behind the icon and at the bar's edge from it); `fill` is the bar,
 * full-width and slid into place with a transform so a frame never re-lays out. */
function workLight(root, fill) {
  let W = workState();
  let raf = 0, last = 0, on = false, lastKick = -Infinity;
  const rm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const env = () => ({
    reduced: !!(rm && rm.matches),
    fx: document.body.classList.contains('fx-on'),
  });

  function paint() {
    if (fill) fill.style.transform = `translateX(${((W.shown - 1) * 100).toFixed(2)}%)`;
    if (root) root.style.setProperty('--work-light', W.light.toFixed(3));
  }
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const more = workStep(W, dt, env());
    paint();
    raf = on && more ? requestAnimationFrame(frame) : 0;
  }
  function wake() {
    if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  return {
    /* A fresh wait. `cap`/`tau`: how far, and how slowly, the bar may creep on
     * time alone before real progress arrives. */
    start({ cap = 0.1, tau = 4 } = {}) {
      cancelAnimationFrame(raf); raf = 0;
      W = Object.assign(workState(), { crawlCap: cap, crawlTau: tau });
      on = true; lastKick = -Infinity;
      paint();
      wake();
    },
    /* Real progress, 0..1. Never moves the bar back. */
    progress(frac) { W.real = Math.max(W.real, Math.min(1, frac || 0)); wake(); },
    /* Something real happened without a measurable fraction (a log line, a chunk). */
    kick(k = WORK_KICK) {
      const now = performance.now();
      if (now - lastKick < WORK_KICK_GAP_MS) return;
      lastKick = now;
      workKick(W, k);
      wake();
    },
    /* It finished: run the bar out, swell once, cool, come to rest. */
    done() { W.done = true; workKick(W, 1); wake(); },
    /* Gone without finishing (failed, hidden): stop at once. */
    stop() { on = false; cancelAnimationFrame(raf); raf = 0; },
  };
}
