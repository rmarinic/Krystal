/* attachments.js — paste & drag-and-drop files onto the composer.
   Part of the chat frontend; shares one global scope (see core.js).

   There is NO upload button by design: you attach by PASTING (Ctrl+V a
   screenshot straight from the clipboard) or DRAG-AND-DROPPING files onto the
   window. Attachments queue as small pills above the input and ride along with
   the next message as `files` — real filesystem paths the backend folds into the
   prompt for Claude to Read (Claude Code reads image files natively).

   Two sources, two shapes:
     • a pasted image is raw bytes → we persist it to the app's attachments
       folder (save_attachment) and keep the returned path;
     • a dropped file already lives on disk → we take its path as-is.
   Both end up as a path in `composerAttachments`, resolved on send. */

const composerAttachments = [];   // { key, name, path, thumb, isImage, ready, failed }
let attachSeq = 0;

/* An attachment belongs to the chat you queued it in, exactly like the composer
   draft: `composerAttachments` is only ever the tray of `attachThread`, and every
   other chat's queue waits in `attachQueues` until you come back to it. Without
   this a pasted screenshot follows you into whatever chat you open next. */
const attachQueues = new Map();   // threadId -> parked attachment records
let attachThread = null;          // the chat the tray currently belongs to

const ATTACH_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
function isImageName(n) { return ATTACH_IMAGE_RE.test(n || ''); }
function extForMime(m) {
  return ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    'image/avif': 'avif', 'image/x-icon': 'ico',
  })[m] || 'png';
}

/* base64 of an ArrayBuffer, chunked so a large screenshot doesn't overflow the
   call stack the way String.fromCharCode(...wholeArray) would. */
function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ------------------------------- per chat -------------------------------- */

/* The queue backing a chat — the live tray for the one that's open. */
function attachmentsFor(id) {
  if (!id || id === attachThread) return composerAttachments;
  return attachQueues.get(id) || [];
}

/* Point the tray at another chat: park what's queued here, restore what was
   queued there. Called on every thread switch (with null on the welcome screen),
   so the tray always shows the open chat's own attachments and nothing else. */
function setAttachmentThread(id) {
  id = id || null;
  if (id === attachThread) return;
  if (attachThread) {
    if (composerAttachments.length) attachQueues.set(attachThread, composerAttachments.slice());
    else attachQueues.delete(attachThread);
  }
  const parked = id ? attachQueues.get(id) : null;
  composerAttachments.length = 0;
  if (parked) composerAttachments.push(...parked);
  attachThread = id;
  renderAttachmentTray();
}

/* ------------------------------- add/remove ------------------------------ */

function addAttachment(att) {
  composerAttachments.push(att);
  renderAttachmentTray();
}

function removeAttachment(key) {
  const i = composerAttachments.findIndex((a) => a.key === key);
  if (i < 0) return;
  const a = composerAttachments[i];
  if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
  composerAttachments.splice(i, 1);
  renderAttachmentTray();
  els.input.focus();
}

/* A pasted image (a Blob straight off the clipboard): show it instantly from a
   local object URL, then persist it to disk in the background for the backend. */
function attachPastedImage(blob, name) {
  const key = ++attachSeq;
  const ext = extForMime(blob.type);
  const fname = name || `screenshot-${key}.${ext}`;
  const objectUrl = URL.createObjectURL(blob);
  const att = { key, name: fname, path: null, thumb: objectUrl, objectUrl, isImage: true, ready: null };
  att.ready = (async () => {
    const buf = await blob.arrayBuffer();
    const r = await api.saveAttachment(fname, bytesToBase64(buf));
    att.path = r && r.path;
    if (!att.path) throw new Error('save failed');
    return att.path;
  })();
  att.ready.catch(() => { att.failed = true; renderAttachmentTray(); });
  addAttachment(att);
}

/* A dropped file already lives on disk — attach its path directly (no re-save).
   Images get a thumbnail read back through the backend. */
function attachDroppedPath(path) {
  if (!path) return;
  if (composerAttachments.some((a) => a.path === path)) return;   // no dupes
  const key = ++attachSeq;
  const name = basename(path);
  const isImage = isImageName(name);
  const att = { key, name, path, thumb: null, isImage, ready: Promise.resolve(path) };
  addAttachment(att);
  if (isImage) {
    api.readImage(path).then((src) => {
      if (src) { att.thumb = src; renderAttachmentTray(); }
    }).catch(() => {});
  }
}

/* -------------------------------- tray ----------------------------------- */

function renderAttachmentTray() {
  const box = els.attachTray;
  if (!box) return;
  if (!composerAttachments.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const a of composerAttachments) {
    const pill = document.createElement('span');
    pill.className = 'composer-att' + (a.isImage ? ' img' : '') + (a.failed ? ' failed' : '');
    if (a.failed) pill.title = tr('attach.failed');
    const media = a.thumb
      ? '<img class="att-thumb" alt="">'
      : `<span class="att-ico" aria-hidden="true">${a.isImage ? '🖼' : '📄'}</span>`;
    pill.innerHTML =
      media +
      '<span class="att-name"></span>' +
      `<button class="att-x" title="${escapeHtml(tr('attach.remove'))}" aria-label="${escapeHtml(tr('attach.remove'))}">×</button>`;
    pill.querySelector('.att-name').textContent = a.name;
    if (a.thumb) pill.querySelector('.att-thumb').src = a.thumb;
    pill.querySelector('.att-x').onclick = () => removeAttachment(a.key);
    box.appendChild(pill);
  }
  box.hidden = false;
}

/* Paths for this turn's `files`, once any in-flight saves have settled. Drops any
   attachment whose save failed (its pill already shows the failure). Snapshotted
   up front: switching chats during the await swaps the tray out from under us. */
async function collectAttachmentPaths(id) {
  const list = attachmentsFor(id === undefined ? attachThread : id).slice();
  if (!list.length) return [];
  await Promise.allSettled(list.map((a) => a.ready));
  return list.filter((a) => a.path).map((a) => a.path);
}

/* Empty a chat's queue — its turn was sent, or the chat itself is gone. Defaults
   to the chat on screen; an explicit id also reaches a parked queue, so a turn
   sent just before you switched away still clears the right one. */
function clearComposerAttachments(id) {
  const list = attachmentsFor(id === undefined ? attachThread : id);
  for (const a of list) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
  if (list === composerAttachments) {
    composerAttachments.length = 0;
    renderAttachmentTray();
  } else {
    attachQueues.delete(id);
  }
}

function hasComposerAttachments() { return composerAttachments.length > 0; }

/* -------------------------------- paste ---------------------------------- */

// Ctrl+V a screenshot (or any clipboard image) → attach it. We only swallow the
// paste when we actually took an image, so pasting text still works normally.
// (You can type the next message while a reply streams in, so you can queue
// attachments for it too — they just wait in the tray until the turn finishes.)
els.input.addEventListener('paste', (e) => {
  if (!state.activeId) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let took = false;
  for (const it of items) {
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) {
        const nm = blob.name && blob.name !== 'image.png' ? blob.name : null;
        attachPastedImage(blob, nm);
        took = true;
      }
    }
  }
  if (took) e.preventDefault();
});

/* ------------------------------ drag & drop ------------------------------ */
/* Tauri intercepts OS file drops itself (the webview's own drop event never sees
   real paths), so we listen to Tauri's drag-drop event, which hands us actual
   filesystem paths. We show a soft full-pane hint while files hover. */

let dropHintOn = false;
let dropHintTimer = null;
function showDropHint() {
  if (dropHintOn || !els.dropHint) return;
  dropHintOn = true;
  clearTimeout(dropHintTimer);
  els.dropHint.hidden = false;
  requestAnimationFrame(() => els.dropHint.classList.add('on'));
}
function hideDropHint() {
  if (!dropHintOn || !els.dropHint) return;
  dropHintOn = false;
  els.dropHint.classList.remove('on');
  dropHintTimer = setTimeout(() => { if (!dropHintOn) els.dropHint.hidden = true; }, 220);
}

const canAttachDrop = () => !!state.activeId && !els.composer.hidden;

// Handle one drag lifecycle step (kind: 'enter' | 'over' | 'leave' | 'drop').
function onDragStep(kind, paths) {
  if (kind === 'enter' || kind === 'over') {
    if (canAttachDrop()) showDropHint();
  } else if (kind === 'leave') {
    hideDropHint();
  } else if (kind === 'drop') {
    hideDropHint();
    if (!canAttachDrop()) return;
    for (const path of (paths || [])) attachDroppedPath(path);
    els.input.focus();
  }
}

function initDragDrop() {
  const T = window.__TAURI__;
  // Preferred: the webview's high-level drag-drop event (gives real OS paths).
  const wv = T && T.webview && T.webview.getCurrentWebview && T.webview.getCurrentWebview();
  if (wv && wv.onDragDropEvent) {
    wv.onDragDropEvent((ev) => {
      const p = (ev && ev.payload) || {};
      onDragStep(p.type, p.paths);
    }).catch(() => {});
    return;
  }
  // Fallback: raw Tauri drag-drop events, if the webview module isn't exposed.
  if (T && T.event && T.event.listen) {
    const map = {
      'tauri://drag-enter': 'enter',
      'tauri://drag-over': 'over',
      'tauri://drag-leave': 'leave',
      'tauri://drag-drop': 'drop',
    };
    for (const [name, kind] of Object.entries(map)) {
      T.event.listen(name, (ev) => onDragStep(kind, ev && ev.payload && ev.payload.paths)).catch(() => {});
    }
  }
}

initDragDrop();
