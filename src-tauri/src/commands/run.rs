//! Running things: the composer's `$` shell escape and the project's RUN button.

use super::*;

/// Run a shell command directly in the thread's working directory — the `$`
/// escape hatch in the composer. Runs *outside* Claude (no session, no usage),
/// persists the result as a shell message, and returns it for immediate render.
#[tauri::command]
pub async fn run_shell(state: State<'_, AppState>, thread_id: String, command: String) -> CmdResult {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let cwd = {
        let conn = state.db();
        db::get_meta(&conn, &thread_id)
            .map(|m| m.cwd)
            .unwrap_or_default()
    };
    let (output, code) = claude::run_shell_capture(&trimmed, &cwd).await?;
    let saved = {
        let conn = state.db();
        db::add_shell_run(&conn, &thread_id, &trimmed, &output, code)
    };
    Ok(json!({
        "id": saved.get("id"),
        "ts": saved.get("ts"),
        "command": trimmed,
        "output": output,
        "code": code,
    }))
}

/* The RUN button: start a project locally for testing. Each project stores one
 * shell command (set by hand or detected by Claude); `run_app` spawns it in the
 * project folder, streams stdout+stderr line-by-line over a Channel, and tracks
 * the PID so `stop_run` can kill the (possibly long-running) process tree. */

/// The stored run command for a project, plus whether it is currently running.
#[tauri::command]
pub fn get_run_config(state: State<'_, AppState>, project: String) -> Value {
    let command = {
        let conn = state.db();
        db::get_run_command(&conn, &project)
    };
    let running = state.run_procs.lock().unwrap().contains_key(&project);
    json!({ "command": command, "running": running })
}

/// Save (or clear) a project's run command.
#[tauri::command]
pub fn set_run_config(state: State<'_, AppState>, project: String, command: String) -> Value {
    let conn = state.db();
    db::set_run_command(&conn, &project, command.trim());
    json!({ "ok": true })
}

/// Ask Claude to inspect the project and suggest the single command that starts
/// it locally for testing. Returns `{ command }` (may be empty if it can't tell).
#[tauri::command]
pub async fn detect_run_command(state: State<'_, AppState>, project: String) -> CmdResult {
    let sys = state.sys_prompt();
    let args = claude::base_args(models::DEFAULT_MODEL, &sys);
    let prompt = "Inspect THIS project folder (read package.json / Cargo.toml / pyproject.toml / \
        Makefile / README or whatever build files exist) and determine the single shell command a \
        developer would run to START this app LOCALLY for testing — e.g. a dev server, the main \
        entry point, or the run target. Prefer a hot-reloading dev command if one exists. \
        Reply with ONLY that one command on a single line: no explanation, no markdown, no backticks. \
        If you genuinely cannot tell, reply with an empty line.";
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &project, prompt).await?;
    let command = text
        .lines()
        .map(|l| l.trim().trim_matches('`').trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    Ok(json!({ "command": command }))
}

/// Start the project's app locally. If `command` is given it is used AND saved;
/// otherwise the stored command is used. Streams `{type:"start"|"line"|"exit"}`
/// events over `on_event` and resolves once the process exits (or is stopped).
#[tauri::command]
pub async fn run_app(
    state: State<'_, AppState>,
    project: String,
    command: Option<String>,
    on_event: Channel<Value>,
) -> CmdResult {
    // Resolve the command: an explicit one (persisted for next time), else stored.
    let command = {
        let conn = state.db();
        match command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
            Some(c) => {
                db::set_run_command(&conn, &project, &c);
                c
            }
            None => db::get_run_command(&conn, &project).unwrap_or_default(),
        }
    };
    if command.is_empty() {
        return Err("no run command set for this project".into());
    }
    if state.run_procs.lock().unwrap().contains_key(&project) {
        return Err("this project is already running".into());
    }

    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    cmd.current_dir(&project)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(claude::CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start: {e}"))?;
    let pid = child.id().unwrap_or(0);
    state
        .run_procs
        .lock()
        .unwrap()
        .insert(project.clone(), pid);
    let _ = on_event.send(json!({ "type": "start", "command": command, "pid": pid }));

    // Stream stdout + stderr as line events on their own tasks so a chatty app
    // never blocks the other stream. Both are forwarded into the same Channel.
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ch_out = on_event.clone();
    let out_task = tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut lines = BufReader::new(o).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_out.send(json!({ "type": "line", "text": line }));
            }
        }
    });
    let ch_err = on_event.clone();
    let err_task = tokio::spawn(async move {
        if let Some(e) = stderr {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_err.send(json!({ "type": "line", "stream": "err", "text": line }));
            }
        }
    });

    let status = child.wait().await;
    let _ = out_task.await;
    let _ = err_task.await;
    state.run_procs.lock().unwrap().remove(&project);
    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
    let _ = on_event.send(json!({ "type": "exit", "code": code }));
    Ok(json!({ "ok": true, "code": code }))
}

/// Stop a project's locally-running app, killing its whole process tree. The
/// `run_app` stream ends on its own once the process dies.
#[tauri::command]
pub async fn stop_run(state: State<'_, AppState>, project: String) -> Result<Value, String> {
    let pid = state.run_procs.lock().unwrap().get(&project).copied();
    if let Some(pid) = pid {
        // Off the main thread — killing a node/dev-server tree can take a moment.
        let _ = tokio::task::spawn_blocking(move || claude::kill_process_tree(pid)).await;
    }
    Ok(json!({ "ok": pid.is_some() }))
}
