/* api.js — the `api` wrapper: one method per backend command, all through
   core.js's `invoke` (so each one also works against another Krystal).
   Part of the chat frontend; shares one global scope (see core.js). */

/* Each method maps to a #[tauri::command] in the Rust backend. The returned
 * shapes match the old HTTP JSON exactly, so the rest of the app is unchanged. */

const api = {
  projects() { return invoke('list_projects'); },
  createProject(path) { return invoke('create_project', { path }); },
  selectProject(id) { return invoke('select_project', { id }); },
  moveProject(id, path) { return invoke('move_project', { id, path }); },
  deleteProject(id) { return invoke('delete_project', { id }); },
  threads(project) { return invoke('list_threads', { project }); },
  thread(id) { return invoke('get_thread', { id }); },
  create(cwd) { return invoke('create_thread', { cwd }); },
  branch(id, messageId) { return invoke('branch_thread', { id, messageId: messageId || null }); },
  remove(id) { return invoke('delete_thread', { id }); },
  rename(id, title) { return invoke('rename_thread', { id, title }); },
  config() { return invoke('get_config'); },
  setUiLanguage(lang) { return invoke('set_ui_language', { lang }); },
  refreshModels() { return invoke('refresh_models'); },
  setModel(id, model) { return invoke('set_model', { id, model }); },
  setMode(id, mode) { return invoke('set_mode', { id, mode }); },
  setEffort(id, effort) { return invoke('set_effort', { id, effort }); },
  listPins(project) { return invoke('list_pins', { project }); },
  addPin(project, path) { return invoke('add_pin', { project, path }); },
  removePin(project, id) { return invoke('remove_pin', { project, id }); },
  readPinnedFile(path) { return invoke('read_pinned_file', { path }); },
  listSkills(project) { return invoke('list_skills', { project }); },
  listProjectDirs(project) { return invoke('list_project_dirs', { project }); },
  addProjectDir(project, path) { return invoke('add_project_dir', { project, path }); },
  removeProjectDir(project, id) { return invoke('remove_project_dir', { project, id }); },
  setSuggestions(enabled) { return invoke('set_suggestions', { enabled }); },
  setOrchestration(id, enabled, subModel) { return invoke('set_orchestration', { id, enabled, subModel }); },
  clear(id) { return invoke('clear_thread', { id }); },
  // `onProgress({ chars, thought })` as the summary is written.
  compact(id, onProgress) {
    // The command requires its channel, so one goes along even when nobody listens.
    const onEvent = new Channel();
    onEvent.onmessage = onProgress || (() => {});
    return invoke('compact_thread', { id, onEvent });
  },
  runShell(threadId, command) { return invoke('run_shell', { threadId, command }); },
  getRunConfig(project) { return invoke('get_run_config', { project }); },
  setRunConfig(project, command) { return invoke('set_run_config', { project, command }); },
  detectRunCommand(project) { return invoke('detect_run_command', { project }); },
  runApp(project, command, onEvent) { return invoke('run_app', { project, command, onEvent }); },
  stopRun(project) { return invoke('stop_run', { project }); },
  initAnalyze(id, brief) { return invoke('init_analyze', { id, brief }); },
  initDraft(id, summary, answers, brief) { return invoke('init_draft', { id, summary, answers, brief }); },
  initSave(id, markdown) { return invoke('init_save', { id, markdown }); },
  readClaudeMd(id) { return invoke('read_claude_md', { id }); },
  search(q, project) { return invoke('search_messages', { q, project }); },
  favorites(project) { return invoke('list_favorites', { project }); },
  toggleFav(mid) { return invoke('toggle_favorite', { messageId: mid }); },
  deleteMessage(mid) { return invoke('delete_message', { messageId: mid }); },
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
  // `force` kills the turn's process instead of politely asking it to stop.
  stopChat(threadId, force) { return invoke('stop_chat', { threadId, force: !!force }); },
  // Ask mode: `decision` is 'allow' | 'always' | 'deny' (see permissions.js).
  answerPermission(threadId, requestId, decision) {
    return invoke('answer_permission', { threadId, requestId, decision });
  },
  activeRuns() { return invoke('active_runs'); },
  stopAllChats() { return invoke('stop_all_chats'); },
  gitStatus(cwd) { return invoke('git_status', { cwd }); },
  gitBranches(cwd) { return invoke('git_branches', { cwd }); },
  gitCheckout(cwd, branch) { return invoke('git_checkout', { cwd, branch }); },
  gitCreateBranch(cwd, name) { return invoke('git_create_branch', { cwd, name }); },
  gitFetch(cwd) { return invoke('git_fetch', { cwd }); },
  gitPull(cwd) { return invoke('git_pull', { cwd }); },
  gitPush(cwd) { return invoke('git_push', { cwd }); },
  ciRuns(cwd) { return invoke('ci_runs', { cwd }); },
  ciRun(cwd, id) { return invoke('ci_run', { cwd, id }); },
  openExternal(url) { return invoke('open_external', { url }); },
  revealPath(path) { return invoke('reveal_path', { path }); },
  openPath(path) { return invoke('open_path', { path }); },
  notify(title, body) { return invoke('notify', { title, body }); },
  rewindFiles(threadId, ckpt, dryRun) { return invoke('rewind_files', { threadId, ckpt, dryRun }); },
  openWebview(url) { return invoke('open_webview', { url }); },
  claudeMdExists(cwd) { return invoke('claude_md_exists', { cwd }); },
  claudeUsage() { return invoke('claude_usage'); },
  preflight() { return invoke('preflight'); },
  appVersion() { return invoke('app_version'); },
  readImage(path) { return invoke('read_image', { path }); },
  listArtifacts(project) { return invoke('list_artifacts', { project }); },
  getArtifact(project, artId, version) { return invoke('get_artifact', { project, artId, version }); },
  deleteArtifact(project, artId) { return invoke('delete_artifact', { project, artId }); },
  // `rendered` is what the panel is showing when that differs from what's
  // stored — a diagram saves as its SVG, not as the mermaid source behind it.
  exportArtifact(project, artId, version, path, rendered) {
    return invoke('export_artifact', { project, artId, version, path, rendered });
  },
  openArtifactExternally(project, artId, version, rendered, ext) {
    return invoke('open_artifact_externally', { project, artId, version, rendered, ext });
  },
  saveAttachment(name, dataBase64) { return invoke('save_attachment', { name, dataBase64 }); },
  // Krystal Cloud: each answers with the link's status (see cloud/link.rs) —
  // never the token, which stays in the backend.
  cloudStatus() { return invoke('cloud_status'); },
  cloudLinkStart() { return invoke('cloud_link_start'); },
  cloudLinkOpen() { return invoke('cloud_link_open'); },
  cloudLinkCancel() { return invoke('cloud_link_cancel'); },
  cloudCheck() { return invoke('cloud_check'); },
  cloudUnlink() { return invoke('cloud_unlink'); },
  // The live connection (cloud/presence.rs): { reachable, conn }.
  cloudPresence() { return invoke('cloud_presence'); },
  cloudSetReachable(on) { return invoke('cloud_set_reachable', { on }); },
  getGuestAccess() { return invoke('get_guest_access'); },
  setGuestAccess(access) { return invoke('set_guest_access', { access }); },
  // The hub (cloud/hub.rs): the account's other computers, and their commands.
  hubComputers() { return invoke('hub_computers'); },
  hubCall(deviceId, command, args) { return invoke('hub_call', { deviceId, command, args }); },
  // `onEvent(ev)` for each of the command's events; resolves to { ended }.
  hubStream(deviceId, command, args, streamId, onEvent) {
    const ch = new Channel();
    ch.onmessage = onEvent || (() => {});
    return invoke('hub_stream', { deviceId, command, args, streamId, onEvent: ch });
  },
  hubStreamCancel(streamId) { return invoke('hub_stream_cancel', { streamId }); },
  updateClaude(onEvent) { return invoke('update_claude', { onEvent }); },
  updateClaudeNpm(onEvent) { return invoke('update_claude_npm', { onEvent }); },
};
