/* mirror.js — a turn started from outside this window, painted here live
   Part of the chat frontend; shares one global scope (see core.js).

   Whatever drives this machine from elsewhere (the Krystal Cloud relay,
   src-tauri/src/cloud/relay.rs) runs its turns through src-tauri/src/remote/,
   which forwards each event to this window. This file replays them so an open
   chat shows the turn as it happens. */

/* --------------------------- mirroring a turn ---------------------------- */
/* Whoever drives this machine from outside and this window are two views of one
 * app, so a turn started over there has to show up here as it happens — not the
 * next time the chat is reopened. The backend forwards the turn's events (see
 * EV_TURN in remote/mod.rs), and we replay them through the SAME live-turn
 * machinery a message typed into this window goes through: build the liveTurn
 * `send()` would have built, then hand every event to `handleLiveEvent`. Nothing downstream — the typewriter,
 * the Activity panel, the sidebar's live mark, the agent inspector — needs to
 * know the turn came from somewhere else. */

/* The turns being mirrored, by the backend's turn id, from `remote-turn-start`
 * to `remote-turn-end`. Not `state.live`: a turn leaves that at `done`, but its
 * story goes on — the first reply's real title comes after `done`, which a turn
 * typed here still hears through the Channel it holds. The id keeps one turn's
 * late words off the next turn in the same chat. */
const mirroredTurns = new Map();

function remoteTurnStarted(threadId, turn, text) {
  if (!threadId || !turn || state.live.has(threadId)) return;   // already streaming here
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
  mirroredTurns.set(turn, live);
  state.live.set(threadId, live);
  if (typeof liveTurnStarted === 'function') liveTurnStarted(live);
  if (onScreen) {
    // What `startTurn` does for a message typed here, minus the flight from
    // the composer: this one didn't come from it, so the lamp appears in place
    // (`attachLiveTyper` → `lightAnchor`) instead of rising from it.
    if (typeof clearStarters === 'function') clearStarters();   // the first message is here
    hideSuggestion();                  // the next message has been chosen elsewhere
    stickToBottom = true;              // watch it arrive, as if it were typed here
    appendMessage('user', live.userText, [], null);
    mascotTurnBegan();                 // the face hops and looks up after it
    attachLiveTyper(live);
    scrollFeed();
  }
  syncComposer();                      // the send button becomes Stop
  if (state.view === 'threads') renderSidebar();
}

function remoteTurnEvent(turn, raw) {
  const live = mirroredTurns.get(turn);
  if (!live) return;                   // not a turn we're tracking
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  // Once the turn has landed only its late title has anything left to say. The
  // stream's own closing `error`, after the turn's, would land it twice.
  if (live.finalized && msg.type !== 'title') return;
  handleLiveEvent(live, msg);
}

function remoteTurnEnded(turn) {
  const live = mirroredTurns.get(turn);
  if (!live) return;
  mirroredTurns.delete(turn);
  // A turn that ended without a `done` or an `error` still ends here, so no
  // spinner outlives it.
  if (!live.finalized) finishLive(live);
}

listen('remote-turn-start', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnStarted(p.threadId, p.turn, p.text);
});
listen('remote-turn', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnEvent(p.turn, p.raw);
});
listen('remote-turn-end', (e) => {
  const p = e && e.payload;
  if (p) remoteTurnEnded(p.turn);
});
// A chat created from outside should appear in the sidebar straight away.
listen('remote-threads-changed', (e) => {
  const p = e && e.payload;
  if (!p || !state.project || p.project !== state.project.path) return;
  if (state.view === 'threads') loadThreads();
});
