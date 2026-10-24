/* hotkeys.js    — keyboard shortcuts + back/forward through the chats you've opened
   Part of the chat frontend; shares one global scope (see core.js). */

/* Every chat you open is noted in one **visit history**, across projects, the way
 * a browser notes pages: Ctrl+Q walks back through it, Ctrl+E forward again, and
 * opening a chat any other way (sidebar, bell, new chat) drops whatever lay
 * ahead. Ctrl+Tab is the quick hop — straight to the chat you were in before
 * this one, and pressing it again comes back, like Alt+Tab between two windows.
 * From the project list or a welcome screen, both land on the chat you left.
 *
 * An entry remembers its project, so a step can cross into another one
 * (`enterProject` first, as the bell does). A chat that has since been deleted —
 * or whose project has — is dropped from the history and the step carries on
 * past it. Kept in localStorage, so after a restart Ctrl+Q still finds the chat
 * you closed the app on. */

const CHAT_HISTORY_KEY = 'krystal.chatHistory';
const CHAT_HISTORY_MAX = 50;

let chatHistory = [];   // [{ id, project }], oldest first
let chatHistoryPos = -1; // the entry on screen (or last on screen)
let chatNavBusy = false; // one step at a time — each one is a few awaits long

try {
  const saved = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY)) || {};
  if (Array.isArray(saved.list)) chatHistory = saved.list.filter((e) => e && e.id);
  chatHistoryPos = Math.min(Number.isInteger(saved.pos) ? saved.pos : chatHistory.length - 1,
    chatHistory.length - 1);
} catch (_) {}

function saveChatHistory() {
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify({ list: chatHistory, pos: chatHistoryPos }));
  } catch (_) {}
}

/* Called by openThread once a chat is really on screen. Re-opening the chat
 * that's already current (a refresh, a language switch, a step we're taking
 * ourselves) changes nothing; anything else is a new visit. */
function noteChatVisit(id) {
  const cur = chatHistory[chatHistoryPos];
  if (cur && cur.id === id) return;
  chatHistory = chatHistory.slice(0, chatHistoryPos + 1);
  chatHistory.push({ id, project: (state.project && state.project.path) || '' });
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MAX);
  chatHistoryPos = chatHistory.length - 1;
  saveChatHistory();
}

/* Open one history entry, entering its project first if it lives elsewhere.
 * Resolves false when the chat (or its project) is gone. */
async function openHistoryEntry(entry) {
  try {
    if (entry.project && (!state.project || state.project.path !== entry.project)) {
      let p = (state.projects || []).find((x) => x.path === entry.project);
      if (!p) {
        const r = await api.projects();
        p = ((r && r.projects) || []).find((x) => x.path === entry.project);
      }
      if (!p) return false;
      await enterProject(p);
    }
    await openThread(entry.id);
    return true;
  } catch (_) {
    return false;
  }
}

/* Step through the history: dir -1 is back, +1 forward. With no chat on screen
 * the first step back is the chat you left, not the one before it. */
async function stepChatHistory(dir) {
  if (chatNavBusy || !chatHistory.length) return;
  chatNavBusy = true;
  try {
    let i = chatHistoryPos + ((dir < 0 && !state.activeId) ? 0 : dir);
    while (i >= 0 && i < chatHistory.length) {
      const prev = chatHistoryPos;
      chatHistoryPos = i;                // set first, so openThread sees it as current
      if (await openHistoryEntry(chatHistory[i])) {
        saveChatHistory();
        replayClass(els.feed, dir < 0 ? 'nav-back' : 'nav-fwd', 300);
        return;
      }
      // Gone: drop it and keep walking the same way from where we were.
      chatHistory.splice(i, 1);
      chatHistoryPos = i <= prev ? prev - 1 : prev;
      if (dir > 0) i = chatHistoryPos + 1; else i -= 1;
    }
    chatHistoryPos = Math.max(-1, Math.min(chatHistoryPos, chatHistory.length - 1));
    saveChatHistory();
  } finally {
    chatNavBusy = false;
  }
}

/* Ctrl+Tab: the chat before this one, opened as a fresh visit — so the next
 * press finds this one behind it and the two toggle. */
async function toggleRecentChat() {
  if (chatNavBusy) return;
  const cur = chatHistory[chatHistoryPos];
  const onScreen = state.activeId && cur && cur.id === state.activeId;
  const target = chatHistory[onScreen ? chatHistoryPos - 1 : chatHistoryPos];
  if (!target) return;
  chatNavBusy = true;
  try {
    // An ordinary open: noteChatVisit records it as a new visit on top.
    if (await openHistoryEntry(target)) {
      replayClass(els.feed, 'nav-back', 300);
    } else {
      // Gone: drop every visit to it, keeping the position on the same entry.
      const gone = (e) => e.id === target.id;
      const before = chatHistory.slice(0, chatHistoryPos + 1).filter(gone).length;
      chatHistory = chatHistory.filter((e) => !gone(e));
      chatHistoryPos = Math.max(-1, chatHistoryPos - before);
      saveChatHistory();
    }
  } finally {
    chatNavBusy = false;
  }
}

/* ------------------------------ the shortcuts ----------------------------- */

/* What the Shortcuts tab in Settings lists, in order — and what each one is.
 * All of them are Ctrl plus a key the left hand reaches without moving off the
 * home row: Q · W · E side by side for back · project list · forward, so they
 * work one-handed and on a 60% keyboard with no arrows. `code` is the physical
 * key, so the same spot works on any layout (QWERTZ included). `keys` are shown
 * as-is; the wording lives in i18n (`keys.*`). */
const SHORTCUTS = [
  { id: 'palette',  code: 'KeyK', keys: ['Ctrl', 'K'] },
  { id: 'find',     code: 'KeyF', keys: ['Ctrl', 'F'] },
  { id: 'back',     code: 'KeyQ', keys: ['Ctrl', 'Q'] },
  { id: 'forward',  code: 'KeyE', keys: ['Ctrl', 'E'] },
  { id: 'recent',   code: 'Tab',  keys: ['Ctrl', 'Tab'] },
  { id: 'projects', code: 'KeyW', keys: ['Ctrl', 'W'] },
  { id: 'newChat',  code: 'KeyN', keys: ['Ctrl', 'N'] },
  { id: 'help',     code: 'KeyS', keys: ['Ctrl', 'S'] },
];

// A dialog, the onboarding or an update in front: shortcuts would act behind it.
function shortcutsBlocked() {
  return !!document.querySelector(
    '.modal-overlay:not([hidden]), .onb-overlay:not([hidden]), ' +
    '.update-overlay:not([hidden]), .proc-overlay:not([hidden]), .palette-overlay:not([hidden])');
}

function runShortcut(id) {
  if (id === 'palette') togglePalette();   // palette.js (it closes itself on a second Ctrl+K)
  else if (id === 'find') openFind();     // find.js (a second Ctrl+F selects what's typed)
  else if (id === 'back') stepChatHistory(-1);
  else if (id === 'forward') stepChatHistory(1);
  else if (id === 'recent') toggleRecentChat();
  else if (id === 'projects') { if (state.project) showProjectPicker(); }
  else if (id === 'newChat') { if (state.project) startNewChat(); }
  else if (id === 'help') openSettings('keys');
}

function shortcutFor(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const s = SHORTCUTS.find((x) => x.code === e.code);
  return s ? s.id : null;
}

document.addEventListener('keydown', (e) => {
  const id = shortcutFor(e);
  if (!id) return;
  // Swallowed either way: left to the webview, Ctrl+S would offer to save the page.
  e.preventDefault();
  if (e.repeat || shortcutsBlocked()) return;
  runShortcut(id);
});

// The mouse's side buttons are back and forward too. Handled on mouseup, but the
// press is swallowed as well so the webview doesn't navigate on its own.
document.addEventListener('mousedown', (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
document.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  if (!shortcutsBlocked()) stepChatHistory(e.button === 3 ? -1 : 1);
});

/* Settings → Shortcuts (a custom tab, see fillSettingsTab in settings.js). */
function renderShortcutsPanel(panel) {
  for (const s of SHORTCUTS) {
    const row = document.createElement('div');
    row.className = 'settings-row keys-row';
    row.innerHTML =
      `<div class="settings-text">` +
        `<div class="settings-name">${escapeHtml(tr('keys.' + s.id + '.name'))}</div>` +
        `<div class="settings-desc">${escapeHtml(tr('keys.' + s.id + '.desc'))}</div>` +
      `</div>` +
      `<span class="keys-combo">${s.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('<i>+</i>')}</span>`;
    panel.appendChild(row);
  }
}
