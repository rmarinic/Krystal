/* feed.js       — the transcript scroll: follow-the-stream, the "new reply
                 below" pill, and the glide to the bottom
   Part of the chat frontend; shares one global scope (see core.js). */

/* Auto-follow the stream ONLY while the user is parked at the bottom.
 *
 * Following is turned OFF by the user's *input* (wheel up, an upward touch drag,
 * grabbing the scrollbar, PageUp/Home) rather than by the scroll event alone —
 * those fire before the scroll is applied, so they beat the stream's next
 * auto-scroll. Deciding from scroll events only used to lose that race: the
 * stream could re-pin the feed to the bottom before the user's (coalesced) scroll
 * event was dispatched, so we sampled the bottom position and stayed locked —
 * the wheel felt dead and only dragging the scrollbar (which keeps overriding
 * scrollTop) could escape.
 *
 * Following is turned back ON as soon as the feed comes to rest at (near) the
 * bottom again — or right away when we jump it to the bottom on purpose (opening
 * a chat, sending). `feedAutoTop` records where our own jumps landed so their
 * echoed scroll event isn't mistaken for the user scrolling away. */
let stickToBottom = true;
function atBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 60;
}
function unfollowFeed() { stickToBottom = false; feedAutoTop = -1; }

els.feed.addEventListener('scroll', () => {
  // Echo of our own scrollFeed(): that jump always means "follow from here", and
  // it must not be measured against the bottom — the feed may have grown since,
  // which would read as "the user scrolled up" and freeze following.
  if (feedAutoTop >= 0 && Math.abs(els.feed.scrollTop - feedAutoTop) <= 1) {
    stickToBottom = true;
    return;
  }
  feedAutoTop = -1;
  stickToBottom = atBottom();
  syncReplyPill();
}, { passive: true });

// Wheel: any upward nudge detaches immediately; scrolling back down re-attaches
// via the scroll listener once the feed actually reaches the bottom.
els.feed.addEventListener('wheel', (e) => { if (e.deltaY < 0) unfollowFeed(); }, { passive: true });

// Touch drag: downward finger movement = scrolling up.
let touchY = 0;
els.feed.addEventListener('touchstart', (e) => {
  touchY = e.touches[0] ? e.touches[0].clientY : 0;
}, { passive: true });
els.feed.addEventListener('touchmove', (e) => {
  const y = e.touches[0] ? e.touches[0].clientY : touchY;
  if (y - touchY > 2) unfollowFeed();
  touchY = y;
}, { passive: true });

// Grabbing the scrollbar: stop fighting the drag for as long as it lasts.
els.feed.addEventListener('mousedown', (e) => {
  if (e.clientX - els.feed.getBoundingClientRect().left > els.feed.clientWidth) unfollowFeed();
});

// Keyboard scrolling of the feed (when it, not the composer, has focus).
els.feed.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') unfollowFeed();
});

function maybeFollow() { if (stickToBottom) glideFeed(); else syncReplyPill(); }

/* ---------------------------- "new reply below" --------------------------- *
 * Scroll up to read while Claude is still writing and the reply carries on out
 * of sight — so a small pill above the composer says so, and a click glides you
 * back down to it (and keeps following). If the reply lands while you're still
 * up there, the pill says that instead and stays until you've been down to see
 * it. At the bottom there is nothing to say, so it isn't there. */
let replyPillEl = null;
let replyPillShown = '';
let replyUnseen = false;   // a reply finished while you were scrolled away from it

function syncReplyPill() {
  if (!replyPillEl) {
    replyPillEl = document.createElement('button');
    replyPillEl.type = 'button';
    replyPillEl.className = 'reply-pill';
    replyPillEl.hidden = true;
    replyPillEl.onclick = () => {
      stickToBottom = true;
      replyUnseen = false;
      glideFeed();
      syncReplyPill();
    };
    els.composer.prepend(replyPillEl);
  }
  let kind = '';
  if (state.activeId && !atBottom()) {
    if (state.live.has(state.activeId) && !stickToBottom) kind = 'writing';
    else if (replyUnseen) kind = 'new';
  } else {
    replyUnseen = false;
  }
  if (kind === replyPillShown) return;
  replyPillShown = kind;
  if (!kind) {   // leaves with a short fade rather than blinking out
    replyPillEl.classList.add('out');
    setTimeout(() => {
      if (replyPillShown) return;
      replyPillEl.hidden = true;
      replyPillEl.classList.remove('out');
    }, motionOK() ? 160 : 0);
    return;
  }
  replyPillEl.classList.remove('out');
  replyPillEl.classList.toggle('live', kind === 'writing');
  replyPillEl.innerHTML = (kind === 'writing' ? '<span class="rp-dot" aria-hidden="true"></span>' : '') +
    `<span>${escapeHtml(tr(kind === 'writing' ? 'replyPill.writing' : 'replyPill.new'))}</span>${icon('arrowDown')}`;
  replyPillEl.title = tr('replyPill.title');
  replyPillEl.hidden = false;
  replayClass(replyPillEl, 'in');
}

/* A different chat is on screen: whatever the last one had below is its own. */
function resetReplyPill() {
  replyUnseen = false;
  syncReplyPill();
}

/* Follow the stream by easing toward the bottom rather than jumping: each frame
 * closes a fifth of the gap, so a paragraph or a chip landing reads as the feed
 * gliding, and steady streaming as a smooth crawl. Each step records where it
 * put the feed (`feedAutoTop`), so its scroll echo counts as following; any user
 * scroll turns `stickToBottom` off and the glide simply stops there. */
let feedGlide = 0;
function glideFeed() {
  if (!motionOK()) { scrollFeed(); return; }
  if (feedGlide) return;
  const step = () => {
    feedGlide = 0;
    if (!stickToBottom) return;
    const f = els.feed;
    const gap = f.scrollHeight - f.clientHeight - f.scrollTop;
    if (Math.abs(gap) <= 1) { scrollFeed(); return; }
    const was = f.scrollTop;
    f.scrollTop = was + Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.2);
    if (f.scrollTop === was) { scrollFeed(); return; }   // pinned by rounding — just land
    feedAutoTop = f.scrollTop;
    feedGlide = requestAnimationFrame(step);
  };
  feedGlide = requestAnimationFrame(step);
}
