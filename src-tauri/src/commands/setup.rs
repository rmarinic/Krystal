//! Getting Claude Code ready: the boot-time preflight, installing and updating
//! the CLI, signing in, and the app's own path and version.

use super::*;

/// Boot-time readiness check: is Claude Code installed, and is the user signed in?
#[tauri::command]
pub fn preflight(state: State<'_, AppState>) -> Value {
    readiness(&state)
}

/// The preflight answer. The binary's path was resolved when the app started, so
/// if that one doesn't run, look again before calling Claude Code missing — it
/// may have been installed (by hand, in a terminal) since — and adopt what's found.
fn readiness(state: &AppState) -> Value {
    let mut bin = state.claude_bin();
    let mut version = claude::claude_version(&bin);
    if version.is_none() {
        let resolved = claude::resolve_claude();
        if resolved != bin {
            version = claude::claude_version(&resolved);
            if version.is_some() {
                *state.claude_bin.lock().unwrap() = resolved.clone();
            }
            bin = resolved;
        }
    }
    json!({
        "installed": version.is_some(),
        "version": version,
        "authenticated": version.is_some() && claude::is_authenticated(&bin),
        "claudeBin": bin,
    })
}

/// Install Claude Code via the official PowerShell installer, streaming progress
/// to `on_event`. On success the resolved binary is adopted into AppState so the
/// rest of the app can use it without a restart. Returns the new preflight state.
#[tauri::command]
pub async fn install_claude(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    // Already there after all (installed since the app started)? Nothing to do.
    let ready = readiness(&state);
    if ready["installed"] == json!(true) {
        return Ok(ready);
    }
    claude::install_claude_code(&on_event).await?;
    // Re-resolve now that it should be on disk, and adopt the new path.
    Ok(readiness(&state))
}

/// Update the Claude Code CLI in place (the same as running `claude update` in a
/// terminal), streaming progress to `on_event`. Re-resolves afterwards and
/// reports the before/after versions so the UI can say whether anything changed.
#[tauri::command]
pub async fn update_claude(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    let bin = state.claude_bin();
    let before = claude::claude_version(&bin);
    if let Err(fail) = claude::update_claude_code(&bin, &on_event).await {
        // The CLI gave up looking the latest version up in the registry. On an
        // npm-managed install that is recoverable, so report it as a soft
        // failure and let the UI offer to reinstall through npm instead.
        if fail.npm_fallback && claude::is_npm_global_install(&bin) {
            return Ok(json!({
                "ok": false,
                "npmFallback": true,
                "error": fail.message,
                "before": before,
                "version": before,
                "updated": false,
                "claudeBin": bin,
            }));
        }
        return Err(fail.message);
    }
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

/// Reinstall the Claude Code CLI straight from npm — the fallback the UI offers
/// when `claude update`'s own registry check gives up. Same streaming shape and
/// same before/after reporting as `update_claude`.
#[tauri::command]
pub async fn update_claude_npm(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    let bin = state.claude_bin();
    let before = claude::claude_version(&bin);
    claude::npm_install_claude_code(&on_event).await?;
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

/// Sign in from inside the app: the CLI's own browser sign-in, run hidden (see
/// `claude::run_login`). Stays pending until the CLI finishes — or `cancel_login`
/// ends it — then returns the fresh preflight state.
#[tauri::command]
pub async fn start_login(state: State<'_, AppState>, on_event: Channel<Value>) -> CmdResult {
    let bin = state.claude_bin();
    claude::run_login(&bin, &state.login, &on_event).await?;
    Ok(readiness(&state))
}

/// Pass on the code the sign-in page showed, when it shows one.
#[tauri::command]
pub async fn submit_login_code(state: State<'_, AppState>, code: String) -> CmdResult {
    state.login.send_code(&code).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn cancel_login(state: State<'_, AppState>) -> Value {
    state.login.cancel();
    json!({ "ok": true })
}

/// The fallback for when the in-app sign-in doesn't work out.
/// Open a real terminal running `claude auth login`, which goes straight to
/// Anthropic's normal browser sign-in (bare `claude` only does that on a first
/// run — otherwise it sits at a prompt saying "run /login"). By full path, so it
/// works where `claude` isn't on the PATH. The UI re-checks via `preflight`.
#[tauri::command]
pub fn open_login(state: State<'_, AppState>) -> CmdResult {
    let bin = state.claude_bin();
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", "start", "Krystal — Claude login", "cmd", "/k", &bin, "auth", "login"]);
    cmd.spawn()
        .map_err(|e| format!("could not open the login window: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// Absolute path of the running executable. The self-updater uses it to detect
/// when the copy being launched isn't the one the installer updates (e.g. the app
/// runs from a custom/portable folder), so it can break the "re-installs the same
/// version on every launch" loop instead of looping forever. Empty if unknown.
#[tauri::command]
pub fn exe_path() -> String {
    crate::util::exe_path().unwrap_or_default()
}

/// The app's own version (compile-time, kept in sync with tauri.conf.json by the
/// release bump). Surfaced as the faint version label in the corner of the UI.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
