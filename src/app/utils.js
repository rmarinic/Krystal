/* utils.js — the small helpers every module shares: escapeHtml, the overlay
   open/close and replay helpers, time/day labels, markdown rendering, copy
   buttons and code-block decoration, shell/agent tool names.
   Part of the chat frontend; shares one global scope (see core.js). */

/* The delegation tool — the one that launches a sub-agent. The CLI has shipped it
 * under more than one name (`Agent` today, `Task` before), and the name is what
 * the tool event carries, so every place that treats a chip as a sub-agent asks
 * here instead of comparing to one string. A name we don't know yet still gets
 * picked up late, once the CLI reports agent progress for it (see agents.js). */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const isAgentTool = (name) => AGENT_TOOLS.has(name);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Close a modal overlay with its exit animation: add `.closing` (CSS plays the
 * fade/scale-out), then hide and run an optional cleanup once it's done. */
function closeOverlay(overlay, after) {
  if (!overlay || overlay.hidden) { if (after) after(); return; }
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('closing');
    if (after) after();
  }, 190);
}
/* Show an overlay, cancelling any in-flight close animation. */
function openOverlay(overlay) {
  overlay.classList.remove('closing');
  overlay.hidden = false;
}

/* Replay a one-shot CSS animation on an element (restart-safe): drop the class,
 * force a reflow, re-add it. Used for tab/status crossfades and small pulses. */
function replayClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (ms) setTimeout(() => el.classList.remove(cls), ms);
}

/* Fold case and diacritics so typing without them still matches — the command
 * palette and Find in chat both compare through this (đ has no
 * decomposition, so it is mapped by hand). */
function foldText(s) {
  return String(s).toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function basename(p) { return p.split(/[\\/]/).pop(); }
function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/* Whole calendar days between a timestamp and today — 0 today, 1 yesterday.
 * Counted by date, not elapsed hours, so 23:50 last night reads as yesterday
 * rather than "0 days ago". Returns null for a missing/unparsable stamp. */
function dayDiff(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((midnight(new Date()) - midnight(d)) / 86400000);
}
/* A friendly day marker: “Today” / “Yesterday” / “3 days ago”, and a short date
 * once a week has passed (with the year on anything older than this one). */
function dayLabel(iso) {
  const days = dayDiff(iso);
  if (days === null) return '';
  if (days <= 0) return tr('time.today');
  if (days === 1) return tr('time.yesterday');
  if (days < 7) return tr('time.daysAgo', { n: days });
  const d = new Date(iso);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(window.I18N ? window.I18N.getLang() : [], opts);
}
/* The chat row's time line: “Today · 14:23”. The clock rides along only while
 * it still says something — past a couple of days the date alone is the story. */
function stampLabel(iso) {
  const days = dayDiff(iso);
  if (days === null) return '';
  const day = dayLabel(iso);
  return days <= 1 ? `${day} · ${timeLabel(iso)}` : day;
}
function renderMarkdown(md) {
  const html = window.marked ? marked.parse(md || '') : (md || '');
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
/* Jump the feed to the bottom. Remembers the landing position so the scroll
 * event it echoes can be told apart from a real user scroll (see feed.js). */
let feedAutoTop = -1;
function scrollFeed() {
  els.feed.scrollTop = els.feed.scrollHeight;
  feedAutoTop = els.feed.scrollTop;
}

/* ----------------------------- code blocks ------------------------------- */

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

/* Copy text to the clipboard, with a fallback for the rare no-clipboard case. */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* Add a hover "copy" button to a <pre> code block (idempotent — once per block). */
function addCopyButton(pre) {
  if (!pre || pre.querySelector('.code-copy')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.title = tr('code.copy');
  btn.setAttribute('aria-label', tr('code.copy'));
  btn.innerHTML = COPY_ICON;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const code = pre.querySelector('code');
    copyFromButton(btn, (code || pre).textContent || '', COPY_ICON);
  });
  pre.appendChild(btn);
}

/* Copy `text` and let the button that asked answer: its icon turns into a check
 * for a moment, then goes back to `idle` (the icon it rests with). Every copy
 * button in the app lands the same way — code blocks, messages, tasks. */
async function copyFromButton(btn, text, idle) {
  if (!(await copyText(text))) return false;
  btn.classList.add('copied');
  btn.innerHTML = CHECK_ICON;
  clearTimeout(btn._copiedTimer);     // a second click restarts the moment, not stacks it
  btn._copiedTimer = setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = idle; }, 1400);
  return true;
}

/* Highlight every fenced code block in `scope` and give each a copy button.
   The single place all rendered assistant markdown passes through (live stream
   + reload), so highlighting and the copy affordance stay consistent. */
function decorateCode(scope) {
  scope.querySelectorAll('pre code').forEach((code) => {
    if (window.hljs) hljs.highlightElement(code);
    addCopyButton(code.parentElement);
  });
}

/* True for paths that point at an image we can preview inline. */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
function isImagePath(p) { return !!p && IMG_EXT_RE.test(p.trim()); }

/* The tools that run a shell command. On Windows Claude reaches for PowerShell
 * as often as Bash, so anywhere the UI means "a shell" it means both. */
function isShellTool(name) { return name === 'Bash' || name === 'PowerShell'; }
// The prompt a shown command line is written after: `$ ls` / `PS> Get-ChildItem`.
function shellPrompt(name) { return name === 'PowerShell' ? 'PS> ' : name === 'Bash' ? '$ ' : ''; }
