/* core.js — shared foundation for the chat frontend (Tauri build).
 *
 * The frontend is plain classic scripts (no bundler, no modules). It was one big
 * app.js; it's now split into cohesive files under src/app/ that load in order
 * via <script defer> and SHARE ONE GLOBAL SCOPE — a `const`/`let`/`function`
 * declared in an earlier file is visible to every later file, exactly as if the
 * files were concatenated back into a single app.js. So load order matters and
 * mirrors the original top-to-bottom order; boot.js (the entry point) loads last.
 *
 * Load order (see index.html):
 *   core → sidebar → chat → projects → controls → activity → search →
 *   messages → stream → wizard → localization → settings → git → links →
 *   logo → boot
 *
 * This file owns the bits everything else builds on: the Tauri IPC handles, the
 * `$` query helper, `tr` (i18n lookup), the `els` element map, `state`, the
 * context-window constants, the `api` wrapper, and the small shared utilities
 * (basename, escapeHtml, the overlay/replay animation helpers, …).
 *
 * Talks to the Rust backend over Tauri IPC instead of HTTP:
 *   invoke('command', args)         ← was fetch('/api/…')
 *   Channel + invoke('chat', …)     ← was the SSE stream
 *   dialog.open({directory:true})   ← was the native PowerShell picker
 * The UI, rendering and behaviour are otherwise identical to the web version.
 */

const { invoke, Channel } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

const $ = (sel) => document.querySelector(sel);

/* Localized string lookup. Named `tr` (not `t`) because `t` is used widely as a
 * local variable across this file (threads, tokens, timestamps). */
const tr = (key, vars, fallback) => window.I18N.t(key, vars, fallback);

const els = {
  threadList: $('#thread-list'),
  newChat: $('#new-chat'),
  title: $('#chat-title'),
  cwd: $('#chat-cwd'),
  feed: $('#feed'),
  empty: $('#empty-state'),
  composer: $('#composer'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  chatTools: $('#chat-tools'),
  modelPicker: $('#model-picker'),
  modePicker: $('#mode-picker'),
  compactBtn: $('#compact-btn'),
  clearBtn: $('#clear-btn'),
  meterRow: $('#meter-row'),
  meterFill: $('#meter-fill'),
  meterLabel: $('#meter-label'),
  tips: $('#tips'),
  hintBtn: $('#hint-btn'),
  activityBtn: $('#activity-btn'),
  activityOverlay: $('#activity-overlay'),
  activityBody: $('#activity-body'),
  activityClose: $('#activity-close'),
  activityFilters: $('#activity-filters'),
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
  gitStatus: $('#git-status'),
  settingsOverlay: $('#settings-overlay'),
  settingsBody: $('#settings-body'),
  settingsClose: $('#settings-close'),
  procOverlay: $('#proc-overlay'),
  procGlyph: $('#proc-glyph'),
  procTitle: $('#proc-title'),
  procSub: $('#proc-sub'),
  procBarFill: $('#proc-bar-fill'),
  emptyNewChat: $('#empty-new-chat'),
  emptyInit: $('#empty-init'),
  usageChip: $('#usage-chip'),
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
  activity: [],          // this chat's shells & sub-agents (for the Activity panel)
  activityFilter: 'all', // Activity panel filter: 'all' | 'active' | 'done'
  tipLevelShown: null,   // which context-rot tip level we've already shown
  view: 'threads',       // 'threads' | 'search' | 'saved'
  results: [],           // current search/favorite results
  lastUsage: null,       // most recent usage, for re-scaling the meter
};

/* Context-rot thresholds as a FRACTION of the active model's context window
 * (Opus/Sonnet/Fable = 1M, Haiku = 200K). Nudge gently, not nag. */
const CTX_WARN_FRAC = 0.60;   // amber
const CTX_HIGH_FRAC = 0.85;   // red
const DEFAULT_WINDOW = 1000000;

/* ------------------------------ utilities -------------------------------- */
/* Each method maps to a #[tauri::command] in the Rust backend. The returned
 * shapes match the old HTTP JSON exactly, so the rest of the app is unchanged. */

const api = {
  projects() { return invoke('list_projects'); },
  createProject(path) { return invoke('create_project', { path }); },
  selectProject(id) { return invoke('select_project', { id }); },
  deleteProject(id) { return invoke('delete_project', { id }); },
  threads(project) { return invoke('list_threads', { project }); },
  thread(id) { return invoke('get_thread', { id }); },
  create(cwd) { return invoke('create_thread', { cwd }); },
  remove(id) { return invoke('delete_thread', { id }); },
  rename(id, title) { return invoke('rename_thread', { id, title }); },
  config() { return invoke('get_config'); },
  setModel(id, model) { return invoke('set_model', { id, model }); },
  setMode(id, mode) { return invoke('set_mode', { id, mode }); },
  clear(id) { return invoke('clear_thread', { id }); },
  compact(id) { return invoke('compact_thread', { id }); },
  hint(id) { return invoke('hint_thread', { id }); },
  initAnalyze(id, brief) { return invoke('init_analyze', { id, brief }); },
  initDraft(id, summary, answers, brief) { return invoke('init_draft', { id, summary, answers, brief }); },
  initSave(id, markdown) { return invoke('init_save', { id, markdown }); },
  readClaudeMd(id) { return invoke('read_claude_md', { id }); },
  search(q, project) { return invoke('search_messages', { q, project }); },
  favorites(project) { return invoke('list_favorites', { project }); },
  toggleFav(mid) { return invoke('toggle_favorite', { messageId: mid }); },
  setDiscordEnabled(enabled) { return invoke('set_discord_enabled', { enabled }); },
  discordSetProject(name) { return invoke('discord_set_project', { name }); },
  discordSetShareName(enabled) { return invoke('discord_set_share_name', { enabled }); },
  stopChat(threadId) { return invoke('stop_chat', { threadId }); },
  gitStatus(cwd) { return invoke('git_status', { cwd }); },
  gitBranches(cwd) { return invoke('git_branches', { cwd }); },
  gitCheckout(cwd, branch) { return invoke('git_checkout', { cwd, branch }); },
  gitCreateBranch(cwd, name) { return invoke('git_create_branch', { cwd, name }); },
  gitFetch(cwd) { return invoke('git_fetch', { cwd }); },
  gitPull(cwd) { return invoke('git_pull', { cwd }); },
  gitPush(cwd) { return invoke('git_push', { cwd }); },
  openExternal(url) { return invoke('open_external', { url }); },
  claudeMdExists(cwd) { return invoke('claude_md_exists', { cwd }); },
  claudeUsage(weeklyReset) { return invoke('claude_usage', { weeklyReset }); },
};

function basename(p) { return p.split(/[\\/]/).pop(); }
function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function renderMarkdown(md) {
  const html = window.marked ? marked.parse(md || '') : (md || '');
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
function scrollFeed() { els.feed.scrollTop = els.feed.scrollHeight; }

