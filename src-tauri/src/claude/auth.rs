//! Is anyone signed in, and signing in without a terminal.

use super::*;

/// How long `claude auth status` gets to answer before we stop waiting on it.
const AUTH_STATUS_SECS: u64 = 10;

/// Ask the CLI itself whether it is signed in (`claude auth status` prints JSON
/// carrying `loggedIn`). `None` when it gave no usable answer — a CLI too old to
/// know the subcommand, or one that hung — so the caller can fall back to guessing.
fn auth_status(bin: &str) -> Option<bool> {
    use std::io::Read;
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["auth", "status"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(AUTH_STATUS_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            _ => {
                kill_process_tree(child.id());
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let v: Value = serde_json::from_str(out.trim()).ok()?;
    v.get("loggedIn")?.as_bool()
}

/// Does this text read like the CLI saying nobody is signed in? (Its own wording
/// is "Not logged in · Please run /login".)
pub fn looks_logged_out(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("not logged in") || lower.contains("please run /login")
}

/// Is the user signed in to Claude Code? The CLI's own answer wins when it gives
/// one. The files below are only a fallback guess, and a poor one: the Claude
/// desktop app keeps its sign-in to itself yet leaves an account in
/// ~/.claude.json, so someone signed in *there* looked signed in *here*.
pub fn is_authenticated(bin: &str) -> bool {
    if let Some(logged_in) = auth_status(bin) {
        return logged_in;
    }
    if std::env::var("ANTHROPIC_API_KEY").map(|v| !v.is_empty()).unwrap_or(false) {
        return true;
    }
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return false,
    };
    if home.join(".claude").join(".credentials.json").exists() {
        return true;
    }
    // ~/.claude.json exists even before login (it stores config); only treat it
    // as "logged in" when it actually carries an account/token.
    if let Ok(txt) = std::fs::read_to_string(home.join(".claude.json")) {
        if txt.contains("oauthAccount") || txt.contains("\"accessToken\"") {
            return true;
        }
    }
    false
}

/// The in-app sign-in in flight, if any: `claude auth login` running with no
/// window of its own. Held so a pasted code can be written to it and so Cancel
/// (or a second attempt) can end it — it waits on the browser indefinitely.
#[derive(Default)]
pub struct LoginFlow {
    pid: std::sync::Mutex<Option<u32>>,
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
}

impl LoginFlow {
    /// End the sign-in in flight. A no-op when there is none.
    pub fn cancel(&self) {
        if let Some(pid) = self.pid.lock().unwrap().take() {
            kill_process_tree(pid);
        }
    }

    /// Hand the running sign-in the code the browser page showed.
    pub async fn send_code(&self, code: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("no sign-in is waiting for a code")?;
        stdin
            .write_all(format!("{}\n", code.trim()).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
}

/// Sign in without a terminal: run `<bin> auth login` hidden and let it do what
/// it does in one — open the browser and wait. It prints the sign-in link, sent
/// on as `{type:"url", url}` so the UI can reopen the page, and it reads a code
/// from stdin for the case where the browser shows one instead of returning by
/// itself (`LoginFlow::send_code`). Resolves when the CLI exits, however that
/// came about; whether the user is now signed in is for the caller to check.
pub async fn run_login(bin: &str, flow: &LoginFlow, channel: &Channel<Value>) -> Result<(), String> {
    flow.cancel();
    let mut cmd = Command::new(bin);
    cmd.args(["auth", "login"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the sign-in: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *flow.stdin.lock().await = child.stdin.take();
    *flow.pid.lock().unwrap() = child.id();

    // Race the output against the exit rather than reading to EOF: the browser
    // the CLI launches can inherit the pipe and hold it open long after.
    let mut lines = BufReader::new(stdout).lines();
    let status = loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some(at) = l.find("https://") {
                        let _ = channel.send(json!({ "type": "url", "url": l[at..].trim() }));
                    }
                }
                _ => break child.wait().await,
            },
            st = child.wait() => break st,
        }
    };
    flow.pid.lock().unwrap().take();
    flow.stdin.lock().await.take();
    status.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logged_out_notice_is_recognised() {
        assert!(looks_logged_out("Not logged in · Please run /login"));
        assert!(!looks_logged_out("{\"summary\":\"a login page\",\"questions\":[]}"));
    }
}
