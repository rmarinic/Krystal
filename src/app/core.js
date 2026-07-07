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
 *   messages → stream → mentions → attachments → wizard → localization →
 *   settings → tasks → git → links → logo → boot
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
  composerRefs: $('#composer-refs'),
  attachTray: $('#composer-attachments'),
  dropHint: $('#drop-hint'),
  mentionPop: $('#mention-pop'),
  chatTools: $('#chat-tools'),
  modelPicker: $('#model-picker'),
  modePicker: $('#mode-picker'),
  compactBtn: $('#compact-btn'),
  clearBtn: $('#clear-btn'),
  orchWrap: $('#orch-wrap'),
  orchBtn: $('#orch-btn'),
  orchPop: $('#orch-pop'),
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
  activityOrch: null,    // latest orchestrator token-split summary for this chat (or null)
  activityFilter: 'all', // Activity panel filter: 'all' | 'active' | 'done'
  tipLevelShown: null,   // which context-rot tip level we've already shown
  view: 'threads',       // 'threads' | 'search' | 'saved'
  results: [],           // current search/favorite results
  lastUsage: null,       // most recent usage, for re-scaling the meter
  seed: null,            // compaction summary of the active thread (until the next turn folds it in)
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
  refreshModels() { return invoke('refresh_models'); },
  setModel(id, model) { return invoke('set_model', { id, model }); },
  setMode(id, mode) { return invoke('set_mode', { id, mode }); },
  setOrchestration(id, enabled, subModel) { return invoke('set_orchestration', { id, enabled, subModel }); },
  clear(id) { return invoke('clear_thread', { id }); },
  compact(id) { return invoke('compact_thread', { id }); },
  runShell(threadId, command) { return invoke('run_shell', { threadId, command }); },
  hint(id) { return invoke('hint_thread', { id }); },
  initAnalyze(id, brief) { return invoke('init_analyze', { id, brief }); },
  initDraft(id, summary, answers, brief) { return invoke('init_draft', { id, summary, answers, brief }); },
  initSave(id, markdown) { return invoke('init_save', { id, markdown }); },
  readClaudeMd(id) { return invoke('read_claude_md', { id }); },
  search(q, project) { return invoke('search_messages', { q, project }); },
  favorites(project) { return invoke('list_favorites', { project }); },
  toggleFav(mid) { return invoke('toggle_favorite', { messageId: mid }); },
  tasks(project) { return invoke('list_tasks', { project }); },
  addTask(project, title, note) { return invoke('add_task', { project, title, note }); },
  updateTask(id, title, done) { return invoke('update_task', { id, title, done }); },
  deleteTask(id) { return invoke('delete_task', { id }); },
  clearDoneTasks(project) { return invoke('clear_done_tasks', { project }); },
  taskCount(project) { return invoke('task_count', { project }); },
  generateTasks(cwd, brief, answers) { return invoke('generate_tasks', { cwd, brief, answers }); },
  setDiscordEnabled(enabled) { return invoke('set_discord_enabled', { enabled }); },
  discordSetProject(name) { return invoke('discord_set_project', { name }); },
  discordSetShareName(enabled) { return invoke('discord_set_share_name', { enabled }); },
  stopChat(threadId) { return invoke('stop_chat', { threadId }); },
  activeRuns() { return invoke('active_runs'); },
  stopAllChats() { return invoke('stop_all_chats'); },
  gitStatus(cwd) { return invoke('git_status', { cwd }); },
  gitBranches(cwd) { return invoke('git_branches', { cwd }); },
  gitCheckout(cwd, branch) { return invoke('git_checkout', { cwd, branch }); },
  gitCreateBranch(cwd, name) { return invoke('git_create_branch', { cwd, name }); },
  gitFetch(cwd) { return invoke('git_fetch', { cwd }); },
  gitPull(cwd) { return invoke('git_pull', { cwd }); },
  gitPush(cwd) { return invoke('git_push', { cwd }); },
  openExternal(url) { return invoke('open_external', { url }); },
  openWebview(url) { return invoke('open_webview', { url }); },
  claudeMdExists(cwd) { return invoke('claude_md_exists', { cwd }); },
  claudeUsage(weeklyReset) { return invoke('claude_usage', { weeklyReset }); },
  preflight() { return invoke('preflight'); },
  appVersion() { return invoke('app_version'); },
  readImage(path) { return invoke('read_image', { path }); },
  saveAttachment(name, dataBase64) { return invoke('save_attachment', { name, dataBase64 }); },
  updateClaude(onEvent) { return invoke('update_claude', { onEvent }); },
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

/* ----------------------------- code blocks ------------------------------- */

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

/* Copy text to the clipboard, with a fallback for the rare no-clipboard case. */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* Add a hover "copy" button to a <pre> code block (idempotent — once per block). */
function addCopyButton(pre) {
  if (!pre || pre.querySelector('.code-copy')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.title = tr('code.copy');
  btn.setAttribute('aria-label', tr('code.copy'));
  btn.innerHTML = COPY_ICON;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const code = pre.querySelector('code');
    const ok = await copyText((code || pre).textContent || '');
    if (!ok) return;
    btn.classList.add('copied');
    btn.innerHTML = CHECK_ICON;
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1400);
  });
  pre.appendChild(btn);
}

/* Highlight every fenced code block in `scope` and give each a copy button.
   The single place all rendered assistant markdown passes through (live stream
   + reload), so highlighting and the copy affordance stay consistent. */
function decorateCode(scope) {
  scope.querySelectorAll('pre code').forEach((code) => {
    if (window.hljs) hljs.highlightElement(code);
    addCopyButton(code.parentElement);
  });
}

/* True for paths that point at an image we can preview inline. */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
function isImagePath(p) { return !!p && IMG_EXT_RE.test(p.trim()); }

