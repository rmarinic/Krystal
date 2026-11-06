/* narrow.js — the sidebar as a drawer, on a phone or in a narrow window
   (css/narrow.css says when; there the sidebar sits off-screen to the left).
   The ☰ button in the chat header opens it; the scrim, Esc, or picking where
   to go in it (a chat, new chat, another project, a place in its foot) closes
   it, so the drawer never stays over what you just chose. Typing in its search
   or flipping Saved keeps it open. Outside the narrow layout the class does
   nothing, and a window grown wide drops it.
   Part of the chat frontend; shares one global scope (see core.js). */

/** Whether a click on `target` inside the drawer is a choice of where to go. */
function drawerClosesOn(target) {
  if (!target || !target.closest) return false;
  if (target.closest('#saved-toggle, #search')) return false;
  return !!target.closest('a, button, li[data-tid]');
}

function drawerOpen(open) {
  document.body.classList.toggle('drawer-open', !!open);
  if (els.drawerBtn) els.drawerBtn.setAttribute('aria-expanded', String(!!open));
}

const drawerIsOpen = () => document.body.classList.contains('drawer-open');

if (els.drawerBtn) els.drawerBtn.addEventListener('click', () => drawerOpen(!drawerIsOpen()));
if (els.drawerScrim) els.drawerScrim.addEventListener('click', () => drawerOpen(false));
if (els.sidebar) {
  // After the click has done its work (opened the chat), so nothing it reads
  // has moved yet.
  els.sidebar.addEventListener('click', (e) => { if (drawerIsOpen() && drawerClosesOn(e.target)) setTimeout(() => drawerOpen(false), 0); });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerIsOpen()) drawerOpen(false); });
window.addEventListener('resize', () => {
  if (drawerIsOpen() && window.innerWidth > 1100) drawerOpen(false);
});
