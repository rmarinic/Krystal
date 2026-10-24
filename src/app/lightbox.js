/* lightbox.js — click any image thumbnail to see it full-size.
   Part of the chat frontend; shares one global scope (see core.js). */

/* ------------------------------ image lightbox --------------------------- *
 * Any image the app shows as a small thumbnail — a composer attachment pill, a
 * sent message's file-chip, or a tool chip's inline preview — is click-to-view.
 * A single delegated listener opens the loaded thumbnail's pixels full-size in a
 * dim overlay so an attached screenshot is actually readable, not a 40px chip. */
function openLightbox(src, caption) {
  const o = els.lightboxOverlay;
  if (!o || !src) return;
  els.lightboxImg.src = src;
  els.lightboxImg.alt = caption || '';
  els.lightboxCap.textContent = caption || '';
  els.lightboxCap.hidden = !caption;
  o.classList.remove('closing');
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('on'));
}
function closeLightbox() {
  const o = els.lightboxOverlay;
  if (!o || o.hidden) return;
  o.classList.remove('on');
  o.classList.add('closing');
  setTimeout(() => { o.hidden = true; o.classList.remove('closing'); els.lightboxImg.src = ''; }, 190);
}
if (els.lightboxOverlay) {
  els.lightboxClose.onclick = closeLightbox;
  // Click anywhere on the backdrop (but not the image itself) to dismiss.
  els.lightboxOverlay.addEventListener('click', (e) => {
    if (e.target !== els.lightboxImg) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.lightboxOverlay.hidden) closeLightbox();
  });
  // Delegated: a click on any already-loaded thumbnail opens it full-size. The
  // caption prefers the human filename shown on the chip, falling back to alt.
  document.addEventListener('click', (e) => {
    const img = e.target.closest(
      '.file-chip.img img, .chip-img.loaded img, .composer-att.img .att-thumb',
    );
    if (!img || !img.getAttribute('src')) return;
    const holder = img.closest('.file-chip, .composer-att, .chip-img');
    const nameEl = holder && holder.querySelector('.name, .att-name');
    const caption = (nameEl && nameEl.textContent.trim()) || img.alt || '';
    openLightbox(img.src, caption);
  });
}
