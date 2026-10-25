/* mirror.js — a turn started from outside this window, painted here live
   Part of the chat frontend; shares one global scope (see core.js).

   Whatever drives this machine from elsewhere (today nothing does; the Krystal
   Cloud relay will) runs its turns through src-tauri/src/remote/, which forwards
   each event to this window. This file replays them so an open chat shows the
   turn as it happens. */

/* --------------------------- mirroring a turn ---------------------------- */
/* Whoever drives this machine from outside and this window are two views of one
 * app, so a turn started over there has to show up here as it happens — not the
 * next time the chat is reopened. The backend forwards the turn's events (see
 * EV_TURN in remote/mod.rs), and we replay them through the SAME live-turn
 * machinery a message typed into this window goes through: build the liveTurn
 * `send()` would have built, then hand every event to `handleLiveEvent`. Nothing downstream — the typewriter,
 * the Activity panel, the sidebar's live mark, the agent inspector — needs to
 * know the turn came from somewhere else. */

function remoteTurnStarted(threadId, text) {
  if (!threadId || state.live.has(threadId)) return;   // already streaming here
  const onScreen = threadId === state.activeId;
  const live = {
    threadId, userText: text || '', userFiles: [],
    events: [], outputs: {},
    // While the chat is on screen its activity list IS the panel's list (same
    // ref, as in `send()`); otherwise the turn collects into its own, which
    // `openThread` adopts if you switch to it mid-turn.
    activity: onScreen ? state.activity : [],
    typer: null, bubble: null, finalText: null, finalized: false,
    startedAt: Date.now(),   // the working line's clock counts from here
    remote: true,
  };
  state.live.set(threadId, live);
  if (typeof liveTurnStarted === 'function') liveTurnStarted(live);
  if (onScreen) {
    stickToBottom = true;             // watch it arrive, as if it were typed here
    appendMessage('user', live.userText, [], null);
    attachLiveTyper(live);
    scrollFeed();
  }
  syncComposer();                      // the send button becomes Stop
  if (state.view === 'threads') renderSidebar();
}

function remoteTurnEvent(threadId, raw) {
  const live = state.live.get(threadId);
  if (!live) return;                   // not a turn we're tracking
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  handleLiveEvent(live, msg);
}

listen('remote-turn-start', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnStarted(p.threadId, p.text);
});
listen('remote-turn', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnEvent(p.threadId, p.raw);
});
// A chat created from outside should appear in the sidebar straight away.
listen('remote-threads-changed', (e) => {
  const p = e && e.payload;
  if (!p || !state.project || p.project !== state.project.path) return;
  if (state.view === 'threads') loadThreads();
});
