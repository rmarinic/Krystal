/* logo.js       — KRYSTAL wordmark split, logo intro + idle 'living logo' glow
   Part of the chat frontend; shares one global scope (see core.js). The crystal
   face beside the wordmark is app/mascot.js. */
/* Split each "KRYSTAL" wordmark into per-letter spans so the hover glow can
 * ripple across them (staggered animation-delay). Done once at startup. */
function enhanceLogos() {
  document.querySelectorAll('.logo-name').forEach((el) => {
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

/* One glow wave across a logo's wordmark. The `boot` class is stripped
 * afterwards so the hover animation works normally. */
function logoWave(logo) {
  if (!logo) return;
  logo.classList.remove('boot');
  void logo.offsetWidth;            // reflow so the animation can restart
  logo.classList.add('boot');
  setTimeout(() => logo.classList.remove('boot'), 3400);
}

/* Play the logo intro once: the face wakes up (mascot.js) and the wordmark glows. */
function playLogoIntro(root) {
  (root || document).querySelectorAll('.logo').forEach(logoWave);
  mascotGreet();
}

/* "Living logo": now and then, on an irregular cadence, replay the glow on the
 * currently-visible logo on its own — a small touch that makes the app feel
 * alive. Gated by the setting; reschedules itself each time. */
let logoLifeTimer = null;
function triggerLogoGlow() {
  if (document.hidden) return;        // don't animate a hidden window
  const sel = state.project ? 'aside.sidebar .logo' : '.project-logo';
  logoWave(document.querySelector(sel));
}
function scheduleLogoLife() {
  clearTimeout(logoLifeTimer);
  if (!settingOn('logoLife')) return;
  const delay = 22000 + Math.random() * 33000;   // ~22–55s, deliberately irregular
  logoLifeTimer = setTimeout(() => { triggerLogoGlow(); scheduleLogoLife(); }, delay);
}

/* The umbrella "Extra effects" switch (stored under the legacy `logoLife` key)
 * gates every ambient touch — the living logo, the living light behind the chat,
 * the face's movement (and whatever subtle effects we add next). A single body
 * class drives the CSS. */
function applyExtraEffects() {
  document.body.classList.toggle('fx-on', settingOn('logoLife'));
  mascotWake();   // the face settles into (or out of) its still version
}
