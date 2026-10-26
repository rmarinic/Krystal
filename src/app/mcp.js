/* mcp.js        — MCP tools in the transcript: a readable name for
   `mcp__<server>__<tool>` ("Cloudflare API · Execute"), what an MCP chip opens
   onto (its arguments, its output as readable JSON with live links), and runs
   of calls to one server folded into a single chip that opens onto them.
   Part of the chat frontend; shares one global scope (see core.js). */

/* --------------------------------- names ---------------------------------- */

// Servers whose names don't come out right by rule.
const MCP_SERVER_NAMES = { github: 'GitHub', gitlab: 'GitLab', krystal: 'Krystal' };

/* `mcp__cloudflare-api__execute` → { key: 'cloudflare-api', server: 'Cloudflare
 * API', tool: 'Execute' }; null for anything else. Krystal's own artifact tool
 * has a card of its own and isn't one (mirrors `is_mcp_tool` in claude/tools.rs). */
function mcpParts(name) {
  if (name === 'mcp__krystal__artifact') return null;
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  if (!m) return null;
  return { key: m[1], server: mcpServerLabel(m[1]), tool: mcpToolLabel(m[2]) };
}

/* A server's name as a person would write it. claude.ai connectors arrive as
 * `claude_ai_Google_Drive`, and many servers end in `_MCP` or `-server`: those
 * parts say nothing. */
function mcpServerLabel(key) {
  const known = MCP_SERVER_NAMES[String(key).toLowerCase()];
  if (known) return known;
  const words = String(key).replace(/^claude_ai_/i, '').split(/[-_\s.]+/)
    .filter((w) => w && !/^(mcp|server)$/i.test(w));
  if (!words.length) return String(key);
  return words.map((w) => (/^api$/i.test(w) ? 'API' : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/* `getJiraIssue` → "Get Jira Issue", `list_pages` → "List pages": the words as
 * written (lower-casing would lose a product's name), the first capitalised. */
function mcpToolLabel(tool) {
  const s = String(tool).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_\s]+/).filter(Boolean).join(' ');
  return s ? s[0].toUpperCase() + s.slice(1) : String(tool);
}

/* A ToolSearch that loaded several tools of one MCP server reads "4 Cloudflare
 * API tools" rather than the first one's name and a count. null otherwise. */
function mcpToolSearchTarget(detail) {
  const m = /^select:(.*)$/.exec(String(detail || ''));
  if (!m) return null;
  const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean).map(mcpParts);
  if (parts.length < 2 || parts.some((p) => !p || p.key !== parts[0].key)) return null;
  return tr('chip.mcpTools', { n: parts.length, server: parts[0].server });
}

/* -------------------------------- details --------------------------------- */

/* What an MCP call was asked: its arguments, one per line. A long or
 * multi-line value (code, a page body) gets a box of its own; a url is a link. */
function renderChipArgs(args) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-args';
  for (const pair of args) {
    if (!Array.isArray(pair)) continue;
    const val = String(pair[1] == null ? '' : pair[1]);
    const row = document.createElement('div');
    row.className = 'chip-arg';
    const key = document.createElement('span');
    key.className = 'chip-arg-key';
    key.textContent = String(pair[0]);
    row.appendChild(key);
    if (val.includes('\n') || val.length > 100) {
      row.classList.add('block');
      const pre = document.createElement('pre');
      pre.className = 'chip-pre';
      pre.textContent = val;
      row.appendChild(pre);
    } else {
      const v = document.createElement('span');
      v.className = 'chip-arg-val';
      if (/^https?:\/\/\S+$/i.test(val)) v.appendChild(chipLink(val, val));
      else v.textContent = val;
      row.appendChild(v);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

/* MCP servers mostly answer in JSON, often on one line: lay it out. Anything
 * that isn't whole JSON (plain text, or JSON the output cap cut short) stays as
 * it came. */
function prettyJson(text) {
  const t = String(text || '').trim();
  if (!/^[[{]/.test(t)) return String(text || '');
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return String(text || ''); }
}

/* Fill `el` with `text`, every http(s) url in it a link (a plain <a>, so
 * links.js routes it by the user's link setting). */
const MCP_URL_RE = /https?:\/\/[^\s"'<>`\\]+/g;
function fillLinked(el, text) {
  el.textContent = '';
  let at = 0;
  for (const m of String(text).matchAll(MCP_URL_RE)) {
    const url = m[0].replace(/[.,;:)\]}]+$/, '');
    el.appendChild(document.createTextNode(text.slice(at, m.index)));
    el.appendChild(chipLink(url, url));
    at = m.index + url.length;
  }
  el.appendChild(document.createTextNode(text.slice(at)));
}

// Copy for an output box, on the line that heads it.
function chipCopyButton(text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-copy';
  b.title = tr('code.copy');
  b.setAttribute('aria-label', tr('code.copy'));
  b.innerHTML = COPY_ICON;
  b.onclick = (e) => { e.stopPropagation(); copyFromButton(b, text, COPY_ICON); };
  return b;
}

/* ------------------------------ folded runs ------------------------------- *
 * Claude talks to one server in bursts — whoami, search, execute, docs — and a
 * chip each is a wall of near-identical lines. Three or more calls in a row to
 * the same server (nothing written between them) fold into one chip: the
 * server, how many calls, which tools. It opens onto the calls themselves, each
 * still its own chip. The fold happens where the run happens: when the third
 * call arrives, the chips slide up under the new head rather than vanish. The
 * head works while any call in it does, and settles (with its check) when the
 * last one returns. */
const MCP_RUN_MIN = 3;

/* `chip` was just added to a bubble (or rebuilt in place): put it in its run. */
function foldMcpRun(chip, animate) {
  const key = chip && chip.dataset && chip.dataset.mcp;
  const parent = chip && chip.parentNode;
  if (!key || !parent) return;
  if (parent.classList && parent.classList.contains('chip-group-body')) {
    syncChipGroup(parent.parentNode, true);
    return;
  }
  const prev = chip.previousElementSibling;
  if (prev && prev.classList.contains('chip-group') && prev.dataset.mcp === key) {
    prev.querySelector('.chip-group-body').appendChild(chip);
    syncChipGroup(prev, true);
    return;
  }
  const run = [chip];
  for (let p = prev; p && p.classList.contains('action-chip') && p.dataset.mcp === key; p = p.previousElementSibling) {
    run.unshift(p);
  }
  if (run.length < MCP_RUN_MIN) return;
  const from = animate && run[0].getBoundingClientRect
    ? run[run.length - 1].getBoundingClientRect().bottom - run[0].getBoundingClientRect().top : 0;
  const group = buildChipGroup(key);
  run[0].before(group);
  const body = group.querySelector('.chip-group-body');
  for (const c of run) body.appendChild(c);
  syncChipGroup(group, true);
  if (animate) foldChipsIn(group, from);
}

function buildChipGroup(key) {
  const group = document.createElement('div');
  group.className = 'chip-group';
  group.dataset.mcp = key;
  const head = document.createElement('div');
  head.className = 'action-chip expandable chip-group-head done';
  const row = document.createElement('div');
  row.className = 'chip-row';
  row.title = tr('chip.groupTitle');
  // The same parts as a chip's row (chips.js), so it reads and settles alike.
  const part = (cls, html, decor) => {
    const s = document.createElement('span');
    s.className = cls;
    if (html) s.innerHTML = html;
    if (decor) s.setAttribute('aria-hidden', 'true');
    row.appendChild(s);
  };
  part('chip-status', CHIP_TICK_SVG, true);
  part('chip-ico', icon('plug'), true);
  part('chip-label');
  part('chip-time');
  part('chip-caret', '▸', true);
  row.onclick = () => toggleChipGroup(group);
  head.appendChild(row);
  const body = document.createElement('div');
  body.className = 'chip-group-body';
  body.hidden = true;
  group.appendChild(head);
  group.appendChild(body);
  return group;
}

function chipGroupChips(group) {
  const body = group.querySelector('.chip-group-body');
  return body ? Array.from(body.children).filter((c) => c.classList.contains('action-chip')) : [];
}

/* The head says what's inside and how it's going. `quiet`: no check drawn (a
 * reload, a fold, a stopped turn). */
function syncChipGroup(group, quiet) {
  const head = group && group.querySelector('.chip-group-head');
  if (!head) return;
  const chips = chipGroupChips(group);
  const working = chips.some((c) => c.classList.contains('working'));
  const was = head.classList.contains('working');
  head.classList.toggle('working', working);
  head.classList.toggle('done', !working);
  head.classList.toggle('error', chips.some((c) => c.classList.contains('error')));
  if (was && !working && !quiet) replayClass(head, 'just-done', 500);
  const tools = [...new Set(chips.map((c) => {
    const p = mcpParts(c._seg && c._seg.name);
    return p && p.tool;
  }).filter(Boolean))];
  head.querySelector('.chip-label').innerHTML =
    `<span class="chip-src">${escapeHtml(mcpServerLabel(group.dataset.mcp))}</span> · ` +
    escapeHtml(tr('chip.mcpCalls', { n: chips.length })) +
    (tools.length ? `<span class="chip-sub"> · ${escapeHtml(tools.join(', '))}</span>` : '');
  paintChipGroupTime(group);
  if (working) startChipClock();
}

// A chip in a run just finished (or failed): its head follows.
function syncChipGroupOf(chip, quiet) {
  const body = chip && chip.parentNode;
  if (body && body.classList && body.classList.contains('chip-group-body')) syncChipGroup(body.parentNode, quiet);
}

/* The run's clock: from the first call's start to the last one's end, read the
 * same way a chip's is (nothing for a quick run). */
function paintChipGroupTime(group) {
  const el = group.querySelector('.chip-group-head .chip-time');
  if (!el) return;
  let start = Infinity, end = 0, live = false;
  for (const c of chipGroupChips(group)) {
    const t = c.dataset.id && chipTimes.get(c.dataset.id);
    if (!t) continue;
    start = Math.min(start, t.start);
    if (t.end == null) live = true; else end = Math.max(end, t.end);
  }
  const label = start === Infinity ? '' : chipTimeLabel({ start, end: live ? null : end }, Date.now());
  if (el.textContent !== label) el.textContent = label;
}

/* Where a chip can be seen: itself, or the head of the closed run it's folded
 * into (so a beat of light lands on something on screen). */
function visibleChip(chip) {
  const group = chip && chip.closest && chip.closest('.chip-group');
  return group && !group.classList.contains('open') ? group.querySelector('.chip-group-head') : chip;
}

/* The run just formed: its chips slide up under the head, out of the space
 * they took (`from` px, head included), instead of vanishing. */
function foldChipsIn(group, from) {
  const body = group.querySelector('.chip-group-body');
  const head = group.querySelector('.chip-group-head');
  const start = Math.max(0, from - head.offsetHeight);
  if (!motionOK() || !body.animate || !start) return;
  slideChipGroup(group, body, [{ height: start + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], 320);
}

function toggleChipGroup(group) {
  const body = group.querySelector('.chip-group-body');
  const open = !group.classList.contains('open');
  group.classList.toggle('open', open);
  if (body._anim) { body._anim.cancel(); body._anim = null; }
  if (!motionOK() || !body.animate) { body.hidden = !open; maybeFollow(); return; }
  body.hidden = false;
  const h = body.scrollHeight;
  slideChipGroup(group, body, open
    ? [{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }]
    : [{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], open ? 240 : 200);
}

// One height + fade slide of a run's body; it ends shown only if the run is open.
function slideChipGroup(group, body, frames, ms) {
  if (body._anim) body._anim.cancel();
  body.hidden = false;
  body.style.overflow = 'hidden';
  const a = body.animate(frames, { duration: ms, easing: 'ease' });
  body._anim = a;
  const settle = () => {
    if (body._anim !== a) return;
    body._anim = null;
    body.style.overflow = '';
    body.hidden = !group.classList.contains('open');
    maybeFollow();
  };
  a.onfinish = settle;
  maybeFollow();
}
