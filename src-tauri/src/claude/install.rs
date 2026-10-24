//! Installing and updating Claude Code from inside the app, with the installer's
//! output streamed to the onboarding / update screens.

use super::*;

/// Run the official Windows installer for Claude Code, streaming every output
/// line to the frontend as `{type:"log", line}` so the onboarding screen can
/// show live progress. Resolves Ok on a clean exit.
pub async fn install_claude_code(channel: &Channel<Value>) -> Result<(), String> {
    let _ = channel.send(json!({ "type": "log", "line": "Downloading the Claude Code installer…" }));
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://claude.ai/install.ps1 | iex",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start the installer: {e}"))?;
    // The script downloads a couple of hundred MB without printing a thing, which
    // on a slow line is minutes of a spinner that looks hung. Watch the file it
    // is writing and report its size as `{type:"progress", mb}`.
    let progress = tokio::spawn(report_download_progress(channel.clone()));
    let result = stream_child_logs(child, channel).await;
    progress.abort();
    let (status, _log) = result?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "installer exited with code {}",
            status.code().unwrap_or(-1)
        ))
    }
}

/// Size in bytes of the binary the installer script is downloading into
/// `~/.claude/downloads` (0 when there is none).
fn installer_download_size() -> u64 {
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return 0,
    };
    let entries = match std::fs::read_dir(home.join(".claude").join("downloads")) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("claude-"))
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .max()
        .unwrap_or(0)
}

/// Tick once a second while the installer runs, sending the download's size
/// whenever it has grown. Runs until aborted.
async fn report_download_progress(channel: Channel<Value>) {
    // A leftover from an earlier attempt is not progress.
    let mut last = installer_download_size();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let size = installer_download_size();
        if size != last {
            last = size;
            if size > 0 {
                let _ = channel.send(json!({ "type": "progress", "mb": size / (1024 * 1024) }));
            }
        }
    }
}

/// How long to wait for a finished child's output pipes to close before giving
/// up on them (see `stream_child_logs`).
const PIPE_DRAIN_SECS: u64 = 3;

/// Stream a spawned child's stdout and stderr to the frontend as
/// `{type:"log", line}` (the shape the install/update panels render) and wait for
/// it to exit. Also hands back everything it printed, so a caller can tell *why*
/// a run failed instead of only that it did.
async fn stream_child_logs(
    mut child: Child,
    channel: &Channel<Value>,
) -> Result<(std::process::ExitStatus, String), String> {
    async fn pump<R>(reader: R, channel: Channel<Value>) -> String
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        let mut collected = String::new();
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let _ = channel.send(json!({ "type": "log", "line": line }));
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    }

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out_task = tokio::spawn(pump(stdout, channel.clone()));
    let err_task = tokio::spawn(pump(stderr, channel.clone()));

    let status = child.wait().await.map_err(|e| e.to_string())?;
    // The pipes only close once *every* process holding them has gone, and a
    // helper the child left running inherits them — so don't wait on them
    // forever after the child itself has exited.
    let drain = std::time::Duration::from_secs(PIPE_DRAIN_SECS);
    let mut log = String::new();
    for task in [out_task, err_task] {
        if let Ok(Ok(text)) = tokio::time::timeout(drain, task).await {
            log.push_str(&text);
        }
    }
    Ok((status, log))
}

/// Why an in-place `claude update` failed, and whether reinstalling straight from
/// npm is worth offering as a way around it.
pub struct UpdateFailure {
    pub message: String,
    /// The updater never got as far as downloading anything: it couldn't look up
    /// the latest version in the npm registry. That lookup is time-boxed inside
    /// the CLI, so a slow cold start trips it even while npm itself works fine —
    /// a plain `npm install -g` tends to sail through where it gave up.
    pub npm_fallback: bool,
}

/// Does this failure log read like the CLI's registry pre-check giving up?
fn looks_like_registry_check_failure(log: &str) -> bool {
    let lower = log.to_lowercase();
    lower.contains("unable to fetch latest version") || lower.contains("failed to check for updates")
}

/// Update Claude Code in place by running `<bin> update`, streaming every output
/// line to the frontend as `{type:"log", line}` (same shape as the installer) so
/// the Settings panel can show live progress. This is exactly what running
/// `claude update` in a terminal does — it checks for a newer release and, if
/// there is one, downloads and applies it. Resolves Ok on a clean exit.
pub async fn update_claude_code(bin: &str, channel: &Channel<Value>) -> Result<(), UpdateFailure> {
    let fatal = |message: String| UpdateFailure { message, npm_fallback: false };

    let _ = channel.send(json!({ "type": "log", "line": "Checking for Claude Code updates…" }));
    let mut cmd = Command::new(bin);
    cmd.arg("update")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| fatal(format!("could not start the updater: {e}")))?;

    let (status, log) = stream_child_logs(child, channel).await.map_err(fatal)?;
    if status.success() {
        Ok(())
    } else {
        Err(UpdateFailure {
            message: format!("updater exited with code {}", status.code().unwrap_or(-1)),
            npm_fallback: looks_like_registry_check_failure(&log),
        })
    }
}

/// True when Claude Code looks like a global npm package. Only then is
/// `npm install -g` the right repair — a native install would end up shadowed by
/// a second, conflicting copy.
pub fn is_npm_global_install(bin: &str) -> bool {
    if bin.replace('\\', "/").to_lowercase().contains("/npm/") {
        return true;
    }
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return false,
    };
    let txt = match std::fs::read_to_string(home.join(".claude.json")) {
        Ok(t) => t,
        Err(_) => return false,
    };
    serde_json::from_str::<Value>(&txt)
        .ok()
        .and_then(|v| v.get("installMethod").and_then(|m| m.as_str()).map(str::to_string))
        .map(|m| m == "global" || m.contains("npm"))
        .unwrap_or(false)
}

/// Reinstall Claude Code from npm — the fallback for when `claude update` can't
/// reach the registry to see what the latest version is. npm is a script shim
/// rather than a real executable on Windows (`npm.cmd`), so it has to be launched
/// through a shell. Streams npm's output like the other two.
pub async fn npm_install_claude_code(channel: &Channel<Value>) -> Result<(), String> {
    const NPM_LINE: &str = "npm install -g @anthropic-ai/claude-code@latest";
    let _ = channel.send(json!({ "type": "log", "line": format!("$ {NPM_LINE}") }));

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", NPM_LINE]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", NPM_LINE]);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start npm: {e}"))?;

    let (status, log) = stream_child_logs(child, channel).await?;
    if status.success() {
        return Ok(());
    }
    // npm's own last word is far more useful than the exit code (a missing npm
    // says so in plain English), so lead with it when there is one.
    let tail = log
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .to_string();
    Err(if tail.is_empty() {
        format!("npm exited with code {}", status.code().unwrap_or(-1))
    } else {
        format!("npm install failed: {tail}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_check_failure_is_recognised() {
        let log = "Current version: 2.1.238
Checking for updates to latest version...
Failed to check for updates
Unable to fetch latest version from npm registry";
        assert!(looks_like_registry_check_failure(log));
    }

    #[test]
    fn other_update_failures_are_not_offered_npm() {
        assert!(!looks_like_registry_check_failure(
            "Installing update...
Error: EPERM: operation not permitted"
        ));
        assert!(!looks_like_registry_check_failure(""));
    }
}
