//! Tauri command handlers — the IPC surface the frontend talks to.
//! Each command maps 1:1 to an endpoint in the original server.js router.

use std::process::Stdio;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::claude::{self, Caps};
use crate::db;
use crate::discord;
use crate::models;

/// Shared app state managed by Tauri.
pub struct AppState {
    pub db: std::sync::Mutex<rusqlite::Connection>,
    pub caps: Caps,
    /// The resolved `claude` executable. Mutable because onboarding can install
    /// Claude Code at runtime and we then need every command to use the new path
    /// without a restart.
    pub claude_bin: std::sync::Mutex<String>,
    /// Discord Rich Presence handle (opt-in; off until the user enables it).
    pub discord: discord::Presence,
    /// PIDs of in-flight `claude` chat processes, keyed by thread id, so a
    /// `stop_chat` can interrupt a turn mid-stream.
    pub running: std::sync::Mutex<std::collections::HashMap<String, u32>>,
}

impl AppState {
    fn sys_prompt(&self) -> String {
        claude::capability_prompt(self.caps)
    }

    /// Current claude executable path (owned clone — never held across an await).
    pub fn claude_bin(&self) -> String {
        self.claude_bin.lock().unwrap().clone()
    }
}

type CmdResult = Result<Value, String>;

/* ------------------------------- config ---------------------------------- */

#[tauri::command]
pub fn get_config() -> Value {
    json!({ "models": models::MODELS, "modes": models::MODES })
}

/* ----------------------------- onboarding -------------------------------- */

/// Boot-time readiness check: is Claude Code installed, and is the user signed in?
#[tauri::command]
pub fn preflight(state: State<'_, AppState>) -> Value {
    let bin = state.claude_bin();
    let version = claude::claude_version(&bin);
    json!({
        "installed": version.is_some(),
        "version": version,
        "authenticated": claude::is_authenticated(),
        "claudeBin": bin,
    })
}

/// Install Claude Code via the official PowerShell installer, streaming progress
/// to `on_event`. On success the resolved binary is adopted into AppState so the
/// rest of the app can use it without a restart. Returns the new preflight state.
#[tauri::command]
pub async fn install_claude(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    claude::install_claude_code(&on_event).await?;
    // Re-resolve now that it should be on disk, and adopt the new path.
    let resolved = claude::resolve_claude();
    let version = claude::claude_version(&resolved);
    if version.is_some() {
        *state.claude_bin.lock().unwrap() = resolved.clone();
    }
    Ok(json!({
        "installed": version.is_some(),
        "version": version,
        "authenticated": claude::is_authenticated(),
        "claudeBin": resolved,
    }))
}

/// Update the Claude Code CLI in place (the same as running `claude update` in a
/// terminal), streaming progress to `on_event`. Re-resolves afterwards and
/// reports the before/after versions so the UI can say whether anything changed.
#[tauri::command]
pub async fn update_claude(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    let bin = state.claude_bin();
    let before = claude::claude_version(&bin);
    claude::update_claude_code(&bin, &on_event).await?;
    // Re-resolve in case the update moved the binary, and adopt the new path.
    let resolved = claude::resolve_claude();
    let after = claude::claude_version(&resolved);
    if after.is_some() {
        *state.claude_bin.lock().unwrap() = resolved.clone();
    }
    Ok(json!({
        "ok": after.is_some(),
        "before": before,
        "version": after,
        "updated": before != after,
        "claudeBin": resolved,
    }))
}

/// Open a real terminal running interactive `claude`, which walks the user
/// through Anthropic's normal browser sign-in. The UI re-checks via `preflight`.
#[tauri::command]
pub fn open_login(state: State<'_, AppState>) -> CmdResult {
    let bin = state.claude_bin();
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", "start", "Krystal — Claude login", "cmd", "/k", &bin]);
    cmd.spawn()
        .map_err(|e| format!("could not open the login window: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// Open a URL in the user's default browser. Validated to http(s) only and free
/// of control/quote characters, then handed to `explorer.exe` (which launches
/// the default handler) as a single argument — no shell, so no `cmd` re-parsing.
#[tauri::command]
pub fn open_external(url: String) -> CmdResult {
    let ok_scheme = {
        let l = url.to_ascii_lowercase();
        l.starts_with("http://") || l.starts_with("https://")
    };
    let safe = !url.chars().any(|c| c.is_control() || c == '"');
    if !ok_scheme || !safe {
        return Err("refused to open this link".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("could not open the link: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// Absolute path of the running executable. The self-updater uses it to detect
/// when the copy being launched isn't the one the installer updates (e.g. the app
/// runs from a custom/portable folder), so it can break the "re-installs the same
/// version on every launch" loop instead of looping forever. Empty if unknown.
#[tauri::command]
pub fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The app's own version (compile-time, kept in sync with tauri.conf.json by the
/// release bump). Surfaced as the faint version label in the corner of the UI.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Read a local image file and return it as a `data:` URL so the frontend can
/// preview it inline (e.g. when Claude reads an image). Returns an empty string
/// for anything that isn't a readable, sensibly-sized image — the UI shows a
/// "couldn't load" note in that case. Read on demand (chip expand), not eagerly.
#[tauri::command]
pub fn read_image(path: String) -> String {
    const MAX: u64 = 12 * 1024 * 1024; // 12 MB cap — these are inline previews, not downloads
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return String::new(),
    };
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() && m.len() <= MAX => {}
        _ => return String::new(),
    }
    match std::fs::read(p) {
        Ok(bytes) => format!("data:{};base64,{}", mime, base64_encode(&bytes)),
        Err(_) => String::new(),
    }
}

/// Minimal standard-base64 encoder (no padding shortcuts) — keeps the image
/// preview dependency-free rather than pulling in a crate for one call site.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = *chunk.get(1).unwrap_or(&0) as usize;
        let b2 = *chunk.get(2).unwrap_or(&0) as usize;
        out.push(T[b0 >> 2] as char);
        out.push(T[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { T[((b1 & 0x0f) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[b2 & 0x3f] as char } else { '=' });
    }
    out
}

/* ------------------------------- threads --------------------------------- */

#[tauri::command]
pub fn list_threads(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "threads": db::list_threads(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn get_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::get_thread(&conn, &id).ok_or_else(|| "not found".into())
}

#[tauri::command]
pub fn create_thread(state: State<'_, AppState>, cwd: String) -> CmdResult {
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    let conn = state.db.lock().unwrap();
    let thread = db::create(&conn, &cwd).ok_or("could not create thread")?;
    db::touch_project(&conn, &cwd); // keep the project list ordered by recent use
    Ok(thread)
}

/* ------------------------------- projects -------------------------------- */

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "projects": db::list_projects(&conn) })
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, path: String) -> CmdResult {
    if path.trim().is_empty() {
        return Err("path required".into());
    }
    let conn = state.db.lock().unwrap();
    db::create_project(&conn, &path).ok_or_else(|| "could not create project".into())
}

#[tauri::command]
pub fn select_project(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::select_project(&conn, &id).ok_or_else(|| "not found".into())
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::delete_project(&conn, &id);
    json!({ "ok": true })
}

#[tauri::command]
pub fn delete_thread(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::remove(&conn, &id);
    json!({ "ok": true })
}

#[tauri::command]
pub fn set_model(state: State<'_, AppState>, id: String, model: String) -> CmdResult {
    if !models::is_valid_model(&model) {
        return Err("unknown model".into());
    }
    let conn = state.db.lock().unwrap();
    db::set_model(&conn, &id, &model);
    Ok(json!({ "model": model }))
}

#[tauri::command]
pub fn set_mode(state: State<'_, AppState>, id: String, mode: String) -> CmdResult {
    if !models::is_valid_mode(&mode) {
        return Err("unknown mode".into());
    }
    let conn = state.db.lock().unwrap();
    db::set_mode(&conn, &id, &mode);
    Ok(json!({ "mode": mode }))
}

#[tauri::command]
pub fn clear_thread(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::clear(&conn, &id);
    json!({ "ok": true })
}

/// Rename a chat. Trims the title and caps its length; an empty title is
/// rejected so a chat never loses its name to a blank.
#[tauri::command]
pub fn rename_thread(state: State<'_, AppState>, id: String, title: String) -> CmdResult {
    let title = title.trim();
    if title.is_empty() {
        return Err("empty title".into());
    }
    let title: String = title.chars().take(120).collect();
    let conn = state.db.lock().unwrap();
    db::set_title(&conn, &id, &title);
    Ok(json!({ "title": title }))
}

/* ------------------------------ search/fav ------------------------------- */

#[tauri::command]
pub fn search_messages(state: State<'_, AppState>, q: String, project: Option<String>) -> Value {
    let q = q.trim();
    let conn = state.db.lock().unwrap();
    let results = if q.is_empty() { vec![] } else { db::search(&conn, q, project.as_deref()) };
    json!({ "results": results })
}

#[tauri::command]
pub fn list_favorites(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "favorites": db::list_favorites(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, message_id: i64) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::toggle_favorite(&conn, message_id).ok_or_else(|| "not found".into())
}

/* -------------------------------- chat ----------------------------------- */

#[tauri::command]
pub async fn chat(
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    files: Option<Vec<String>>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let files = files.unwrap_or_default();

    // Snapshot the thread (owned) so we hold no DB lock across the stream.
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &thread_id)
    }
    .ok_or("unknown thread")?;

    let sys = state.sys_prompt();
    let mut args = claude::base_args(&meta.model, &sys);
    claude::apply_mode(&mut args, &meta.mode);   // Auto = full power; Plan = research only
    if let Some(sid) = &meta.session_id {
        args.push("--resume".into());
        args.push(sid.clone());
    }

    let seed = meta.seed.clone();
    let prompt = claude::build_prompt(&text, &files, seed.as_deref());
    // A one-time compact seed is folded into this prompt, then cleared.
    if seed.is_some() {
        let conn = state.db.lock().unwrap();
        db::set_seed(&conn, &thread_id, None);
    }

    // First-turn auto-naming: kick off a cheap Haiku call to title the chat from
    // the user's opening message, running it alongside the main stream so it adds
    // no perceptible latency. A thread still on its default title needs a name.
    let needs_title = match &meta.title {
        None => true,
        Some(s) => s.trim().is_empty() || s == "New chat",
    };
    let title_task = if needs_title {
        let bin = state.claude_bin();
        let cwd = meta.cwd.clone();
        let opening = text.clone();
        Some(tokio::spawn(async move {
            claude::generate_title(&bin, &cwd, &opening).await
        }))
    } else {
        None
    };

    let res = claude::run_chat_stream(
        &state.claude_bin(),
        &args,
        &meta.cwd,
        &prompt,
        &on_event,
        &state.running,
        &thread_id,
    )
    .await?;

    // Match server.js: on a hard error with no text, the error event was already
    // emitted — don't record an empty turn.
    if res.final_text.is_empty() && res.is_error {
        return Ok(());
    }

    let session_id = res.session_id.clone().or_else(|| meta.session_id.clone());
    let (usage, fallback_title, assistant_id, updated_at) = {
        let conn = state.db.lock().unwrap();
        db::record_turn(
            &conn,
            &thread_id,
            &text,
            &files,
            &res.final_text,
            &res.segments,
            session_id.as_deref(),
            &res.usage,
            res.cost_usd,
        )
    };

    // Signal completion immediately after persisting. `done` is the single
    // completion signal the UI keys on: it drops the in-flight turn and renders
    // from the DB instead. Emitting it before the (first-turn) auto-title
    // resolves keeps that window ~0, so switching into the thread mid-finish
    // can't briefly double-render the just-saved turn.
    let _ = on_event.send(json!({
        "type": "done",
        "sessionId": session_id,
        "text": res.final_text,
        "title": fallback_title,
        "updatedAt": updated_at,
        "usage": usage,
        "assistantId": assistant_id,
    }));

    // First-turn auto-naming resolves on its own clock (a cheap Haiku call run
    // alongside the stream). When it lands, persist it and nudge the UI with a
    // lightweight `title` event so the header/sidebar pick up the nicer name.
    if let Some(task) = title_task {
        if let Ok(Some(named)) = task.await {
            {
                let conn = state.db.lock().unwrap();
                db::set_title(&conn, &thread_id, &named);
            }
            let _ = on_event.send(json!({ "type": "title", "title": named }));
        }
    }
    Ok(())
}

/// Interrupt the in-flight chat turn for `thread_id`, if any, by killing its
/// `claude` process tree. The stream then ends on its own; any text already
/// produced is still persisted by the `chat` handler.
#[tauri::command]
pub async fn stop_chat(state: State<'_, AppState>, thread_id: String) -> Result<Value, String> {
    let pid = state.running.lock().unwrap().get(&thread_id).copied();
    if let Some(pid) = pid {
        // Kill off the main thread: `taskkill /T /F` on the claude → node tree can
        // take a moment, and a synchronous command blocks the window message loop
        // — which is what makes the app intermittently freeze ("Not responding")
        // when interrupting a turn. spawn_blocking keeps the UI responsive.
        let _ = tokio::task::spawn_blocking(move || claude::kill_process_tree(pid)).await;
    }
    Ok(json!({ "ok": pid.is_some() }))
}

/// List the chat turns the app currently thinks are running, each verified
/// against the OS so the UI can flag any whose process has already died (stale).
/// Returns `[{ threadId, pid, alive }]`. Liveness checks run off the main thread.
#[tauri::command]
pub async fn active_runs(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let entries: Vec<(String, u32)> = {
        let map = state.running.lock().unwrap();
        map.iter().map(|(k, v)| (k.clone(), *v)).collect()
    };
    let mut out = Vec::with_capacity(entries.len());
    for (thread_id, pid) in entries {
        let alive = tokio::task::spawn_blocking(move || claude::pid_alive(pid))
            .await
            .unwrap_or(false);
        out.push(json!({ "threadId": thread_id, "pid": pid, "alive": alive }));
    }
    Ok(out)
}

/// Interrupt every tracked chat turn at once: clear the registry, then kill each
/// process tree off the main thread. Returns how many were stopped. Each stream
/// ends on its own once its process dies (any partial text is still persisted).
#[tauri::command]
pub async fn stop_all_chats(state: State<'_, AppState>) -> Result<Value, String> {
    let pids: Vec<u32> = {
        let mut map = state.running.lock().unwrap();
        let pids = map.values().copied().collect();
        map.clear();
        pids
    };
    let n = pids.len();
    if !pids.is_empty() {
        let _ = tokio::task::spawn_blocking(move || {
            for pid in pids {
                claude::kill_process_tree(pid);
            }
        })
        .await;
    }
    Ok(json!({ "stopped": n }))
}

/* ------------------------------- git status ------------------------------ */

/// Run a `git` subcommand inside `cwd`, returning trimmed stdout on a clean exit.
/// `None` means git failed (most often: the folder isn't a repository).
fn git_out(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(claude::CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A tiny git summary for the composer status line: current branch plus the
/// number of added/deleted lines in the working tree (staged + unstaged). If the
/// folder isn't a git repository, `isRepo` is false and the UI hides the line.
#[tauri::command]
pub fn git_status(cwd: String) -> Value {
    let branch = match git_out(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) if !b.is_empty() => b,
        _ => return json!({ "isRepo": false }),
    };

    let mut added = 0i64;
    let mut deleted = 0i64;
    for args in [&["diff", "--numstat"][..], &["diff", "--cached", "--numstat"][..]] {
        if let Some(out) = git_out(&cwd, args) {
            for line in out.lines() {
                let mut cols = line.split('\t');
                // Binary files report "-" for both counts; parse failures → 0.
                added += cols.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
                deleted += cols.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
            }
        }
    }
    json!({ "isRepo": true, "branch": branch, "added": added, "deleted": deleted })
}

/// List the project's branches for the picker: local heads (most-recently
/// committed first) and remote-tracking branches that don't already have a local
/// counterpart. `isRepo` is false when the folder isn't a git repo.
#[tauri::command]
pub fn git_branches(cwd: String) -> Value {
    let current = match git_out(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(c) if !c.is_empty() => c,
        _ => return json!({ "isRepo": false }),
    };

    let local_raw = git_out(
        &cwd,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    )
    .unwrap_or_default();
    let local: Vec<String> = local_raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // Remote-tracking branches, e.g. "origin/feature". Drop the "*/HEAD" alias and
    // any whose short name already exists locally (a local checkout takes priority).
    let remote_raw = git_out(
        &cwd,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"],
    )
    .unwrap_or_default();
    let mut remote: Vec<Value> = Vec::new();
    for full in remote_raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if full.ends_with("/HEAD") {
            continue;
        }
        // Split once: "origin/feature/x" → remote "origin", short "feature/x".
        let (rem, short) = match full.split_once('/') {
            Some((r, s)) if !s.is_empty() => (r, s),
            _ => continue,
        };
        if local.iter().any(|b| b == short) {
            continue;
        }
        remote.push(json!({ "full": full, "short": short, "remote": rem }));
    }

    json!({ "isRepo": true, "current": current, "local": local, "remote": remote })
}

/// Run a git subcommand inside `cwd` and report success + git's message. Git
/// writes status to stderr even on success (e.g. fetch/pull), so on success we
/// surface stdout-or-stderr as `output`; on failure, stderr-or-stdout as `error`.
fn git_action(cwd: &str, args: &[&str]) -> Value {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(claude::CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => {
            let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let se = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if out.status.success() {
                json!({ "ok": true, "output": if so.is_empty() { se } else { so } })
            } else {
                json!({ "ok": false, "error": if se.is_empty() { so } else { se } })
            }
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Switch the working tree to `branch`. A remote-only name (e.g. "feature") makes
/// git create a local tracking branch automatically (its DWIM behaviour).
#[tauri::command]
pub fn git_checkout(cwd: String, branch: String) -> Value {
    if branch.trim().is_empty() {
        return json!({ "ok": false, "error": "no branch given" });
    }
    git_action(&cwd, &["checkout", &branch])
}

/// Create a new branch off the current HEAD and switch to it.
#[tauri::command]
pub fn git_create_branch(cwd: String, name: String) -> Value {
    let name = name.trim();
    if name.is_empty() {
        return json!({ "ok": false, "error": "no branch name given" });
    }
    git_action(&cwd, &["checkout", "-b", name])
}

/// Fetch all remotes and prune deleted remote branches.
#[tauri::command]
pub fn git_fetch(cwd: String) -> Value {
    git_action(&cwd, &["fetch", "--all", "--prune"])
}

/// Pull the current branch (fast-forward or merge per the repo's config).
#[tauri::command]
pub fn git_pull(cwd: String) -> Value {
    git_action(&cwd, &["pull"])
}

/// Push the current branch. If it has no upstream yet, set one on `origin` so the
/// first push from a new branch just works.
#[tauri::command]
pub fn git_push(cwd: String) -> Value {
    let first = git_action(&cwd, &["push"]);
    if first.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return first;
    }
    let err = first.get("error").and_then(|v| v.as_str()).unwrap_or("");
    if err.contains("no upstream") || err.contains("set-upstream") || err.contains("has no upstream") {
        return git_action(&cwd, &["push", "-u", "origin", "HEAD"]);
    }
    first
}

/* ------------------------------ claude usage ----------------------------- */
/* Estimate Claude Code subscription usage by summing *weighted* tokens from the
 * local session transcripts (~/.claude/projects/**/*.jsonl) into a rolling
 * 5-hour window and a 7-day window — the same method the official-style status
 * line uses. Output is weighted so cheap cache-reads don't dominate fresh output
 * (mirrors Anthropic's rough cost ratios). The CLI exposes no per-plan limits, so
 * the frontend turns these totals into percentages against user-calibrated caps. */

const W_INPUT: f64 = 1.0;
const W_OUTPUT: f64 = 5.0;
const W_CACHE_CREATE: f64 = 1.25;
const W_CACHE_READ: f64 = 0.1;

fn claude_home() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::Path::new(&home).join(".claude"))
}

/// Recursively collect `*.jsonl` paths under `dir` whose mtime is newer than
/// `min_mtime` (unix secs) — old session files can't hold tokens inside the
/// 7-day window, so skipping them keeps the scan quick.
fn collect_recent_jsonl(dir: &std::path::Path, min_mtime: f64, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_recent_jsonl(&path, min_mtime, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            if mtime >= min_mtime {
                out.push(path);
            }
        }
    }
}

/// Weighted token usage for the current 5-hour session block and the weekly
/// window. `block_start` is the live session's start (reset = start + 5h);
/// `week_from` is the start of the counted weekly window. `available:false`
/// when there's no `~/.claude/projects` to read.
///
/// `weekly_reset` (unix secs) is the user-calibrated weekly reset anchor — when
/// present we count the week from the most recent past reset, matching Claude's
/// fixed weekly cycle; otherwise we fall back to a trailing 7 days.
#[tauri::command]
pub fn claude_usage(weekly_reset: Option<f64>) -> Value {
    let projects = match claude_home() {
        Some(h) => h.join("projects"),
        None => return json!({ "available": false }),
    };
    if !projects.is_dir() {
        return json!({ "available": false });
    }

    let now = chrono::Utc::now().timestamp() as f64;
    // Look back far enough to cover a full weekly window (anchored up to ~7 days
    // back) plus slack for reconstructing the 5-hour blocks.
    let scan_from = now - 8.0 * 86400.0;

    let mut files = Vec::new();
    collect_recent_jsonl(&projects, scan_from, &mut files);

    // (timestamp, weighted-tokens) for every usage row in range.
    let mut entries: Vec<(f64, f64)> = Vec::new();
    for path in files {
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            // Cheap pre-filter: only the assistant turns carry a usage block.
            if !line.contains("\"usage\"") {
                continue;
            }
            let entry: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let usage = match entry.get("message").and_then(|m| m.get("usage")) {
                Some(u) if u.is_object() => u,
                _ => continue,
            };
            let ts = match entry.get("timestamp").and_then(|t| t.as_str()) {
                Some(s) => match chrono::DateTime::parse_from_rfc3339(s) {
                    Ok(dt) => dt.timestamp() as f64,
                    Err(_) => continue,
                },
                None => continue,
            };
            if ts < scan_from {
                continue;
            }
            let tok = |k: &str| usage.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let weighted = tok("input_tokens") * W_INPUT
                + tok("output_tokens") * W_OUTPUT
                + tok("cache_creation_input_tokens") * W_CACHE_CREATE
                + tok("cache_read_input_tokens") * W_CACHE_READ;
            entries.push((ts, weighted));
        }
    }
    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // --- 5-hour session block (matches Claude's "resets in …"): a block runs 5h
    // from its first turn, floored to the hour; a >=5h gap opens a new block. ---
    const FIVE_H: f64 = 5.0 * 3600.0;
    let floor_hour = |t: f64| (t / 3600.0).floor() * 3600.0;
    let mut block_start: Option<f64> = None;
    let mut last_ts = 0.0f64;
    for &(ts, _) in &entries {
        match block_start {
            None => block_start = Some(floor_hour(ts)),
            Some(bs) => {
                if ts - bs >= FIVE_H || ts - last_ts >= FIVE_H {
                    block_start = Some(floor_hour(ts));
                }
            }
        }
        last_ts = ts;
    }
    // The block is only "live" if its 5-hour window hasn't already elapsed.
    let active_start = block_start.filter(|bs| now < bs + FIVE_H);
    let h5: f64 = match active_start {
        Some(bs) => entries.iter().filter(|(t, _)| *t >= bs).map(|(_, w)| w).sum(),
        None => 0.0,
    };

    // --- Weekly window: from the calibrated reset anchor when we have one (so the
    // sum matches Claude's fixed weekly cycle), else a trailing 7 days. ---
    let week_from = weekly_reset
        .filter(|r| *r <= now && *r >= scan_from)
        .unwrap_or(now - 7.0 * 86400.0);
    let d7: f64 = entries.iter().filter(|(t, _)| *t >= week_from).map(|(_, w)| w).sum();

    json!({
        "available": true,
        "h5": h5,
        "d7": d7,
        "blockStart": active_start,
        "weekFrom": week_from,
        "now": now,
    })
}

/* --------------------- per-thread actions (compact/hint) ----------------- */

const COMPACT_PROMPT: &str = "Summarize our entire conversation so far into a tight but complete brief I can use to keep working with no loss of important context. Include: key facts, decisions made, current state of the work, open questions, and next steps. Use short bullet points. Do not greet or add commentary — just the brief.";

#[tauri::command]
pub async fn compact_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let session_id = meta.session_id.clone().ok_or("nothing to compact yet")?;
    let sys = state.sys_prompt();
    let mut args = claude::base_args(&meta.model, &sys);
    args.push("--resume".into());
    args.push(session_id);

    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, COMPACT_PROMPT).await?;
    {
        let conn = state.db.lock().unwrap();
        db::compact(&conn, &id, &text);
    }
    Ok(json!({ "ok": true, "summary": text }))
}

const HINT_PROMPT: &str = "You are a warm, plain-spoken usage coach for a NON-TECHNICAL person using a Claude chat app. Below is their recent conversation. If — and only if — you notice a SPECIFIC, concrete way they could get better results (e.g. giving a detail or file Claude clearly needed, being clearer about the goal, or splitting a big request), reply with ONE short friendly tip of 1–2 sentences, no jargon. If they are already communicating well, reply with exactly: ALL_GOOD. Never invent problems or nitpick.\n\n--- conversation ---\n";

#[tauri::command]
pub async fn hint_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let recent = {
        let conn = state.db.lock().unwrap();
        db::recent_messages(&conn, &id, 8)
    };
    let joined = recent
        .iter()
        .map(|(role, text)| {
            let who = if role == "user" { "User" } else { "Claude" };
            format!("{who}: {text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if joined.trim().is_empty() {
        return Ok(json!({ "tip": "", "allGood": true }));
    }

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys); // fresh session — won't pollute the chat
    let prompt = format!("{HINT_PROMPT}{joined}");
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, &prompt).await?;

    let all_good = text.to_uppercase().contains("ALL_GOOD") || text.trim().is_empty();
    Ok(json!({
        "tip": if all_good { String::new() } else { text.trim().to_string() },
        "allGood": all_good,
    }))
}

/* --------------------------- Initialize wizard --------------------------- */

// The analyze prompt is built per-run so we can fold in the user's short
// description of the project (the "brief"), entered before any exploration.
// It is deliberately domain-agnostic: the project could be writing, research,
// code, data, design, admin — anything. Claude infers the type and language
// from the folder and the brief rather than us assuming them.
fn analyze_prompt(brief: &str) -> String {
    let intro = if brief.trim().is_empty() {
        String::new()
    } else {
        format!(
            "The person who works here described the project in their own words:\n\"\"\"\n{}\n\"\"\"\nUse this as your starting point, but verify and enrich it against what is actually in the folder.\n\n",
            brief.trim()
        )
    };
    format!(
        r#"You are setting up a project memory file (CLAUDE.md) for whoever works in this folder. CLAUDE.md is loaded automatically at the start of every future chat here, so it should capture whatever a helper needs to be useful from the first message.

{intro}First, EXPLORE this folder thoroughly with your tools: list files, read the most informative ones, and notice what KIND of project this is (writing, research, code, data, design, admin, mixed…), the language(s) used, the apparent goal, what already exists, and what is still missing. Do not change any files.

Then return a SINGLE JSON object (no prose, no code fence) shaped exactly like:
{{
  "title": "<short project title you inferred>",
  "summary": "<2-4 sentence plain-language description of what you found: type of project, languages, file types, how far along the work is>",
  "questions": [
    {{
      "id": "<short-kebab-id>",
      "question": "<one clear question>",
      "why": "<short reason this matters for the project>",
      "multi": false,
      "options": ["<premade answer 1>", "<premade answer 2>", "<premade answer 3>"],
      "allowCustom": true
    }}
  ]
}}

Rules:
- Detect the project's main language from the documents and the description, and write every question and option in THAT language. If it is genuinely unclear, default to Croatian.
- Do NOT assume the project type — adapt the questions to whatever you actually find.
- Ask 6 to 9 DEEP, project-SPECIFIC questions whose answers would make the CLAUDE.md genuinely useful. Pick whichever of these fit THIS project: the precise goal/scope, the kind of end result and its audience, the language Claude should reply in, the tone/voice, conventions to follow (citation style, code style, formatting…), how sources/inputs/files should be handled, key terminology or names to keep consistent, the current status and next steps, and any do/don't rules. Tailor them to what you actually saw — reference real files where useful.
- Give each question 3-5 realistic premade options grounded in what you found, and set "allowCustom": true so the user can type their own.
- Use "multi": true only for questions where several answers can sensibly apply together.
- Write neutrally: do not assume anything about the person (gender, profession, technical level) beyond what the folder and description actually show.
- If a CLAUDE.md already exists, take it into account and aim to improve it.
Return ONLY the JSON object."#
    )
}

fn draft_prompt(findings: &str, answers: &[Value], brief: &str) -> String {
    let qa = answers
        .iter()
        .map(|a| {
            let q = a.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let ans = match a.get("answer") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            format!("Q: {q}\nA: {ans}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let findings = if findings.trim().is_empty() { "(no summary)" } else { findings };
    let brief_block = if brief.trim().is_empty() {
        String::new()
    } else {
        format!("How the project was described:\n\"\"\"\n{}\n\"\"\"\n\n", brief.trim())
    };

    format!(
        r###"Write a CLAUDE.md project-memory file for whoever works in this folder, based on what you found and the answers below.

{brief_block}What you found earlier:
{findings}

Answers:
{qa}

Produce the CLAUDE.md CONTENT ONLY (GitHub-flavoured markdown, no surrounding code fence, no commentary before or after). Make it a practical brief that a helper reads at the start of every future chat in this folder. Guidelines:
- Write it in the project's main language (match the documents and answers; if it is Croatian, keep č/ć/ž/š/đ in UTF-8).
- Lead with a short overview section: what the project is, the kind of end result, and the audience/goal.
- Add focused sections that reflect the answers — only the ones that apply, e.g.: language & style, tone/voice, conventions (citations, code style, formatting), how sources/inputs are handled, structure, current status & next steps, terminology/glossary, and clear "do this / avoid this" rules.
- If Word (.docx) documents are in play, include a short note that Claude can read and write .docx (via pandoc / python-docx) and should preserve formatting.
- Be specific and concise — bullet points over paragraphs. Do not invent facts that were not given; where something is unknown, say it plainly or leave a clear TODO.
- Write neutrally: do not assume the person's gender or profession.
Return ONLY the markdown content."###
    )
}

#[tauri::command]
pub async fn init_analyze(state: State<'_, AppState>, id: String, brief: Option<String>) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys);
    let prompt = analyze_prompt(brief.as_deref().unwrap_or(""));
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, &prompt).await?;

    match extract_json(&text) {
        Some(data) if data.get("questions").map(|q| q.is_array()).unwrap_or(false) => Ok(data),
        _ => Ok(json!({ "error": "Could not read the project. Please try again." })),
    }
}

#[tauri::command]
pub async fn init_draft(
    state: State<'_, AppState>,
    id: String,
    summary: Option<String>,
    answers: Vec<Value>,
    brief: Option<String>,
) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys);
    let prompt = draft_prompt(summary.as_deref().unwrap_or(""), &answers, brief.as_deref().unwrap_or(""));
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, &prompt).await?;

    let md = strip_md_fence(text.trim());
    if md.trim().is_empty() {
        Ok(json!({ "error": "Draft came back empty. Please try again." }))
    } else {
        Ok(json!({ "markdown": md }))
    }
}

#[tauri::command]
pub fn init_save(state: State<'_, AppState>, id: String, markdown: String) -> CmdResult {
    if markdown.trim().is_empty() {
        return Err("nothing to save".into());
    }
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let target = std::path::Path::new(&meta.cwd).join("CLAUDE.md");
    if target.exists() {
        let _ = std::fs::copy(&target, target.with_file_name("CLAUDE.md.bak"));
    }
    let body = markdown.strip_prefix('\u{feff}').unwrap_or(&markdown);
    let clean = body.replace("\r\n", "\n").replace('\n', "\r\n");
    std::fs::write(&target, clean.as_bytes()).map_err(|e| e.to_string())?;

    Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
}

/// Read the project's current CLAUDE.md so the editor can load it. Missing file
/// is not an error — it just returns empty text (the editor can create it).
#[tauri::command]
pub fn read_claude_md(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let target = std::path::Path::new(&meta.cwd).join("CLAUDE.md");
    let markdown = std::fs::read_to_string(&target).unwrap_or_default();
    let body = markdown.strip_prefix('\u{feff}').unwrap_or(&markdown);
    Ok(json!({ "markdown": body.replace("\r\n", "\n"), "exists": target.exists() }))
}

/// Does this project folder already have a CLAUDE.md? Lets the welcome screen
/// decide whether its button reads "Initialize" or "Reinitialize" — no thread
/// needed, just the project path.
#[tauri::command]
pub fn claude_md_exists(cwd: String) -> Value {
    let exists = std::path::Path::new(&cwd).join("CLAUDE.md").exists();
    json!({ "exists": exists })
}

/* ---------------------------- Discord presence --------------------------- */

/// Turn Discord Rich Presence on or off. Off by default; the frontend persists
/// the user's choice and calls this on boot and whenever the toggle is flipped.
#[tauri::command]
pub fn set_discord_enabled(state: State<'_, AppState>, enabled: bool) -> Value {
    state.discord.set_enabled(enabled);
    json!({ "ok": true })
}

/// Update the project shown on the Discord card (`null` on the picker screen).
/// Only the project name is sent — never chat content or paths.
#[tauri::command]
pub fn discord_set_project(state: State<'_, AppState>, name: Option<String>) -> Value {
    state.discord.set_project(name);
    json!({ "ok": true })
}

/// Choose whether the project NAME is shown on the Discord card. When off,
/// presence still shows but with a generic label instead of the folder name.
#[tauri::command]
pub fn discord_set_share_name(state: State<'_, AppState>, enabled: bool) -> Value {
    state.discord.set_share_name(enabled);
    json!({ "ok": true })
}

/* ------------------------------- helpers --------------------------------- */

/// Strip a leading/trailing ```markdown fence around a draft, if present.
fn strip_md_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // drop an optional language tag on the first line
        let rest = match rest.find('\n') {
            Some(nl) => &rest[nl + 1..],
            None => rest,
        };
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    t.to_string()
}

/// Pull the first balanced JSON object/array out of a model reply (tolerates
/// ```json fences or a stray sentence before/after). Mirrors `extractJson`.
fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let s = strip_code_fence(trimmed);
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&c| c == b'{' || c == b'[')?;
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return serde_json::from_str(&s[start..=i]).ok();
            }
        }
        i += 1;
    }
    None
}

fn strip_code_fence(s: &str) -> &str {
    if let Some(a) = s.find("```") {
        let after = &s[a + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let after = after.trim_start();
        if let Some(b) = after.find("```") {
            return after[..b].trim();
        }
    }
    s
}
