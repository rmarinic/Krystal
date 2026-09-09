/* artifacts.js  — the artifact panel: what Claude built, beside the conversation
   Part of the chat frontend; shares one global scope (see core.js).

   An artifact is a finished, self-contained THING — a page, a diagram, a report,
   a small app — rather than an explanation of one. Claude builds them through a
   tool Krystal hands the session itself (there is no such tool in the CLI; a
   host provides it — see src-tauri/src/artifacts.rs), so what arrives here is
   the real document, not a code block scraped out of a reply.

   Two ways in: the card the artifact leaves in the transcript, and the Artifacts
   button in the sidebar foot, which lists everything the project has. Both open
   the same panel. HTML runs inside a sandboxed iframe — no same-origin, so an
   artifact can be a real interactive page without being able to touch Krystal.

   Artifacts belong to the project, like pins: the same ones are there whichever
   conversation you are in. */

/* Summaries for the current project (no content — the list only names them). */
let artifacts = [];
/* The artifact on screen: { artId, version, versions, title, kind, content }. */
let shownArtifact = null;

/* An icon per kind, used in the list and on transcript cards. */
function artifactIcon(kind) {
  if (kind === 'image/svg+xml') return '▨';
  if (kind === 'text/markdown') return '📄';
  if (kind === 'application/vnd.ant.mermaid') return '⌥';
  return '◱';                                   // text/html — a little window
}

/* True for artifacts we show as something other than what we store. Today just
 * mermaid: stored as source, shown (and saved, and opened) as rendered SVG. */
function isMermaid(kind) { return kind === 'application/vnd.ant.mermaid'; }

function artifactKindLabel(kind) {
  return tr('artifacts.kind.' + kind, null, kind);
}

/* ------------------------------ the button ------------------------------- */

function setArtifactBadge(n) {
  const b = els.artifactsCount;
  if (!b) return;
  b.textContent = n > 0 ? String(n) : '';
  b.hidden = n <= 0;
}

function showArtifactsBtn(show) {
  if (!els.artifactsBtn) return;
  els.artifactsBtn.hidden = !show;
  if (show) refreshArtifacts();
  else { artifacts = []; setArtifactBadge(0); }
}

/* Reload this project's artifacts. Called when a project opens, and after
 * anything that changes the list. */
async function refreshArtifacts() {
  const path = state.project && state.project.path;
  if (!path) { artifacts = []; setArtifactBadge(0); return; }
  try {
    const r = await api.listArtifacts(path);
    artifacts = (r && r.artifacts) || [];
  } catch (_) { artifacts = []; }
  setArtifactBadge(artifacts.length);
  if (!els.artifactOverlay.hidden) renderArtifactList();
}

/* --------------------------- live from a turn ---------------------------- */

/* An artifact tool call finished: the backend read the resolved document off
 * disk and sent it here whole. Fold it into the list, refresh any transcript
 * card showing it, and repaint the panel if it's the one on screen — so an
 * artifact being revised updates under you as Claude works. */
function artifactEvent(msg) {
  if (!msg || !msg.artId) return;
  const existing = artifacts.find((a) => a.artId === msg.artId);
  if (existing) {
    existing.title = msg.title;
    existing.kind = msg.kind;
    existing.updatedAt = new Date().toISOString();
  } else {
    artifacts.unshift({
      artId: msg.artId, title: msg.title, kind: msg.kind,
      version: 1, versions: 1, updatedAt: new Date().toISOString(),
    });
    setArtifactBadge(artifacts.length);
    if (els.artifactsBtn) replayClass(els.artifactsBtn, 'just-made', 1400);
  }

  // Any card for this artifact already in the transcript should say the new title.
  document.querySelectorAll(`.artifact-card[data-art="${cssEsc(msg.artId)}"]`)
    .forEach((card) => decorateArtifactCard(card, msg));

  if (!els.artifactOverlay.hidden && shownArtifact && shownArtifact.artId === msg.artId) {
    // Live revisions always show the newest state, never a version you had
    // paused on — the point of watching is watching it change. And no version
    // numbers while the turn is in flight: the version a turn lands
    // on isn't decided until it ends (a turn is one version however many times
    // Claude patches it), so claiming one mid-flight would be a guess.
    shownArtifact = Object.assign({}, shownArtifact, {
      title: msg.title, kind: msg.kind, content: msg.content,
      version: null, versions: null, _svg: null,   // the old rendering is stale
    });
    renderArtifactStage();
    renderArtifactList();
  }
}

/* A turn that touched an artifact has finished, so the database now has the
 * version it settled on. Pick that up — this is what puts the version stepper
 * back after a live revision. */
async function artifactsTurnEnded() {
  await refreshArtifacts();
  if (els.artifactOverlay && !els.artifactOverlay.hidden && shownArtifact) {
    await showArtifact(shownArtifact.artId);
  }
}

/* --------------------------- transcript cards ---------------------------- */

/* The record an artifact leaves in the conversation: a calm card naming what was
 * made, which opens the panel. Built for both the live stream and a reloaded
 * transcript, so they look identical. */
function renderArtifactCard(seg) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.dataset.art = seg.artifact || '';
  card.innerHTML =
    '<span class="artifact-card-ico" aria-hidden="true"></span>' +
    '<span class="artifact-card-text">' +
      '<span class="artifact-card-title"></span>' +
      `<span class="artifact-card-hint">${escapeHtml(tr('artifacts.cardHint'))}</span>` +
    '</span>' +
    '<span class="artifact-card-go" aria-hidden="true">›</span>';
  decorateArtifactCard(card, seg);
  card.onclick = () => openArtifactPanel(seg.artifact);
  return card;
}

/* Fill (or refresh) a card's title and icon from whatever we know about it. */
function decorateArtifactCard(card, info) {
  const known = artifacts.find((a) => a.artId === card.dataset.art);
  const kind = (info && info.kind) || (known && known.kind) || 'text/html';
  const title = (info && (info.title || info.target)) || (known && known.title) || card.dataset.art;
  card.querySelector('.artifact-card-ico').textContent = artifactIcon(kind);
  card.querySelector('.artifact-card-title').textContent = title || tr('artifacts.untitled');
}

/* ------------------------------ mermaid ---------------------------------- */

/* Mermaid is by far the biggest thing the app ships — bigger than the rest of
 * the frontend put together — so it is NOT in index.html. It loads the first
 * time someone actually opens a diagram, and never in a session that has none.
 *
 * Why render at all, rather than store what Claude wrote and show that? Because
 * a `.mmd` file is useless to whoever you send it to. Claude writes mermaid
 * (which lays diagrams out for it, far better than placing SVG shapes by hand),
 * Krystal renders that to SVG, and the SVG is what you look at, save and send —
 * a few KB that opens in any browser with nothing alongside it. */
let mermaidLoading = null;
let mermaidSeq = 0;

function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/mermaid.min.js';
    tag.onload = () => {
      if (!window.mermaid) return reject(new Error('mermaid did not load'));
      // `strict` sanitizes text in labels; the result is shown in the sandboxed
      // iframe regardless, so this is the inner of two locks, not the only one.
      // The light theme is deliberate: the SVG has to look right on white, where
      // it will be opened by everyone who isn't sitting in front of Krystal.
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      resolve(window.mermaid);
    };
    tag.onerror = () => reject(new Error('mermaid did not load'));
    document.head.appendChild(tag);
  });
  return mermaidLoading;
}

/* Mermaid source → SVG markup. Rejects with mermaid's own complaint when the
 * diagram doesn't parse, which is worth showing: it names the line. */
async function renderMermaid(source) {
  const m = await ensureMermaid();
  const { svg } = await m.render('krystal-mermaid-' + (++mermaidSeq), source || '');
  return svg;
}

/* ------------------------------- the panel ------------------------------- */

async function openArtifactPanel(artId, version) {
  if (!state.project) return;
  openOverlay(els.artifactOverlay);
  // Nothing chosen yet (opened from the sidebar): show the list and wait.
  els.artifactStage.innerHTML = '';
  await refreshArtifacts();
  const pick = artId || (artifacts[0] && artifacts[0].artId);
  if (!pick) {
    shownArtifact = null;
    renderArtifactList();
    renderArtifactEmpty();
    return;
  }
  await showArtifact(pick, version);
}

function closeArtifactPanel() {
  closeOverlay(els.artifactOverlay, () => {
    // Drop the iframe on the way out: a running artifact shouldn't keep
    // ticking (timers, animations, audio) behind a closed panel.
    els.artifactStage.innerHTML = '';
    shownArtifact = null;
  });
}

/* Load one artifact (optionally a past version) and paint it. */
async function showArtifact(artId, version) {
  const path = state.project && state.project.path;
  if (!path) return;
  els.artifactStage.innerHTML =
    `<div class="artifact-loading"><div class="spin"></div></div>`;
  let art;
  try {
    art = await api.getArtifact(path, artId, version == null ? null : version);
  } catch (e) {
    shownArtifact = null;
    els.artifactStage.innerHTML =
      `<div class="artifact-msg">${escapeHtml(String((e && e.message) || e))}</div>`;
    return;
  }
  shownArtifact = art;
  renderArtifactList();
  renderArtifactStage();
}

/* The left column: every artifact in the project, newest first. */
function renderArtifactList() {
  const list = els.artifactList;
  if (!list) return;
  if (!artifacts.length) {
    list.innerHTML = `<div class="artifact-list-empty">${escapeHtml(tr('artifacts.noneYet'))}</div>`;
    return;
  }
  list.innerHTML =
    `<div class="artifact-list-head">${escapeHtml(tr('artifacts.listHead'))}</div>` +
    artifacts.map((a) => {
      const on = shownArtifact && shownArtifact.artId === a.artId;
      const versions = a.versions > 1
        ? `<span class="artifact-item-versions">${escapeHtml(tr('artifacts.versionCount', { n: a.versions }))}</span>`
        : '';
      return (
        `<button type="button" class="artifact-item${on ? ' on' : ''}" data-art="${escapeHtml(a.artId)}">` +
          `<span class="artifact-item-ico" aria-hidden="true">${artifactIcon(a.kind)}</span>` +
          `<span class="artifact-item-text">` +
            `<span class="artifact-item-title">${escapeHtml(a.title || a.artId)}</span>` +
            `<span class="artifact-item-meta">${escapeHtml(artifactKindLabel(a.kind))}${versions ? ' · ' : ''}</span>` +
          `</span>${versions}` +
        `</button>`
      );
    }).join('');

  list.querySelectorAll('.artifact-item').forEach((b) => {
    b.onclick = () => showArtifact(b.dataset.art);
  });
}

function renderArtifactEmpty() {
  els.artifactTitle.textContent = tr('artifacts.panelTitle');
  els.artifactSub.textContent = '';
  els.artifactActs.innerHTML = '';
  els.artifactStage.innerHTML =
    `<div class="artifact-msg artifact-empty">` +
      `<div class="artifact-empty-ico" aria-hidden="true">◱</div>` +
      `<h3>${escapeHtml(tr('artifacts.emptyTitle'))}</h3>` +
      `<p>${escapeHtml(tr('artifacts.emptyBody'))}</p>` +
    `</div>`;
}

/* The right side: the artifact itself, plus its header and actions. */
function renderArtifactStage() {
  const art = shownArtifact;
  if (!art) return renderArtifactEmpty();

  els.artifactTitle.textContent = art.title || art.artId;
  const version = art.version || (artifacts.find((a) => a.artId === art.artId) || {}).version || 1;
  const total = art.versions || 1;
  els.artifactSub.textContent = total > 1
    ? `${artifactKindLabel(art.kind)} · ${tr('artifacts.versionOf', { n: version, total })}`
    : artifactKindLabel(art.kind);

  renderArtifactActions(art, version, total);

  const stage = els.artifactStage;
  stage.innerHTML = '';
  const frame = document.createElement('div');
  frame.className = 'artifact-frame';

  if (isMermaid(art.kind)) {
    // Rendering is async (mermaid may still be downloading), so paint the frame
    // now and fill it when the SVG is ready — and only if this is still the
    // artifact on screen, since the user may have moved on meanwhile.
    stage.appendChild(frame);
    const token = art;
    renderMermaid(art.content || '').then((svg) => {
      if (shownArtifact !== token) return;
      token._svg = svg;                       // what Save / Open in browser use
      const iframe = sandboxIframe(art.title);
      iframe.srcdoc = svgPage(svg);
      frame.innerHTML = '';
      frame.appendChild(iframe);
    }).catch((e) => {
      if (shownArtifact !== token) return;
      frame.innerHTML =
        `<div class="artifact-msg">${escapeHtml(tr('artifacts.diagramFailed'))}` +
        `<pre class="artifact-diagram-err">${escapeHtml(String((e && e.message) || e))}</pre></div>`;
    });
    replayClass(frame, 'panel-swap');
    return;
  }

  if (art.kind === 'text/markdown') {
    // Prose stays in the app's own typography rather than an iframe — it's a
    // document to read, not a page to run.
    const doc = document.createElement('div');
    doc.className = 'artifact-doc';
    doc.innerHTML = renderMarkdown(art.content || '');
    decorateCode(doc);
    frame.appendChild(doc);
  } else {
    const iframe = sandboxIframe(art.title);
    iframe.srcdoc = art.kind === 'image/svg+xml' ? svgPage(art.content || '') : (art.content || '');
    frame.appendChild(iframe);
  }
  stage.appendChild(frame);
  replayClass(frame, 'panel-swap');
}

/* The frame an artifact runs in: a sandbox with no same-origin access, so
 * scripts work but the artifact cannot reach Krystal, this window, or anything
 * the app can see. Callers set `srcdoc` as a property, never an attribute, so
 * the content needs no escaping. */
function sandboxIframe(title) {
  const iframe = document.createElement('iframe');
  iframe.className = 'artifact-iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
  iframe.setAttribute('title', title || tr('artifacts.panelTitle'));
  return iframe;
}

/* An SVG is a document, not a page — wrap it so it sits centred and scales to
 * the panel instead of being pinned to the top-left corner at its native size. */
function svgPage(svg) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;height:100%;display:flex;align-items:center;' +
    'justify-content:center;background:#fff}svg{max-width:100%;max-height:100%}</style>' +
    '</head><body>' + svg + '</body></html>'
  );
}

/* Header actions: version stepper, then what you can do with the thing. */
function renderArtifactActions(art, version, total) {
  const acts = els.artifactActs;
  acts.innerHTML = '';

  if (total > 1) {
    const nav = document.createElement('div');
    nav.className = 'artifact-versions';
    const step = (delta) => {
      const next = Math.min(total, Math.max(1, version + delta));
      if (next !== version) showArtifact(art.artId, next);
    };
    const back = document.createElement('button');
    back.className = 'artifact-act';
    back.title = tr('artifacts.older');
    back.textContent = '‹';
    back.disabled = version <= 1;
    back.onclick = () => step(-1);
    const fwd = document.createElement('button');
    fwd.className = 'artifact-act';
    fwd.title = tr('artifacts.newer');
    fwd.textContent = '›';
    fwd.disabled = version >= total;
    fwd.onclick = () => step(1);
    nav.appendChild(back);
    nav.appendChild(fwd);
    acts.appendChild(nav);
  }

  const button = (label, title, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'artifact-act' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.title = title || label;
    b.onclick = fn;
    acts.appendChild(b);
    return b;
  };

  button(tr('artifacts.copy'), tr('artifacts.copyTitle'), async (e) => {
    const ok = await copyText(art.content || '');
    if (!ok) return;
    const b = e.currentTarget;
    const was = b.textContent;
    b.textContent = tr('artifacts.copied');
    b.classList.add('done');
    setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1400);
  });

  button(tr('artifacts.save'), tr('artifacts.saveTitle'), () => saveArtifactAs(art, version));
  button(tr('artifacts.openOut'), tr('artifacts.openOutTitle'), () => openArtifactOutside(art, version));
  button('×', tr('artifacts.delete'), () => deleteShownArtifact(art), 'danger');
}

/* --------------------------------- actions -------------------------------- */

/* What should be written to a file for this artifact. For a diagram that's the
 * rendered SVG — normally already in hand from the panel, but rendered here on
 * the spot if the user is quick enough to hit Save while it's still drawing.
 * Everything else saves exactly what's stored, so this answers null. */
async function renderedFor(art) {
  if (!isMermaid(art.kind)) return null;
  if (art._svg) return art._svg;
  art._svg = await renderMermaid(art.content || '');
  return art._svg;
}

/* Save a copy wherever the user likes. This is the whole "share it" story: an
 * artifact is self-contained by construction, so the saved file opens on any
 * machine, offline, with nothing else alongside it. */
async function saveArtifactAs(art, version) {
  if (remoteBlocks(tr('remote.blocked.saveArtifact'))) return;
  // A diagram is saved as the SVG on screen, not as the mermaid source behind
  // it: the file is for someone who hasn't got a renderer.
  let rendered;
  try {
    rendered = await renderedFor(art);
  } catch (e) {
    return showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('artifacts.saveFailed'),
      body: escapeHtml(tr('artifacts.diagramFailed')) });
  }
  const ext = rendered ? 'svg'
    : ({ 'text/html': 'html', 'image/svg+xml': 'svg', 'text/markdown': 'md' }[art.kind] || 'txt');
  const stem = (art.title || art.artId || 'artifact').replace(/[\\/:*?"<>|]/g, '-').trim();
  let target;
  try {
    target = await dialog.save({
      defaultPath: `${stem}.${ext}`,
      filters: [{ name: artifactKindLabel(art.kind), extensions: [ext] }],
      title: tr('artifacts.saveTitle'),
    });
  } catch (e) {
    return alert(tr('dialog.pickerError', { err: (e && e.message) || e }));
  }
  if (!target) return;                                   // cancelled
  try {
    await api.exportArtifact(state.project.path, art.artId, version, target, rendered);
    showTip({ key: 'status', icon: '💾', label: tr('artifacts.savedLabel'), body: escapeHtml(basename(target)) });
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('artifacts.saveFailed'),
      body: escapeHtml(String((e && e.message) || e)) });
  }
}

/* Open the artifact in the real browser — full screen, its own window, and the
 * same file anyone else would get if you sent it to them. */
async function openArtifactOutside(art, version) {
  if (remoteBlocks(tr('remote.blocked.openArtifact'))) return;
  try {
    const rendered = await renderedFor(art);
    await api.openArtifactExternally(
      state.project.path, art.artId, version, rendered, rendered ? 'svg' : null,
    );
  } catch (e) {
    showTip({ key: 'status', cls: 'high', icon: '⚠️', label: tr('artifacts.openFailed'),
      body: escapeHtml(String((e && e.message) || e)) });
  }
}

async function deleteShownArtifact(art) {
  if (!confirm(tr('artifacts.deleteConfirm', { title: art.title || art.artId }))) return;
  try {
    const r = await api.deleteArtifact(state.project.path, art.artId);
    artifacts = (r && r.artifacts) || [];
  } catch (_) { return; }
  setArtifactBadge(artifacts.length);
  shownArtifact = null;
  renderArtifactList();
  if (artifacts.length) showArtifact(artifacts[0].artId);
  else renderArtifactEmpty();
}

/* --------------------------------- wiring --------------------------------- */

if (els.artifactsBtn) els.artifactsBtn.onclick = () => openArtifactPanel();
if (els.artifactClose) els.artifactClose.onclick = closeArtifactPanel;
if (els.artifactOverlay) {
  els.artifactOverlay.addEventListener('mousedown', (e) => {
    if (e.target === els.artifactOverlay) closeArtifactPanel();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.artifactOverlay && !els.artifactOverlay.hidden) closeArtifactPanel();
});

// Kind labels and the empty state are localized; re-render what's on screen.
window.addEventListener('i18n:changed', () => {
  if (els.artifactOverlay && !els.artifactOverlay.hidden) {
    renderArtifactList();
    if (shownArtifact) renderArtifactStage(); else renderArtifactEmpty();
  }
});
