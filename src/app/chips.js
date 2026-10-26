/* chips.js      — action chips: building one, its clock, expanding it, and the
 * details it opens onto (files, links, diffs, output). Moved out of messages.js;
 * part of the chat frontend; shares one global scope (see core.js). */

const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

/* The check a chip's status settles into once its action is done. It lives in
 * the markup from the start (hidden while working) so a live chip can draw it
 * the moment it finishes. Shared with the agent chip (agents.js). */
const CHIP_TICK_SVG =
  '<svg class="chip-tick" viewBox="0 0 12 12"><path d="M2.6 6.4l2.2 2.2 4.6-4.9"/></svg>';

/* ------------------------------ how long it took --------------------------- *
 * An action that takes a while shows how long it has been going. We count it
 * here because the CLI says nothing while a command runs — its output only
 * arrives once it's over — and a spinner alone can't tell "busy" from "stuck".
 * It answers real time on real work: the number appears only once an action has
 * run CHIP_TIME_AFTER_MS (a quick read never flashes one), and the moment no
 * chip is working the ticker stops. The last reading stays, so a slow step still
 * reads as slow afterwards. Times are kept by tool_use id, outside the DOM, so a
 * chip rebuilt by a re-render or a thread switch carries on counting. */
const CHIP_TIME_AFTER_MS = 3000;
const CHIP_TIMES_MAX = 500;
const chipTimes = new Map();    // tool_use id -> { start, end }
let chipClock = null;

function chipTime(id) {
  let t = chipTimes.get(id);
  if (!t) {
    t = { start: Date.now(), end: null };
    chipTimes.set(id, t);
    if (chipTimes.size > CHIP_TIMES_MAX) chipTimes.delete(chipTimes.keys().next().value);
  }
  return t;
}

// What the chip's clock reads: nothing for a quick action, else e.g. "12s".
function chipTimeLabel(t, now) {
  if (!t || t.start == null) return '';
  const ms = (t.end || now) - t.start;
  return ms >= CHIP_TIME_AFTER_MS ? fmtDur(ms) : '';
}

function paintChipTime(chip) {
  const el = chip && chip.querySelector('.chip-time');
  if (!el) return;
  const label = chipTimeLabel(chip.dataset.id && chipTimes.get(chip.dataset.id), Date.now());
  if (el.textContent !== label) el.textContent = label;
}

function tickChipClock() {
  const running = document.querySelectorAll('.action-chip.working[data-id]');
  running.forEach(paintChipTime);
  document.querySelectorAll('.chip-group-head.working').forEach((h) => paintChipGroupTime(h.parentNode));
  if (!running.length) { clearInterval(chipClock); chipClock = null; }
}
function startChipClock() { if (!chipClock) chipClock = setInterval(tickChipClock, 1000); }

// The action is over: its clock stops where it is.
function stopChipTime(chip) {
  const t = chip && chip.dataset.id && chipTimes.get(chip.dataset.id);
  if (t && !t.end) t.end = Date.now();
  paintChipTime(chip);
}

/* Build one "action chip" — the persisted, on-its-own-line record of a tool
 * action. `working` shows a live spinner + glow; otherwise a settled check.
 * The chip is expandable: clicking it reveals what the tool did — a diff for
 * edits, the written content, or the tool's output. Shared by the live stream
 * and the reload path so they look (and expand) identically. */
function renderActionChip(seg, working) {
  const name = seg.name || '';
  // A sub-agent is a whole run, not a blob of output: its chip opens the agent
  // inspector instead of expanding inline (see agents.js).
  if (isAgentTool(name) && seg.id) return renderAgentChip(seg, working);
  // A shell step says what it's for, in words, even when Claude didn't (describe.js).
  const target = isShellTool(name) ? shellStepLabel(seg)
    : ((name === 'ToolSearch' && mcpToolSearchTarget(seg.detail)) || seg.target || '');
  // An MCP call names its server (dimmed) before what it did (mcp.js).
  const mcp = mcpParts(name);
  const labelHtml = mcp
    ? `<span class="chip-src">${escapeHtml(mcp.server)}</span> · ${escapeHtml(mcp.tool + (target ? ' · ' + target : ''))}`
    : escapeHtml(toolLabel(name) + (target ? ' · ' + target : ''));
  const el = document.createElement('div');
  el.className = 'action-chip expandable ' + (working ? 'working' : 'done') + (seg.isError ? ' error' : '');
  if (seg.id) el.dataset.id = seg.id;
  if (mcp) el.dataset.mcp = mcp.key;
  el._seg = seg;                 // kept so a late tool_result can refill details

  const row = document.createElement('div');
  row.className = 'chip-row';
  row.title = tr('chip.expandTitle');
  row.innerHTML =
    `<span class="chip-status" aria-hidden="true">${CHIP_TICK_SVG}</span>` +
    `<span class="chip-ico" aria-hidden="true">${toolIcon(name)}</span>` +
    `<span class="chip-label">${labelHtml}</span>` +
    '<span class="chip-time"></span>' +
    '<span class="chip-caret" aria-hidden="true">▸</span>';
  el.appendChild(row);
  if (working && seg.id) { chipTime(seg.id); paintChipTime(el); startChipClock(); }
  else if (seg.id && chipTimes.has(seg.id)) paintChipTime(el);

  const details = document.createElement('div');
  details.className = 'chip-details';
  details.hidden = true;                 // collapsed = removed from layout (clean small pill)
  fillChipDetails(details, seg);
  el.appendChild(details);

  row.onclick = () => toggleChip(el);
  return el;
}

/* Run `cb` once the element's max-height transition ends, with a timeout fallback
 * for the cases where no transition fires (empty panel, reduced motion). */
function onTransitionEndOnce(el, cb) {
  let done = false;
  const finish = () => { if (done) return; done = true; el.removeEventListener('transitionend', onEnd); cb(); };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'max-height') finish(); };
  el.addEventListener('transitionend', onEnd);
  setTimeout(finish, 320);
}

/* Expand / collapse a chip's details with a subtle height + fade slide. Closed,
 * the panel is `hidden` (display:none); we bring it into layout only to animate
 * max-height 0 ↔ its content height, then either let it grow freely (open) or
 * hide it again (closed). */
function toggleChip(el) {
  const details = el.querySelector('.chip-details');
  if (!details) return;
  const open = !el.classList.contains('open');
  if (open) {
    el.classList.add('open');
    loadChipImages(el);                              // fetch any image previews now
    details.hidden = false;
    details.style.maxHeight = '0px';
    void details.offsetHeight;                       // reflow so the next change animates
    details.style.maxHeight = details.scrollHeight + 'px';
    maybeFollow();
    onTransitionEndOnce(details, () => { details.style.maxHeight = 'none'; maybeFollow(); });
  } else {
    details.style.maxHeight = details.scrollHeight + 'px';
    void details.offsetHeight;
    el.classList.remove('open');
    details.style.maxHeight = '0px';
    onTransitionEndOnce(details, () => { details.hidden = true; details.style.maxHeight = ''; });
  }
}

// Tools whose `detail` is a file path — the ones whose target can be an image.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/* An inline image preview for a chip that touched an image file. The actual
 * pixels load lazily (on first expand, via `loadChipImages`) so reading an image
 * doesn't fetch it until the user opens the chip. */
function buildImagePreview(path) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-img';
  wrap.dataset.imgPath = path;                 // cleared once loaded
  const img = document.createElement('img');
  img.alt = basename(path);
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/* Load any not-yet-fetched image previews inside a chip (called on first open).
 * Reads the file through the backend as a data URL — no asset-scope config. */
function loadChipImages(chip) {
  chip.querySelectorAll('.chip-img[data-img-path]').forEach((wrap) => {
    const path = wrap.dataset.imgPath;
    delete wrap.dataset.imgPath;               // load once
    const img = wrap.querySelector('img');
    api.readImage(path).then((src) => {
      if (src) {
        img.onload = () => maybeFollow();
        img.src = src;
        wrap.classList.add('loaded');
      } else {
        wrap.classList.add('failed');
        wrap.textContent = tr('chip.imgFailed');
      }
    }).catch(() => {
      wrap.classList.add('failed');
      wrap.textContent = tr('chip.imgFailed');
    });
  });
}

/* How the chip's Open button treats a file. Opening hands a file to its default
 * program, which for a script or a binary means running it — so scripts open in
 * Notepad and binaries get no Open at all. This only picks the label; the
 * backend's `open_kind` (commands/system.rs) holds the same rule and is what enforces it. */
const OPEN_AS_TEXT_RE = /\.(ps1|psm1|psd1|bat|cmd|js|jse|vbs|vbe|wsf|wsh|py|pyw|sh|reg|hta)$/i;
const OPEN_NEVER_RE = /\.(exe|com|scr|pif|msi|msp|msix|appx|dll|sys|ocx|cpl|lnk|url|jar|msc|application|appref-ms|gadget|settingcontent-ms)$/i;
function chipOpenKind(path) {
  const p = String(path || '').trim();
  if (OPEN_AS_TEXT_RE.test(p)) return 'text';
  if (OPEN_NEVER_RE.test(p)) return 'never';
  return 'default';
}

/* The pages a web search came back with. Its output carries them as
 * `Links: [{"title":…,"url":…}, …]` — possibly more than once, and possibly cut
 * off by the output cap — so each pair is matched on its own rather than the
 * array parsed whole. Only http(s) links, each once. */
function webSearchLinks(output) {
  const re = /\{"title":"((?:[^"\\]|\\.)*)","url":"((?:[^"\\]|\\.)*)"\}/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(String(output || '')))) {
    let title, url;
    try { title = JSON.parse(`"${m[1]}"`); url = JSON.parse(`"${m[2]}"`); } catch { continue; }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title || url, url });
  }
  return out;
}

/* A file the chip's tool touched: its path, then Show in folder and Open, so
 * the user can go and look at it themselves. */
function chipFileLine(path) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-file';
  const d = document.createElement('div');
  d.className = 'chip-detail-line';
  d.textContent = path;
  wrap.appendChild(d);
  const acts = document.createElement('div');
  acts.className = 'chip-acts';
  const btn = (iconName, label, title, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-act';
    b.innerHTML = `${icon(iconName)}<span>${escapeHtml(label)}</span>`;
    if (title) b.title = title;
    b.onclick = (e) => { e.stopPropagation(); run(); };
    acts.appendChild(b);
  };
  btn('folder', tr('chip.reveal'), '', () => chipReveal(path));
  const kind = chipOpenKind(path);
  if (kind === 'text') btn('file', tr('chip.openText'), tr('chip.openTextTitle'), () => chipOpen(path));
  else if (kind === 'default') btn('file', tr('chip.open'), '', () => chipOpen(path));
  wrap.appendChild(acts);
  return wrap;
}

function chipOpenFailed(e) {
  showTip({ key: 'status', cls: 'high', icon: 'alert', label: tr('chip.openFail'),
    body: escapeHtml(String((e && e.message) || e)) });
}
// The file has been moved or deleted since Claude touched it.
function chipFileGone(bodyKey) {
  showTip({ key: 'status', icon: 'folder', label: tr('chip.fileGoneLabel'), body: escapeHtml(tr(bodyKey)) });
}
function chipReveal(path) {
  api.revealPath(path).then((r) => { if (r && r.gone) chipFileGone('chip.fileGoneFolder'); })
    .catch(chipOpenFailed);
}
function chipOpen(path) {
  api.openPath(path).then((r) => { if (r && r.gone) chipFileGone('chip.fileGone'); })
    .catch(chipOpenFailed);
}

/* A link out of a chip. A plain <a href>, so links.js routes it by the user's
 * link setting (ask / browser / in-app) like any link in a reply. */
function chipLink(url, text) {
  const a = document.createElement('a');
  a.className = 'chip-link';
  a.href = url;
  a.textContent = text;
  a.title = url;
  return a;
}

/* Populate a chip's details from its segment: the full target/command, a diff
 * for edits, the written content, then the tool's captured output. A file the
 * tool touched gets Show in folder / Open; a page it fetched, or the results it
 * searched up, are links. */
function fillChipDetails(details, seg) {
  details.innerHTML = '';
  let any = false;
  // An MCP call: what it was asked, and what came back laid out (mcp.js). When
  // it failed, the error comes first — that's what you opened it for.
  const mcp = !!mcpParts(seg.name);
  const errFirst = mcp && seg.isError && seg.output != null;
  if (errFirst) appendChipOutput(details, seg, mcp);
  if (Array.isArray(seg.args) && seg.args.length) {
    details.appendChild(renderChipArgs(seg.args));
    any = true;
  }
  if (seg.detail && FILE_TOOLS.has(seg.name)) {
    details.appendChild(chipFileLine(seg.detail));
    any = true;
  } else if (seg.detail && seg.name === 'WebFetch' && /^https?:\/\//i.test(seg.detail)) {
    const d = document.createElement('div');
    d.className = 'chip-detail-line';
    d.appendChild(chipLink(seg.detail, seg.detail));
    details.appendChild(d);
    any = true;
  } else if (seg.detail) {
    const d = document.createElement('div');
    d.className = 'chip-detail-line';
    d.textContent = shellPrompt(seg.name) + seg.detail;
    details.appendChild(d);
    any = true;
  }
  const found = seg.name === 'WebSearch' ? webSearchLinks(seg.output) : [];
  if (found.length) {
    const head = document.createElement('div');
    head.className = 'chip-out-head';
    head.textContent = tr('chip.results');
    details.appendChild(head);
    const list = document.createElement('ol');
    list.className = 'chip-links';
    for (const l of found) {
      const li = document.createElement('li');
      li.appendChild(chipLink(l.url, l.title));
      const host = document.createElement('span');
      host.className = 'chip-link-host';
      host.textContent = l.url.replace(/^https?:\/\//i, '').split('/')[0];
      li.appendChild(host);
      list.appendChild(li);
    }
    details.appendChild(list);
  }
  // If this action touched an image file, preview it inline.
  if (FILE_TOOLS.has(seg.name) && isImagePath(seg.detail)) {
    details.appendChild(buildImagePreview(seg.detail));
    any = true;
  }
  if (Array.isArray(seg.edits) && seg.edits.length) {
    details.appendChild(renderDiff(seg.edits));
    any = true;
  }
  if (seg.content != null) {
    const pre = document.createElement('pre');
    pre.className = 'chip-pre';
    pre.textContent = seg.content;
    details.appendChild(pre);
    any = true;
  }
  if (seg.output != null) {
    if (!errFirst) appendChipOutput(details, seg, mcp);
    any = true;
  } else if (!seg.edits && seg.content == null) {
    const p = document.createElement('div');
    p.className = 'chip-pending';
    p.textContent = tr('chip.pending');
    details.appendChild(p);
    any = true;
  }
  if (!any) {
    const p = document.createElement('div');
    p.className = 'chip-pending';
    p.textContent = tr('chip.noOutput');
    details.appendChild(p);
  }
}

/* What the tool gave back, under its heading. `rich` (an MCP call): JSON laid
 * out, urls as links, and a Copy for the whole of it. */
function appendChipOutput(details, seg, rich) {
  const head = document.createElement('div');
  head.className = 'chip-out-head';
  head.textContent = tr('chip.outputLabel');
  details.appendChild(head);
  const pre = document.createElement('pre');
  pre.className = 'chip-pre out' + (seg.isError ? ' err' : '');
  if (rich && seg.output) {
    const text = prettyJson(seg.output);
    fillLinked(pre, text);
    head.appendChild(chipCopyButton(text));
  } else {
    pre.textContent = seg.output || tr('chip.noOutput');
  }
  details.appendChild(pre);
}

/* A simple before/after diff: removed lines (red) then added lines (green). */
function renderDiff(edits) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-diff';
  for (const e of edits) {
    if (e.old) for (const ln of String(e.old).split('\n')) {
      const d = document.createElement('div');
      d.className = 'diff-line del';
      d.textContent = '- ' + ln;
      wrap.appendChild(d);
    }
    if (e.new) for (const ln of String(e.new).split('\n')) {
      const d = document.createElement('div');
      d.className = 'diff-line add';
      d.textContent = '+ ' + ln;
      wrap.appendChild(d);
    }
  }
  return wrap;
}

/* A tool's output arrived (tool_result) — fold it into the matching chip and
 * refresh its details, keeping whatever expand state the user set. */
function setChipOutput(chip, output, isError) {
  const seg = chip._seg || (chip._seg = {});
  seg.output = output != null ? output : '';
  if (isError) { seg.isError = true; chip.classList.add('error'); }
  const details = chip.querySelector('.chip-details');
  if (details) fillChipDetails(details, seg);
}
