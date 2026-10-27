/* core.js — shared foundation for the chat frontend (Tauri build).
 *
 * The frontend is plain classic scripts (no bundler, no modules). It was one big
 * app.js; it's now split into cohesive files under src/app/ that load in order
 * via <script defer> and SHARE ONE GLOBAL SCOPE — a `const`/`let`/`function`
 * declared in an earlier file is visible to every later file, exactly as if the
 * files were concatenated back into a single app.js. So load order matters and
 * mirrors the original top-to-bottom order; boot.js (the entry point) loads last.
 *
 * Load order (see index.html; tests/boot.test.js loads them all in this order):
 *   core → api → utils → lightbox → icons → motion → light → mascot → titlebar → sidebar → chat → projects → starters → controls →
 *   describe → activity → agents → search → messages → chips → mcp → review → artifacts → livemd →
 *   composer → feed → working → typer → stream → permissions → mentions → skills → attachments → queue →
 *   wizard → localization → settings → header → tasks → git → run → links → logo → usage →
 *   orchestrator → pins → mirror → account → guests → notifications → palette → find → hotkeys → boot
 *
 * This file owns the bits everything else builds on: the Tauri IPC handles
 * (`invoke`, `Channel`, `listen`), the `$` query helper, `tr` (i18n
 * lookup), the `els` element map, `state` and the context-window constants. The
 * `api` wrapper is in api.js, the small shared helpers (basename, escapeHtml,
 * the overlay/replay animation helpers, …) in utils.js, the image lightbox in
 * lightbox.js — loaded right after this file, in that order.
 *
 * Talks to the Rust backend over Tauri IPC instead of HTTP:
 *   invoke('command', args)         ← was fetch('/api/…')
 *   Channel + invoke('chat', …)     ← was the SSE stream
 *   dialog.open({directory:true})   ← was the native PowerShell picker
 * The UI, rendering and behaviour are otherwise identical to the web version.
 */

const { invoke, Channel } = window.__TAURI__.core;
// Backend-pushed events (as opposed to a reply to something we invoked). Used by
// mirror.js to replay a turn started from outside, and by account.js to hear a
// link land.
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;

const $ = (sel) => document.querySelector(sel);

/* Localized string lookup. Named `tr` (not `t`) because `t` is used widely as a
 * local variable across this file (threads, tokens, timestamps). */
const tr = (key, vars, fallback) => window.I18N.t(key, vars, fallback);

const els = {
  threadList: $('#thread-list'),
  newChat: $('#new-chat'),
  title: $('#chat-title'),
  // The path text only — `#chat-cwd` itself is the button that opens the
  // project-folders panel, so writing the path must not wipe its children.
  cwd: $('#chat-cwd-path'),
  cwdBtn: $('#chat-cwd'),
  cwdExtra: $('#chat-cwd-extra'),
  feed: $('#feed'),
  empty: $('#empty-state'),
  composer: $('#composer'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  queueBtn: $('#queue-btn'),
  composerQueue: $('#composer-queue'),
  composerRefs: $('#composer-refs'),
  attachTray: $('#composer-attachments'),
  dropHint: $('#drop-hint'),
  mentionPop: $('#mention-pop'),
  skillPop: $('#skill-pop'),
  chatTools: $('#chat-tools'),
  modelPicker: $('#model-picker'),
  modePicker: $('#mode-picker'),
  effortPicker: $('#effort-picker'),
  composerSuggest: $('#composer-suggest'),
  composerPerm: $('#composer-perm'),
  branchBtn: $('#branch-btn'),
  compactBtn: $('#compact-btn'),
  clearBtn: $('#clear-btn'),
  orchWrap: $('#orch-wrap'),
  orchBtn: $('#orch-btn'),
  orchPop: $('#orch-pop'),
  meterRow: $('#meter-row'),
  meterFill: $('#meter-fill'),
  meterLabel: $('#meter-label'),
  tips: $('#tips'),
  toasts: $('#toasts'),
  notifPop: $('#notif-pop'),
  activityBtn: $('#activity-btn'),
  activityOverlay: $('#activity-overlay'),
  activityBody: $('#activity-body'),
  activityClose: $('#activity-close'),
  activityFilters: $('#activity-filters'),
  agentOverlay: $('#agent-overlay'),
  agentTitle: $('#agent-title'),
  agentSub: $('#agent-sub'),
  agentStatus: $('#agent-status'),
  agentStats: $('#agent-stats'),
  agentBody: $('#agent-body'),
  agentHint: $('#agent-hint'),
  agentStop: $('#agent-stop'),
  agentDone: $('#agent-done'),
  agentClose: $('#agent-close'),
  ciOverlay: $('#ci-overlay'),
  ciTitle: $('#ci-title'),
  ciSub: $('#ci-sub'),
  ciStatus: $('#ci-status'),
  ciBody: $('#ci-body'),
  ciHint: $('#ci-hint'),
  ciFix: $('#ci-fix'),
  ciWeb: $('#ci-web'),
  ciDone: $('#ci-done'),
  ciClose: $('#ci-close'),
  reviewOverlay: $('#review-overlay'),
  reviewSub: $('#review-sub'),
  reviewBody: $('#review-body'),
  reviewHint: $('#review-hint'),
  reviewUndo: $('#review-undo'),
  reviewUndoGo: $('#review-undo-go'),
  reviewUndoCancel: $('#review-undo-cancel'),
  reviewSend: $('#review-send'),
  reviewDone: $('#review-done'),
  reviewClose: $('#review-close'),
  tasksBtn: $('#tasks-btn'),
  tasksCount: $('#tasks-count'),
  tasksOverlay: $('#tasks-overlay'),
  tasksBody: $('#tasks-body'),
  tasksFoot: $('#tasks-foot'),
  tasksClose: $('#tasks-close'),
  search: $('#search'),
  savedToggle: $('#saved-toggle'),
  listHeading: $('#list-heading'),
  initBtn: $('#init-btn'),
  initOverlay: $('#init-overlay'),
  initBody: $('#init-body'),
  initFoot: $('#init-foot'),
  initSteps: $('#init-steps'),
  initTitle: $('#init-modal-title'),
  initClose: $('#init-close'),
  projectScreen: $('#project-screen'),
  projectList: $('#project-list'),
  newProjectBtn: $('#new-project-btn'),
  toProjects: $('#to-projects'),
  cpName: $('#cp-name'),
  runBtn: $('#run-btn'),
  runOverlay: $('#run-overlay'),
  runBody: $('#run-body'),
  runFoot: $('#run-foot'),
  runClose: $('#run-close'),
  dirsOverlay: $('#dirs-overlay'),
  dirsBody: $('#dirs-body'),
  dirsAdd: $('#dirs-add'),
  dirsClose: $('#dirs-close'),
  gitStatus: $('#git-status'),
  settingsOverlay: $('#settings-overlay'),
  settingsBody: $('#settings-body'),
  settingsClose: $('#settings-close'),
  procOverlay: $('#proc-overlay'),
  procGlyph: $('#proc-glyph'),
  procTitle: $('#proc-title'),
  procSub: $('#proc-sub'),
  procBarFill: $('#proc-bar-fill'),
  procMeta: $('#proc-meta'),
  emptyNewChat: $('#empty-new-chat'),
  emptyInit: $('#empty-init'),
  usageChip: $('#usage-chip'),
  artifactsBtn: $('#artifacts-btn'),
  linkBtn: $('#link-btn'),
  artifactsCount: $('#artifacts-count'),
  artifactOverlay: $('#artifact-overlay'),
  artifactList: $('#artifact-list'),
  artifactTitle: $('#artifact-title'),
  artifactSub: $('#artifact-sub'),
  artifactActs: $('#artifact-acts'),
  artifactStage: $('#artifact-stage'),
  artifactClose: $('#artifact-close'),
  pinRail: $('#pin-rail'),
  pinList: $('#pin-list'),
  pinAdd: $('#pin-add'),
  pinViewOverlay: $('#pin-view-overlay'),
  pinViewTitle: $('#pin-view-title'),
  pinViewPath: $('#pin-view-path'),
  pinViewBody: $('#pin-view-body'),
  pinViewClose: $('#pin-view-close'),
  lightboxOverlay: $('#lightbox-overlay'),
  lightboxImg: $('#lightbox-img'),
  lightboxCap: $('#lightbox-cap'),
  lightboxClose: $('#lightbox-close'),
};

let state = {
  project: null,         // currently-open project { id, path, name, … }
  projects: [],          // project-picker list
  threads: [],
  activeId: null,
  streaming: false,     // DERIVED: is the *active* thread streaming? (mirror of live.has(activeId))
  live: new Map(),      // threadId -> liveTurn; in-flight turns, one per streaming thread
  models: [],
  modes: [],
  efforts: [],           // reasoning-depth levels offered by the effort picker
  defaultEffort: 'high', // what a chat opens on before its own value loads
  activity: [],          // this chat's shells & sub-agents (for the Activity panel)
  activityOrch: null,    // latest orchestrator token-split summary for this chat (or null)
  activityFilter: 'all', // Activity panel filter: 'all' | 'failed' | 'running'
  tipLevelShown: null,   // which context-rot tip level we've already shown
  view: 'threads',       // 'threads' | 'search' | 'saved'
  results: [],           // current search/favorite results
  lastUsage: null,       // most recent usage, for re-scaling the meter
  seed: null,            // compaction summary of the active thread (until the next turn folds it in)
  summary: null,         // same summary, kept readable ("view summary") even after a turn folds it in
};

/* Context-rot thresholds as a FRACTION of the active model's context window
 * (Opus/Sonnet/Fable = 1M, Haiku = 200K). Nudge gently, not nag. */
const CTX_WARN_FRAC = 0.60;   // amber
const CTX_HIGH_FRAC = 0.85;   // red
const DEFAULT_WINDOW = 1000000;
