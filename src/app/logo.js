/* logo.js       — RYSTAL wordmark split, logo intro + idle 'living logo' glow
   Part of the chat frontend; shares one global scope (see core.js). */
/* Split each "RYSTAL" wordmark into per-letter spans so the hover glow can
 * ripple across them (staggered animation-delay). Done once at startup. */
function enhanceLogos() {
  document.querySelectorAll('.logo-rest').forEach((el) => {
    if (el.dataset.split) return;
    const text = el.textContent;
    el.textContent = '';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ltr';
      s.textContent = ch;
      s.style.animationDelay = (i * 0.07) + 's';
      el.appendChild(s);
    });
    el.dataset.split = '1';
  });
}

/* The block-art K only tiles into a clean letter in JetBrains Mono; until that
 * (remote) font loads, the box-drawing glyphs fall back to a system monospace
 * with different metrics and the K renders torn — most visible on the very first
 * paint (the project picker). So we keep `.logo-k` hidden via CSS until the mono
 * font is ready, then add `fonts-ready` to fade it in crisp. The timeout means we
 * never hang if the font can't load (e.g. offline). */
function whenFontsReady(cb) {
  const done = () => { document.body.classList.add('fonts-ready'); if (cb) cb(); };
  if (!document.fonts || !document.fonts.load) { done(); return; }
  let settled = false;
  const finish = () => { if (settled) return; settled = true; done(); };
  document.fonts.load('12px "JetBrains Mono"').then(finish, finish);
  setTimeout(finish, 1500);
}

/* Play the logo intro (K pulse + RYSTAL glow wave) once. The `boot` class is
 * stripped afterwards so the hover animations work normally. */
function playLogoIntro(root) {
  (root || document).querySelectorAll('.logo').forEach((logo) => {
    logo.classList.remove('boot');
    void logo.offsetWidth;            // reflow so the animation can restart
    logo.classList.add('boot');
    setTimeout(() => logo.classList.remove('boot'), 3400);
  });
}

/* "Living logo": now and then, on an irregular cadence, replay the glow on the
 * currently-visible logo on its own — a small touch that makes the app feel
 * alive. Gated by the setting; reschedules itself each time. */
let logoLifeTimer = null;
function triggerLogoGlow() {
  if (document.hidden) return;        // don't animate a hidden window
  const sel = state.project ? 'aside.sidebar .logo' : '.project-logo';
  const logo = document.querySelector(sel);
  if (!logo) return;
  logo.classList.remove('boot');
  void logo.offsetWidth;
  logo.classList.add('boot');
  setTimeout(() => logo.classList.remove('boot'), 3400);
}
function scheduleLogoLife() {
  clearTimeout(logoLifeTimer);
  if (!settingOn('logoLife')) return;
  const delay = 22000 + Math.random() * 33000;   // ~22–55s, deliberately irregular
  logoLifeTimer = setTimeout(() => { triggerLogoGlow(); scheduleLogoLife(); }, delay);
}

