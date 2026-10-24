/* motion.js     — shared motion helpers: press feel, FLIP reorders, the gliding
                   row mark, rolling numbers, a message's flight out of the
                   composer, and the project → chat screen morph.
   Part of the chat frontend; shares one global scope (see core.js). Styles for
   everything here live in motion.css.

   Every effect is a flourish on something that already works without it: each
   one asks motionOK() first and, under reduced motion (Windows → "Animation
   effects" off), simply does the plain thing. None of them holds up input. */

const reducedMotionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function motionOK() { return !(reducedMotionMQ && reducedMotionMQ.matches); }

const MOTION_EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const MOTION_PRESS_SPRING = 'cubic-bezier(.3,1.6,.5,1)';   // release overshoots ~1%, then settles

/* ------------------------------- press feel ------------------------------ *
 * Anything you click sinks a touch while held and springs back on release.
 * Done with the Web Animations API on the `scale` property, so it composes with
 * whatever `transform` a button already uses for its hover, and never has to
 * share (and clobber) a rule's `transition` list. Big targets — a project card,
 * a chat row — sink less than small ones, or they read as wobbling. The send
 * button has a press of its own. */
const PRESS_TARGETS = 'button, .sidebar-list li > a';
let pressing = null;

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !motionOK() || !e.target.closest) return;
  const el = e.target.closest(PRESS_TARGETS);
  if (!el || el.disabled || el.classList.contains('send-btn')) return;
  releasePress();
  const r = el.getBoundingClientRect();
  const depth = String(r.width > 180 || r.height > 56 ? 0.985 : 0.95);
  pressing = {
    el, depth,
    anim: el.animate([{ scale: '1' }, { scale: depth }], { duration: 90, easing: 'ease-out', fill: 'forwards' }),
  };
}, true);

function releasePress() {
  if (!pressing) return;
  const { el, depth, anim } = pressing;
  pressing = null;
  if (el.isConnected) el.animate([{ scale: depth }, { scale: '1' }], { duration: 420, easing: MOTION_PRESS_SPRING });
  anim.cancel();
}
document.addEventListener('pointerup', releasePress, true);
document.addEventListener('pointercancel', releasePress, true);

/* ------------------------------ FLIP reorder ----------------------------- *
 * Lists here are re-rendered wholesale, so a row that moves (a chat bumped to
 * the top) would teleport. Capture where every keyed child sits, re-render,
 * then call the returned `play()`: each row that moved slides from its old spot
 * to its new one. Positions are offsetTop, so `container` must be positioned —
 * that keeps the measure independent of how far the list is scrolled. */
function flipCapture(container, keyOf) {
  if (!container || !motionOK()) return () => {};
  const before = new Map();
  for (const n of container.children) {
    const k = keyOf(n);
    if (k != null) before.set(k, n.offsetTop);
  }
  return () => {
    for (const n of container.children) {
      const k = keyOf(n);
      if (k == null || !before.has(k)) continue;
      const dy = before.get(k) - n.offsetTop;
      if (Math.abs(dy) < 1) continue;
      n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: MOTION_EASE_OUT });
    }
  };
}

/* ------------------------------ gliding mark ----------------------------- *
 * One highlight that slides to the selected row, instead of each row switching
 * its own background on and off. The list owns a single mark element; because
 * the list is re-rendered (innerHTML) the mark falls out each time, so it is put
 * back at its *old* position, style is flushed, and only then moved — which is
 * what lets the transition run from where it was. While it shows, the list
 * carries `.gliding` and the selected row drops its own highlight (motion.css). */
function glideMark(list, active) {
  if (!list) return;
  let mark = list._glideMark;
  if (!active || !motionOK()) {
    if (mark) mark.remove();
    list.classList.remove('gliding');
    return;
  }
  if (!mark) {
    mark = list._glideMark = document.createElement('li');
    mark.className = 'glide-mark';
    mark.setAttribute('aria-hidden', 'true');
  }
  if (!mark.isConnected) { list.prepend(mark); void mark.offsetWidth; }
  const first = !mark._placed;
  if (first) mark.classList.add('instant');
  mark.style.transform = `translateY(${active.offsetTop}px)`;
  mark.style.height = active.offsetHeight + 'px';
  if (first) { void mark.offsetWidth; mark.classList.remove('instant'); mark._placed = true; }
  list.classList.add('gliding');
}

/* ----------------------------- rolling numbers --------------------------- *
 * A count that changes rolls to its new value like an odometer, one column per
 * digit (only the digits that changed move). `from` says where to roll from;
 * without it, from whatever this element last showed. A first paint, a change in
 * digit count, or anything that isn't a plain number just swaps the text. Once
 * the roll lands the columns collapse back into plain text. */
function rollNumber(el, to, from) {
  if (!el) return;
  const next = String(to);
  const prev = from != null ? String(from) : el._rollAt;
  el._rollAt = next;
  clearTimeout(el._rollT);
  if (!motionOK() || prev == null || prev === next || prev.length !== next.length || !/^\d+$/.test(prev + next)) {
    el.textContent = next;
    return;
  }
  el.textContent = '';
  const digits = '0123456789'.split('').map((d) => `<span>${d}</span>`).join('');
  const cols = [...next].map((d, i) => {
    const box = document.createElement('span');
    box.className = 'roll-d';
    box.innerHTML = `<span class="roll-ph">${d}</span><span class="roll-col" aria-hidden="true">${digits}</span>`;
    const col = box.lastChild;
    col.style.setProperty('--d', prev[i]);
    col.style.transitionDelay = (next.length - 1 - i) * 60 + 'ms';   // the ones lead, tens follow
    el.appendChild(box);
    return col;
  });
  void el.offsetWidth;
  cols.forEach((c, i) => c.style.setProperty('--d', next[i]));
  el._rollT = setTimeout(() => { el.textContent = next; }, 800);
}

/* ---------------------------- message flight ----------------------------- *
 * The message you just sent lifts out of the composer into its place in the
 * transcript, instead of vanishing there and appearing here. A ghost copy of
 * the bubble travels while the real one holds its spot (hidden). The target is
 * re-read every frame, because the feed is gliding down at the same time. */
function flyFromComposer(bubble, from) {
  if (!bubble || !from || !motionOK()) return;
  const r0 = bubble.getBoundingClientRect();
  if (!r0.width) return;
  const ghost = document.createElement('div');
  ghost.className = 'msg user fly-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.width = r0.width + 'px';
  ghost.appendChild(bubble.cloneNode(true));
  document.body.appendChild(ghost);
  bubble.style.visibility = 'hidden';
  const h = ghost.offsetHeight;
  const sx = from.left + (from.width - r0.width) / 2;
  const sy = from.top + (from.height - h) / 2;
  const t0 = performance.now(), dur = 460;
  const step = (now) => {
    if (!bubble.isConnected) { ghost.remove(); return; }   // switched chats mid-flight
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    const r = bubble.getBoundingClientRect();
    ghost.style.transform = `translate(${sx + (r.left - sx) * e}px, ${sy + (r.top - sy) * e}px)`;
    ghost.style.opacity = String(Math.min(1, 0.35 + p * 2.4));
    if (p < 1) { requestAnimationFrame(step); return; }
    ghost.remove();
    bubble.style.visibility = '';
    replayClass(bubble, 'landed-in', 700);
  };
  step(t0);
}

/* ------------------------------ screen morph ----------------------------- *
 * `from` grows into `to` while the rest of the screen crossfades — the project
 * card you clicked becomes the chat. A View Transition: `update` makes the DOM
 * change, and the browser animates between the before and after snapshots.
 * The shared name may sit on only one element per snapshot, so it moves from
 * `from` to `to` inside the update. Returns a promise that settles once the
 * update has run, or false when there is nothing to morph (no support, reduced
 * motion) and the caller should change the screen the plain way. */
function morphInto(from, to, update) {
  if (!from || !to || !motionOK() || typeof document.startViewTransition !== 'function') return false;
  from.style.viewTransitionName = 'k-morph';
  let vt;
  try {
    vt = document.startViewTransition(async () => {
      from.style.viewTransitionName = '';
      to.style.viewTransitionName = 'k-morph';
      await update();
    });
  } catch (_) {
    from.style.viewTransitionName = '';
    return false;
  }
  vt.finished.catch(() => {}).then(() => { to.style.viewTransitionName = ''; from.style.viewTransitionName = ''; });
  return vt.updateCallbackDone;
}
