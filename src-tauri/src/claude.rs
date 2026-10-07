//! Claude Code CLI integration — spawning, streaming, prompt building.
//!
//! Ports the relevant pieces of server.js: capability probing, the system
//! prompt, base flags, prompt assembly, tool-pill detail, the streaming chat
//! run, and the one-off text run used by Compact / Hint / Initialize.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::artifacts;
use crate::session::{self, Decision, Session};
use crate::models::{
    self, is_safe_model_arg, model_name, ModelInfo, ORCH_BALANCED_MODEL, ORCH_DEEP_MODEL,
    ORCH_FAST_MODEL, SUB_MODEL_AUTO, TITLE_MODEL,
};

/* --------------------------- capabilities -------------------------------- */

#[derive(Clone, Copy)]
pub struct Caps {
    pub pandoc: bool,
    pub python_docx: bool,
}

/// Probe a capability by running a command and checking for a clean exit.
fn have(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn probe_caps() -> Caps {
    Caps {
        pandoc: have("pandoc", &["--version"]),
        python_docx: have("python", &["-c", "import docx"]),
    }
}

/// English name of a UI language code — used only as the *fallback* reply
/// language for a message too short to identify, never as an override.
pub fn lang_label(code: &str) -> &'static str {
    match code {
        "hr" => "Croatian (hrvatski)",
        _ => "English",
    }
}

/// System prompt appended on every turn.
///
/// This used to be forced onto a SINGLE line, because it was passed as a literal
/// command-line argument and Rust refuses to escape newlines into the Windows
/// `claude.cmd` batch shim. That constraint is gone: `spill_system_prompt` writes
/// the whole thing to a file and switches the flag to `--append-system-prompt-file`
/// before it ever reaches the CLI. So it is written the way instructions are
/// actually best read — short sections under headings, one rule per line.
///
/// `ui_lang` is the app's interface language ('en' | 'hr'); it only decides the
/// tie-break for messages that carry no language signal of their own.
pub fn capability_prompt(caps: Caps, ui_lang: &str) -> String {
    let mut p = String::new();

    p.push_str(
        "You are helping the user with the files and work in the current project folder.
         Read CLAUDE.md (if present) for what this project is about.

",
    );

    // The reply language used to be one clause tacked onto the CLAUDE.md line,
    // which lost every time the project's own files were written in another
    // language — an English opener could still come back in Croatian. It is now
    // its own section with a stated tie-break.
    p.push_str(&format!(
        "## Reply language
         Decide this before you write anything: reply in the SAME language as the user's LATEST message, judged from that message alone.
         The language of CLAUDE.md, of the project's files, folder names, earlier chats, or of the app's interface NEVER decides your reply language — if the user writes in English you answer in English even when everything around you is in another language, and vice versa.
         Only when a message carries no language signal at all (\"ok\", a bare path, a link, an emoji) do you keep the language of the last message that did; if there is none, use {}.
         When you write any file that may contain Croatian text, always use UTF-8 so diacritics (č, ć, ž, š, đ) are preserved exactly.

",
        lang_label(ui_lang)
    ));

    p.push_str(
        "## Choice cards
         When you want the user to choose between a few clear options, present a choice card instead of asking in prose: output a fenced code block tagged krystal-ask whose body is valid JSON of the form {\"questions\":[{\"question\":\"…\",\"header\":\"short label\",\"multiSelect\":false,\"options\":[{\"label\":\"…\",\"description\":\"…\"}]}]} — this app renders it as clickable cards with a custom-answer box.
         Emit that block as the very last thing in your reply and then STOP; the user's selection (or typed answer) arrives as their next message, so just continue naturally from it.
         Use it only for genuine forks where the choice changes what you do — never for routine questions.

",
    );

    // The process now survives between turns (see session.rs), so the old reason
    // for this rule — "your process is about to exit" — is no longer true. The rule
    // itself still is, for a different reason: Krystal renders exactly one reply per
    // message and stops listening at the turn's `result` event, so anything that
    // reports back later has nowhere to appear. It is also not guaranteed a session
    // survives: changing model/effort/mode, compacting, or going idle retires it.
    p.push_str(
        "## No background work
         IMPORTANT: this app shows exactly one reply per message and stops listening the moment your reply ends, so anything that reports back later has nowhere to appear. The session may also be restarted between messages.
         Never run Bash/PowerShell commands with run_in_background=true, and never launch background agents or tasks you intend to check later — you will not get to report what they found.
         Run long commands in the FOREGROUND with a generous timeout (up to 10 minutes) and wait for them inside the same reply; if something would take longer, break it into explicit steps the user triggers one reply at a time.

",
    );

    p.push_str("## Word documents
");
    if caps.pandoc {
        p.push_str(
            "Word documents (.docx) ARE supported via pandoc.
             To READ a .docx, run: pandoc 'file.docx' -t markdown (then read its text).
             To CREATE/replace a .docx from markdown, run: pandoc 'draft.md' -o 'out.docx'.
             A reference doc can carry styling: pandoc in.md -o out.docx --reference-doc=ref.docx.
",
        );
    }
    if caps.python_docx {
        p.push_str(
            "For SURGICAL edits that must preserve a .docx's existing formatting, use the python-docx library from a short python script (import docx) rather than pandoc.
",
        );
    }
    if !caps.pandoc && !caps.python_docx {
        p.push_str(
            "NOTE: Word (.docx) tooling is not installed, so you cannot open or write .docx files directly. If asked, tell the user to install pandoc and python-docx to enable Word support.
",
        );
    }

    p
}

/* --------------------------- resolving claude ---------------------------- */

const CLAUDE_CANDIDATES: [&str; 4] = ["claude.cmd", "claude.exe", "claude.bat", "claude"];

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Kill a process and its whole child tree. Used to interrupt a chat turn: the
/// `claude` launcher (claude.cmd → node) spawns children, so a plain kill of the
/// shim wouldn't stop the work — we kill the tree. Best-effort; never panics.
pub fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    }
}

/// Is a process with this PID still running? Used to verify the chat-turn PIDs we
/// track aren't stale (e.g. a turn that died without cleaning up). Best-effort —
/// shells out like the rest of this module rather than pulling in a winapi dep.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/NH", "/FI", &format!("PID eq {pid}")])
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        match cmd.output() {
            // A match prints a row containing the PID; no match prints an
            // "INFO: No tasks…" line that never contains it.
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Directories the official installers drop `claude` into that may NOT be on the
/// PATH of an already-running process (so we check them explicitly). Covers the
/// native installer (~/.local/bin, ~/.claude/local) and npm global (%APPDATA%/npm).
fn extra_claude_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join("bin"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    // `winget install Anthropic.ClaudeCode` links the exe here.
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
    }
    dirs
}

/// Find the claude executable. Honours $CLAUDE_BIN, then searches PATH and the
/// known installer locations for the usual variants. Falls back to bare "claude".
pub fn resolve_claude() -> String {
    if let Ok(p) = std::env::var("CLAUDE_BIN") {
        if !p.is_empty() && PathBuf::from(&p).exists() {
            return p;
        }
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        dirs.extend(path.split(sep).filter(|d| !d.is_empty()).map(PathBuf::from));
    }
    dirs.extend(extra_claude_dirs());
    for dir in dirs {
        for cand in CLAUDE_CANDIDATES {
            let p = dir.join(cand);
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    "claude".to_string()
}

/// Run `<bin> --version` and return the trimmed output if it succeeds. `None`
/// means Claude Code isn't actually installed / runnable at that path.
pub fn claude_version(bin: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Best-effort check that the user is signed in to Claude Code. True if an API
/// key is set, the credentials file exists, or ~/.claude.json carries an OAuth
/// account. Cheap and offline — the real verification is the first chat working.
pub fn is_authenticated() -> bool {
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

/* ------------------------------ arguments -------------------------------- */

/// Shared base flags for every claude invocation. `sys_prompt` must be a single
/// line (see capability_prompt). Mirrors `baseArgs` in server.js.
pub fn base_args(model: &str, sys_prompt: &str) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--dangerously-skip-permissions".into(),
        "--append-system-prompt".into(),
        sys_prompt.to_string(),
    ];
    // Always honour the caller's exact model selection. `model` reaches the CLI
    // as a real argv entry (never a shell string), so we forward *any* usable id
    // — including dynamic catalogue shapes we never hardcoded (see `catalog.rs`).
    // The only ids we can't pass are empty or whitespace/control-laden ones; if
    // one slips through we log it rather than silently drop `--model` and let the
    // CLI fall back to its own default (which would NOT be what the user picked).
    if is_safe_model_arg(model) {
        args.push("--model".into());
        args.push(model.to_string());
    } else if !model.is_empty() {
        eprintln!("krystal: refusing to forward malformed model id {model:?}; claude will use its default");
    }
    args
}

/// Apply a chat "mode" to freshly-built base args. `auto` keeps full power
/// (the default skip-permissions base). `plan` drops write access and asks
/// Claude to research and propose a plan instead of changing anything.
///
/// `ask` is the terminal's own behaviour: reading is free, and anything that
/// would change a file or run a command stops for a yes or no. In a terminal the
/// CLI draws that prompt itself; headless it has nobody to ask and would simply
/// refuse — unless a *host* answers, which is what `--permission-prompt-tool
/// stdio` sets up: each prompt arrives as a `control_request` on stdout and is
/// answered on stdin (see `permission_prompt` and `session.rs`). The CLI still
/// decides *what* needs asking, so the user's own allow/deny rules in
/// `.claude/settings*.json` apply here exactly as they do in a terminal.
///
/// `default` rather than leaving the mode unset: a `defaultMode` in the user's
/// settings would otherwise decide what a mode called "Ask" means.
pub fn apply_mode(args: &mut Vec<String>, mode: &str) {
    match mode {
        "plan" => {
            args.retain(|a| a != "--dangerously-skip-permissions");
            args.push("--permission-mode".into());
            args.push("plan".into());
        }
        "ask" => {
            args.retain(|a| a != "--dangerously-skip-permissions");
            args.push("--permission-mode".into());
            args.push("default".into());
            args.push("--permission-prompt-tool".into());
            args.push("stdio".into());
        }
        _ => {}
    }
}

/* ---------------------------- permission prompts ------------------------- */

/// Is this prompt about Krystal's own plumbing rather than the user's project?
///
/// A few things Claude does in a turn are Krystal's doing, not the user's: it
/// calls the artifact tool Krystal handed it, ticks a line off the task snapshot
/// Krystal asked it to keep current, reads an attachment Krystal saved and told
/// it to Read. All of those live outside the project folder, so the CLI would ask
/// about each one — a question the user can't make sense of ("allow editing
/// `cfcc4acf….md`?") about a file they never chose. Those are answered here.
///
/// Deliberately narrow: only the file tools, only inside the folders in
/// `own_dirs`, and never by way of a `..` hop. Anything else — a shell command
/// that happens to mention one of those paths included — is still asked.
pub fn is_own_business(tool: &str, input: &Value, own_dirs: &[PathBuf]) -> bool {
    if tool == artifacts::TOOL_NAME {
        return true;
    }
    if !matches!(tool, "Read" | "Edit" | "Write" | "MultiEdit") {
        return false;
    }
    let Some(path) = input.get("file_path").and_then(|v| v.as_str()) else {
        return false;
    };
    // Compared as text, not resolved: the file may not exist yet, and Windows
    // paths arrive in either slash and any case.
    let norm = |p: &str| p.replace('\\', "/").to_lowercase();
    let path = norm(path);
    if path.split('/').any(|part| part == "..") {
        return false;
    }
    own_dirs.iter().any(|dir| {
        let dir = norm(&dir.to_string_lossy());
        let dir = dir.trim_end_matches('/');
        !dir.is_empty() && path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
    })
}

/// What "always allow" would do for this prompt, in a shape the UI can put into
/// words. The CLI proposes the rule itself (`permission_suggestions`) — a command
/// prefix to stop asking about, a switch to accepting edits for the session, a
/// folder to trust — and applies it if we hand it back; this is only the
/// description of that, so the button can say what it is agreeing to.
fn permission_always(request: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(list) = request.get("permission_suggestions").and_then(|v| v.as_array()) else {
        return out;
    };
    for s in list {
        let scope = s.get("destination").and_then(|v| v.as_str()).unwrap_or("");
        match s.get("type").and_then(|v| v.as_str()) {
            Some("addRules") => {
                for r in s.get("rules").and_then(|v| v.as_array()).into_iter().flatten() {
                    let tool = r.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
                    let rule = r.get("ruleContent").and_then(|v| v.as_str()).unwrap_or("");
                    out.push(json!({ "kind": "rule", "tool": tool, "text": rule, "scope": scope }));
                }
            }
            Some("setMode") => {
                let mode = s.get("mode").and_then(|v| v.as_str()).unwrap_or("");
                out.push(json!({ "kind": "mode", "text": mode, "scope": scope }));
            }
            Some("addDirectories") => {
                for d in s.get("directories").and_then(|v| v.as_array()).into_iter().flatten() {
                    if let Some(d) = d.as_str() {
                        out.push(json!({ "kind": "dir", "text": d, "scope": scope }));
                    }
                }
            }
            _ => out.push(json!({ "kind": "other", "text": "", "scope": scope })),
        }
    }
    out
}

/// The `permission` event for one `can_use_tool` request: what Claude wants to
/// do, in the same terms its action chip uses (`tool_detail`/`tool_change`), so
/// the prompt can show the command or the diff being agreed to rather than a
/// tool name and a shrug.
fn permission_prompt(request_id: &str, request: &Value) -> Value {
    let tool = request.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    let empty = json!({});
    let input = request.get("input").unwrap_or(&empty);
    let (detail, target) = tool_detail(tool, input);
    let mut msg = json!({
        "type": "permission",
        "id": request_id,
        "tool": tool,
        "always": permission_always(request),
    });
    if let Some(d) = detail {
        msg["detail"] = json!(cap_text(&d, 4000));
    }
    if let Some(t) = target {
        msg["target"] = json!(t);
    }
    // A shell command's own one-line explanation of itself, when it gave one.
    if tool == "Bash" {
        if let Some(why) = input.get("description").and_then(|v| v.as_str()) {
            msg["why"] = json!(take_chars(why, 300));
        }
    }
    if let Some(rich) = tool_change(tool, input) {
        for (k, v) in rich {
            msg[k] = v;
        }
    }
    // Which tool call in the transcript this is about.
    if let Some(id) = request.get("tool_use_id").and_then(|v| v.as_str()) {
        msg["toolUseId"] = json!(id);
    }
    msg
}

/// One control message from the CLI, mid-turn. Returns `true` when the event was
/// one of these (and so is not a transcript event for `route_event`).
///
/// * `control_request`/`can_use_tool` — a permission prompt. Krystal's own
///   plumbing is waved through; everything else is parked on the session and
///   shown to the user (`permission`).
/// * `control_cancel_request` — the CLI withdrew a prompt (the turn was stopped).
/// * our own `PERMISSION_ANSWERED` echo — somebody answered; every view watching
///   this turn drops the prompt (`permission_gone`), whichever one it was
///   answered from.
async fn handle_control(
    session: &Session,
    ev: &Value,
    own_dirs: &[PathBuf],
    channel: &Channel<Value>,
) -> bool {
    let id = ev.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
    match ev.get("type").and_then(|v| v.as_str()) {
        Some("control_request") => {
            let empty = json!({});
            let request = ev.get("request").unwrap_or(&empty);
            if request.get("subtype").and_then(|v| v.as_str()) != Some("can_use_tool") {
                // Hooks, SDK-side MCP, elicitation: things a host opts into and
                // we never did. Say so rather than leave the CLI waiting.
                let _ = session.refuse_control(id, "not supported by this host").await;
                return true;
            }
            let tool = request.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
            let input = request.get("input").unwrap_or(&empty);
            if is_own_business(tool, input, own_dirs) {
                let _ = session.respond_permission(id, request, Decision::Allow).await;
                return true;
            }
            session.hold_permission(id, request.clone());
            let _ = channel.send(permission_prompt(id, request));
            true
        }
        Some("control_cancel_request") => {
            session.drop_permission(id);
            let _ = channel.send(json!({ "type": "permission_gone", "id": id }));
            true
        }
        Some(session::PERMISSION_ANSWERED) => {
            let mut msg = json!({ "type": "permission_gone", "id": id });
            if let Some(d) = ev.get("decision") {
                msg["decision"] = d.clone();
            }
            let _ = channel.send(msg);
            true
        }
        _ => false,
    }
}

/// Flags that only make sense on a live chat turn, layered on top of `base_args`.
/// The internal one-off calls (naming a chat, drafting tasks, the Initialize
/// wizard) deliberately skip these: they are short, single-shot and disposable.
///
/// * `--effort` — reasoning depth (see `models::EFFORTS`). The biggest quality
///   lever after the model itself, and the one terminal Claude Code users have
///   had all along.
/// * `--fallback-model` — an overloaded primary model degrades to the next tier
///   instead of failing the turn outright. Print-mode only, which is all we run.
/// * `--autocompact auto` — let the CLI compact a conversation that outgrows its
///   window, natively and mid-turn. Krystal's own Compact button still exists for
///   when the *user* wants a reset; this is the safety net underneath it.
/// * `--prompt-suggestions` — asks the CLI to predict a sensible next message and
///   emit it as a `prompt_suggestion` event. It only fires once a conversation has
///   some history, and only when the model has a confident guess, so treat it as
///   a bonus rather than something the UI can count on.
/// Let a chat reach folders outside the project (`--add-dir`). A project is one
/// folder by default, which is the right default and the wrong limit: assets,
/// notes and a second repo routinely live somewhere else, and without this the
/// only way to include them is to make them the project.
///
/// Order is stable (oldest first, straight from the DB) because these args are
/// part of the session key — a reshuffled list would retire the warm process for
/// no reason. Blank entries are dropped rather than passed on as an empty flag.
pub fn apply_extra_dirs(args: &mut Vec<String>, dirs: &[String]) {
    for dir in dirs.iter().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        args.push("--add-dir".into());
        args.push(dir.to_string());
    }
}

/// Turn a chat invocation into a *session*: messages arrive as JSON lines on
/// stdin instead of one prompt followed by EOF, so the process serves every turn
/// of the chat rather than exiting after the first (see `session.rs`).
pub fn apply_session_flags(args: &mut Vec<String>) {
    args.push("--input-format".into());
    args.push("stream-json".into());
}

/// Hand the session Krystal's own artifact tool (see `artifacts.rs`). The CLI has
/// no Artifact tool of its own — that is something the *host* application
/// provides — so this is what makes `mcp__krystal__artifact` exist at all.
///
/// Deliberately not `--strict-mcp-config`: that would switch off any MCP servers
/// the user has configured for themselves, and adding a feature is no reason to
/// take theirs away.
pub fn apply_artifact_tool(args: &mut Vec<String>, config: &std::path::Path) {
    args.push("--mcp-config".into());
    args.push(config.to_string_lossy().to_string());
}

/// Appended to the system prompt when the artifact tool is available. The tool's
/// own description says what an artifact *is*; this says when Krystal wants one,
/// which is the part a tool schema can't express on its own.
pub const ARTIFACT_NOTE: &str = "ARTIFACTS. You have an artifact tool (mcp__krystal__artifact). Krystal shows an artifact in a panel beside the conversation, and the user can open it, keep it, or send the file to someone else — so it is the right home for anything that is a finished *thing* rather than an explanation: a page, a chart, a diagram, a poster, a report, a small app. Prefer it over a fenced code block whenever the user would plausibly want to look at the result rather than read the source, and over writing a file whenever the thing is for the user rather than for the project's codebase. Revise an existing artifact (same id) instead of making a near-duplicate. Everyday coding work — editing the project's own source files — still belongs in the repo, not in an artifact.";

pub fn apply_chat_flags(
    args: &mut Vec<String>,
    effort: &str,
    fallback: Option<&str>,
    suggestions: bool,
) {
    if models::is_valid_effort(effort) {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(chain) = fallback.filter(|c| !c.is_empty()) {
        args.push("--fallback-model".into());
        args.push(chain.into());
    }
    args.push("--autocompact".into());
    args.push("auto".into());
    if suggestions {
        args.push("--prompt-suggestions".into());
    }
}

/* ---------------------------- orchestrator ------------------------------- */

/// Everything a chat turn needs to run in orchestrator mode: the system-prompt
/// note that steers the orchestrator to delegate, plus the worker definitions
/// that note refers to, ready to hand straight to `claude --agents`.
///
/// The workers used to be `.md` files written into the user's real
/// `~/.claude/agents` and swept away again after the turn (with a pid-tagged
/// name so a crashed Krystal could be cleaned up later). `--agents` takes the
/// same definitions inline as JSON, which removes the whole file dance — and,
/// more importantly, lets the names be *stable*. A name that changed every turn
/// changed the appended system prompt every turn, which invalidated the prompt
/// cache on the very first block and made every orchestrated turn pay full
/// price for its prefix.
pub struct Orchestration {
    /// Appended to the system prompt for this turn. Multi-line is fine: the whole
    /// system prompt is spilled to a file before it reaches the CLI (see
    /// `spill_system_prompt`), so nothing here has to survive shell tokenizing.
    pub note: String,
    /// The `--agents` payload: a JSON object of `name -> {description, prompt, model}`.
    pub agents: String,
}

// NOTE: an earlier version of this mode also hard-blocked the orchestrator's own
// tools via `--disallowedTools`. Reverted: that deny is enforced CLI-wide, and
// Claude Code's built-in generic Task agent types (`general-purpose`, `claude`,
// …) share the parent's permission set — only a fully custom-defined agent (like
// our worker `.md` files) is exempt. The orchestrator doesn't reliably call the
// delegation tool with the exact custom worker name; when it drifted mid-turn,
// that call inherited the deny and came back completely toolless, sometimes
// stalling the whole turn. A silently-broken delegation is worse than the
// token-waste this mode exists to prevent, so enforcement is prompt-only again.

/// Shared prefix of every worker name we define, so a worker can never collide
/// with an agent the user defined themselves. Stable across turns — see the
/// prompt-cache note on `Orchestration`.
const WORKER_PREFIX: &str = "krystal-worker-";

/// Opening of the orchestrator note — how to call a worker at all.
///
/// The delegation tool is `Agent` in current Claude Code and was `Task` in older
/// builds; naming both keeps the note correct either way (see `tool_detail`,
/// which matches the same pair). Naming the wrong one is not harmless: the model
/// is being told to route all its work through a tool that doesn't exist, and
/// spends the turn hunting for it.
const ORCH_HEAD: &str = "\
ORCHESTRATOR MODE — you are the orchestrator for this turn, running on a premium model. You plan and delegate; cheaper worker sub-agents do the heavy lifting.

Delegate with the `Agent` tool (older builds name it `Task`), passing the worker's exact name as `subagent_type`. Never use `general-purpose`, `claude`, `Explore` or any other built-in agent type, and never omit it.";

/// The rest of the orchestrator note: what to keep, what to hand off, how to
/// size and brief a task, and when to stop delegating.
///
/// Deliberately NOT "delegate everything": a sub-agent starts from an empty
/// context, so spawning one for a single Read costs a full agent boot to save a
/// few hundred tokens, and a task needing a dozen look-ups becomes a dozen
/// serial boots — which is what made simple requests crawl. Targeted reads stay
/// with the orchestrator; the context hogs (bulk exploration, build/test output,
/// multi-file edits) are what actually get delegated.
const ORCH_RULES: &str = "\
Do yourself: understand the request, plan, targeted look-ups (Read/Grep/Glob when you already know the file or symbol), review what workers return, write the final answer.

Delegate: every file write or edit, every command/build/test run, every broad search or piece of research, and anything whose output would be long. Never edit a file yourself.

Size the task, don't micro-delegate. One Read or one Grep you already know the target of is faster done yourself — a worker boots into an empty context, so spawning one for a keystroke costs far more than it saves. Delegate work that takes several steps or would flood your context.

Every brief is a contract. State the objective, the files/paths and facts you already know (the worker is blind to this conversation), what \"done\" looks like, and the exact shape of the answer you want back. Thin briefs are the main way this mode fails.

Run 2–4 workers in parallel when the pieces are genuinely independent — one Agent call per piece, all in the same message. Never more than 5 at once, and never give two workers the same file: one file, one worker.

Keep coupled work whole. A single coherent change belongs to one worker; splitting it across a chain of workers loses information at every handoff.

Verify once per coherent change, not after every worker: one worker builds/compiles, runs the relevant tests, and reports failures verbatim.

Stop conditions. If a worker comes back blocked or wrong, re-dispatch at most once with a sharper brief, then do the rest yourself with your own tools. If the Agent tool errors or a worker returns nothing usable, do not retry in a loop — finish the job yourself. Delivering the user's result always outranks staying in delegation.";

/// Appended to the orchestrator note when the turn also runs in Plan mode.
///
/// Plan mode drops `--dangerously-skip-permissions` (see `apply_mode`), and a
/// sub-agent inherits its parent's permission context — so a worker told to edit
/// would stall on a permission prompt that nothing in a `-p` run can answer.
/// Keeping the workers read-only removes that dead end.
pub const ORCH_PLAN_NOTE: &str = "\
This turn also runs in Plan mode: nothing may be created, edited or deleted. Delegate reading, searching and research only, and say explicitly in every brief that the worker must not write anything — a worker that tries to write will stall waiting for a permission prompt nobody can answer. Finish by presenting the plan yourself.";

/// The worker brief. A sub-agent starts with a *fresh, isolated context* — it
/// cannot see the conversation — so the brief spells out how to work from the
/// delegation message alone, forbids delegating further (Claude Code lets
/// sub-agents nest by default, which turns one task into a tree), and gives it a
/// hard stop condition so a stuck worker returns instead of grinding.
const WORKER_BODY: &str = "\
You are a worker sub-agent. An orchestrator delegated exactly one task to you.

You start blind: you cannot see the user's conversation or anything the orchestrator has read. Work from your brief plus the project itself, and look things up rather than asking.

Do the whole task yourself with your full toolset. Do NOT delegate any part of it to another sub-agent.

If you changed anything, verify it before returning — build/compile it, run the relevant tests, or re-read what you edited — and report what you checked and what it said.

Stop condition: if the same approach fails twice, stop. Return what you learned, what you tried, and the exact error. Never grind on a failing loop, and never hand the task back as a question unless you are genuinely blocked.

Return a tight, self-contained report the orchestrator can act on directly: what you did, which files (and roughly which lines) you touched, what you verified, and anything it must know. No preamble, no restating the brief.";

/// One worker definition for the `--agents` payload. `model` pins the sub-agent's
/// model; the prompt is its (deliberately generic, full-tool) brief — we never
/// restrict a worker's toolset, so `tools` is left off and the worker inherits
/// everything.
fn worker_def(description: &str, model: &str) -> Value {
    json!({ "description": description, "prompt": WORKER_BODY, "model": model })
}

/// Delete worker `.md` files left in `~/.claude/agents` by a Krystal old enough
/// to have written them there (pre-`--agents`), including ones a crash left
/// behind. Called once at startup; the app never writes to that directory now,
/// so anything carrying our prefix is certainly ours and certainly stale.
pub fn sweep_legacy_worker_agents() {
    let Some(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok() else { return };
    let dir = PathBuf::from(home).join(".claude").join("agents");
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(WORKER_PREFIX) && name.ends_with(".md") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Resolve a model id's display name against the live catalogue, falling back
/// to the static name table (then the id itself) for anything not in the list.
fn resolve_model_name(catalog: &[ModelInfo], id: &str) -> String {
    catalog
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| model_name(id).to_string())
}

/// Pick the newest model of `tier` from the live catalogue (id + display name),
/// falling back to the given static id when the tier isn't present. This keeps
/// the orchestrator's Auto worker tiers in step with the dynamic model list
/// rather than pinning hardcoded ids.
fn pick_tier(catalog: &[ModelInfo], tier: &str, fallback: &str) -> (String, String) {
    match catalog.iter().find(|m| m.tier == tier) {
        Some(m) => (m.id.clone(), m.name.clone()),
        None => (fallback.to_string(), model_name(fallback).to_string()),
    }
}

/// Build the worker sub-agents for one orchestrator turn and the note that
/// steers the orchestrator to delegate to them. `sub_model` is a concrete model
/// id, or `auto` to offer a fast/balanced/deep trio (drawn from the live
/// `catalog`) the orchestrator picks from per task.
///
/// Nothing is written to disk and nothing can fail: the definitions ride along
/// on the turn's `--agents` flag and disappear with the process.
pub fn prepare_orchestration(sub_model: &str, catalog: &[ModelInfo]) -> Orchestration {
    let mut defs = serde_json::Map::new();

    let note = if sub_model == SUB_MODEL_AUTO {
        // Tiers track the live catalogue; the ORCH_* ids are only fallbacks.
        let (fast_id, fast_m) = pick_tier(catalog, "haiku", ORCH_FAST_MODEL);
        let (bal_id, bal_m) = pick_tier(catalog, "sonnet", ORCH_BALANCED_MODEL);
        let (deep_id, deep_m) = pick_tier(catalog, "opus", ORCH_DEEP_MODEL);
        let fast = format!("{WORKER_PREFIX}fast");
        let bal = format!("{WORKER_PREFIX}balanced");
        let deep = format!("{WORKER_PREFIX}deep");
        defs.insert(fast.clone(), worker_def("Fast, cheap worker for simple or mechanical delegated tasks.", &fast_id));
        defs.insert(bal.clone(), worker_def("Balanced worker for typical coding, analysis and writing tasks.", &bal_id));
        defs.insert(deep.clone(), worker_def("Most-capable worker, for genuinely hard reasoning tasks.", &deep_id));
        format!(
            "{ORCH_HEAD}

Your workers for this turn — pick the cheapest one that can do the job well:
             - `{fast}` ({fast_m}) — mechanical, fully-specified work.
             - `{bal}` ({bal_m}) — normal coding, analysis and writing. Your default.
             - `{deep}` ({deep_m}) — genuinely hard reasoning only.

{ORCH_RULES}",
        )
    } else {
        let name = format!("{WORKER_PREFIX}main");
        defs.insert(
            name.clone(),
            worker_def("Worker sub-agent for delegated tasks; runs on a cheaper model to conserve budget.", sub_model),
        );
        format!(
            "{ORCH_HEAD}

You have one worker for this turn: `{name}` (runs on {mname}). Every delegated task goes to it.

{ORCH_RULES}",
            mname = resolve_model_name(catalog, sub_model),
        )
    };

    Orchestration { note, agents: Value::Object(defs).to_string() }
}

/// True when `text` opens with a `/skill-name` invocation — the CLI reads one
/// only at the very start of a prompt, and only as a bare word ending the token
/// (`/code-review the login screen`). A path like `/usr/bin` or a lone `/` is
/// not one.
fn starts_with_slash_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else { return false };
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return false;
    }
    match rest[name.len()..].chars().next() {
        None => true,
        Some(c) => c.is_whitespace(),
    }
}

/// Assemble the message sent for one turn.
///
/// Everything but `text` is background: the task-list note, a compact seed, the
/// transcripts of #-referenced chats, the paths of attached files. `notes` used
/// to be appended to the system prompt and can't live there any more — the
/// system prompt is fixed when the session process starts, and the task list
/// changes whenever Claude ticks something off.
///
/// Background leads the message and is fenced off from the user's own words, so
/// it reads as standing context for what follows. The one exception is a message
/// that opens with `/skill-name`: the CLI only invokes a skill when the slash is
/// the first thing in the prompt, so putting anything ahead of it would quietly
/// demote the invocation to a line of prose. Those messages lead, and their
/// background follows.
pub fn build_prompt(
    text: &str,
    files: &[String],
    seed: Option<&str>,
    references: Option<&str>,
    notes: Option<&str>,
) -> String {
    let mut blocks: Vec<String> = Vec::new();
    if let Some(notes) = notes.filter(|n| !n.is_empty()) {
        blocks.push(notes.to_string());
    }
    if let Some(seed) = seed.filter(|s| !s.is_empty()) {
        blocks.push(format!(
            "Summary of our conversation so far (use it to continue seamlessly):\n{seed}"
        ));
    }
    if let Some(refs) = references.filter(|r| !r.is_empty()) {
        blocks.push(refs.to_string());
    }
    if !files.is_empty() {
        let mut b = String::from("Referenced files (read these as needed):");
        for f in files {
            b.push_str("\n- ");
            b.push_str(f);
        }
        blocks.push(b);
    }
    if blocks.is_empty() {
        return text.to_string();
    }
    let context = blocks.join("\n\n---\n\n");
    if starts_with_slash_command(text) {
        format!("{text}\n\n---\n\n{context}")
    } else {
        format!("{context}\n\n---\n\n{text}")
    }
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn base_name(p: &str) -> String {
    p.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(p).to_string()
}

/// Turn a tool's input into a short on-chip target + a full hover detail.
/// Mirrors `toolDetail` in server.js. Returns (detail, target).
fn tool_detail(name: &str, input: &Value) -> (Option<String>, Option<String>) {
    if !input.is_object() {
        return (None, None);
    }
    let str_of = |k: &str| input.get(k).and_then(|v| v.as_str());
    if let Some(path) = str_of("file_path").or_else(|| str_of("path")).or_else(|| str_of("notebook_path")) {
        return (Some(path.to_string()), Some(base_name(path)));
    }
    if name == "Bash" {
        if let Some(cmd) = str_of("command") {
            return (Some(cmd.to_string()), Some(take_chars(cmd, 36)));
        }
    }
    if name == "Grep" || name == "Glob" {
        if let Some(pat) = str_of("pattern") {
            let detail = match str_of("path") {
                Some(p) => format!("{pat} in {p}"),
                None => pat.to_string(),
            };
            return (Some(detail), Some(take_chars(pat, 28)));
        }
    }
    if name == "WebFetch" {
        if let Some(url) = str_of("url") {
            let host = url
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or(url)
                .to_string();
            return (Some(url.to_string()), Some(host));
        }
    }
    if name == "WebSearch" {
        if let Some(q) = str_of("query") {
            return (Some(q.to_string()), Some(take_chars(q, 28)));
        }
    }
    // Delegation. The CLI has shipped this tool under both names — `Agent` is the
    // current one, `Task` the older — so match either.
    if name == "Agent" || name == "Task" {
        if let Some(d) = str_of("description") {
            return (Some(d.to_string()), Some(take_chars(d, 28)));
        }
    }
    if name == "AskUserQuestion" {
        if let Some(first) = input.get("questions").and_then(|v| v.as_array()).and_then(|a| a.first()) {
            let q = first.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let header = first.get("header").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(q);
            return (Some(q.to_string()), Some(take_chars(header, 28)));
        }
    }
    if name == "ExitPlanMode" || name == "exit_plan_mode" {
        if let Some(p) = str_of("plan") {
            return (Some(p.to_string()), None);
        }
    }
    (None, None)
}

/// Curated rich detail for change-making tools: the before/after of an edit, or
/// the content of a write, so the action chip can reveal exactly what changed.
/// Returns `(key, value)` pairs to merge into the streamed/persisted segment.
/// Strings are capped so a big write can't bloat the transcript.
fn tool_change(name: &str, input: &Value) -> Option<Vec<(&'static str, Value)>> {
    const CAP: usize = 4000;
    let str_of = |k: &str| input.get(k).and_then(|v| v.as_str());
    match name {
        "Edit" => {
            let (o, n) = (str_of("old_string")?, str_of("new_string")?);
            Some(vec![(
                "edits",
                json!([{ "old": cap_text(o, CAP), "new": cap_text(n, CAP) }]),
            )])
        }
        "MultiEdit" => {
            let arr = input.get("edits").and_then(|v| v.as_array())?;
            let edits: Vec<Value> = arr
                .iter()
                .filter_map(|e| {
                    let o = e.get("old_string").and_then(|v| v.as_str())?;
                    let n = e.get("new_string").and_then(|v| v.as_str())?;
                    Some(json!({ "old": cap_text(o, CAP), "new": cap_text(n, CAP) }))
                })
                .collect();
            if edits.is_empty() {
                None
            } else {
                Some(vec![("edits", json!(edits))])
            }
        }
        "Write" => Some(vec![("content", json!(cap_text(str_of("content")?, CAP)))]),
        "NotebookEdit" => Some(vec![("content", json!(cap_text(str_of("new_source")?, CAP)))]),
        _ => None,
    }
}

/* ------------------------------ spawning --------------------------------- */

/// Temp file holding a spilled `--append-system-prompt` value. Removed on drop
/// (i.e. once the claude child has exited and the spawn fn returns).
pub struct SysPromptFile(Option<PathBuf>);

impl Drop for SysPromptFile {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Move an inline `--append-system-prompt <value>` onto disk and switch to
/// `--append-system-prompt-file <path>`.
///
/// Why: on Windows the resolved `claude` is usually a `claude.cmd` shim that
/// forwards its arguments via `%*`, which *re-tokenizes* them. Our system prompt
/// carries embedded quotes (the `krystal-ask` JSON example) and option-like
/// tokens (the pandoc hints `-t markdown` / `-o out.docx`); once re-split, a
/// stray `-t` reaches `claude` as an unknown option and the whole turn fails
/// with `error: unknown option '-t'`. Keeping the prompt off the command line
/// sidesteps the shim's quoting entirely. Falls back to the original args if the
/// file can't be written, so a temp-dir hiccup never blocks a chat.
pub fn spill_system_prompt(args: &[String]) -> (Vec<String>, SysPromptFile) {
    if let Some(i) = args.iter().position(|a| a == "--append-system-prompt") {
        if let Some(value) = args.get(i + 1) {
            // Unique per process + call; avoids Date/random (unavailable here)
            // while staying collision-free across concurrent streams.
            let seq = SYS_PROMPT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("krystal-sysprompt-{}-{}.txt", std::process::id(), seq));
            if std::fs::write(&path, value).is_ok() {
                let mut out = args.to_vec();
                out[i] = "--append-system-prompt-file".into();
                out[i + 1] = path.to_string_lossy().into_owned();
                return (out, SysPromptFile(Some(path)));
            }
        }
    }
    (args.to_vec(), SysPromptFile(None))
}

static SYS_PROMPT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn claude_command(bin: &str, args: &[String], cwd: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // Stream a sub-agent's own prose, not just its tool calls, so the Activity
        // panel and the agent inspector can show what a worker is *doing* instead
        // of sitting blank while it thinks (see `emit_agent_activity`). The env
        // form of `--forward-subagent-text`: older CLIs ignore it, where an
        // unknown flag would kill the turn.
        .env("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Don't flash a console window for the claude.cmd child on Windows.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Default)]
pub struct ChatResult {
    pub final_text: String,
    /// Ordered transcript of the turn: text blocks and tool actions, in the
    /// sequence they happened. Each entry is `{type:"text",text}` or
    /// `{type:"tool",name,target?,detail?}`. Persisted so the chat reloads with
    /// the full play-by-play (the "action chips") intact.
    pub segments: Vec<Value>,
    pub session_id: Option<String>,
    pub usage: Option<Value>,
    pub cost_usd: f64,
    pub is_error: bool,
    /// The main/orchestrator model for this turn (from the `init` event). Any
    /// assistant message on a *different* model is a delegated worker.
    pub main_model: Option<String>,
    /// Per-assistant-message token tally, keyed by message id so the duplicate
    /// emissions the CLI makes under `--include-partial-messages` are deduped
    /// (last write wins — the pair is identical). Value is `(model id, billable
    /// tokens)`, where billable = input + output + cache_creation (the cheap
    /// cache *reads* are excluded so the split reflects real work, not the
    /// orchestrator re-reading the resumed conversation). Summed per model into
    /// the orchestrator savings readout at end of turn.
    pub msg_usage: HashMap<String, (String, u64)>,
    /// Artifacts this turn created or revised, latest state per artifact. The
    /// content is read back off disk (the MCP server resolved it), never out of
    /// the conversation — see `artifacts.rs`.
    pub artifacts: Vec<Value>,
}

impl ChatResult {
    /// Append streamed text. Text that arrives after a tool action starts a new
    /// block, so "Let me do X" and "Let me do Y" never fuse into one line.
    fn push_text(&mut self, t: &str) {
        self.final_text.push_str(t);
        if let Some(last) = self.segments.last_mut() {
            if last.get("type").and_then(|v| v.as_str()) == Some("text") {
                let cur = last.get("text").and_then(|v| v.as_str()).unwrap_or("");
                last["text"] = json!(format!("{cur}{t}"));
                return;
            }
        }
        self.segments.push(json!({ "type": "text", "text": t }));
    }

    /// Append a tool action (ends the current text block).
    fn push_tool(&mut self, seg: Value) {
        self.segments.push(seg);
    }
}

/* ----------------------- ask-question (choice cards) --------------------- */

// Krystal renders multiple-choice "choice cards" from a tool segment carrying a
// `questions` array. The built-in `AskUserQuestion` tool is gated out of headless
// (`claude -p`) sessions, so instead we ask the model to emit a fenced
// ```krystal-ask block of JSON and rebuild that same segment here — keeping the
// feature working regardless of the CLI version. `AskParser` is a tiny state
// machine that lifts the block out of the streamed text so its raw JSON never
// flashes on screen before the card appears.
const ASK_OPEN: &str = "```krystal-ask";
const ASK_CLOSE: &str = "```";

/// Stream visible text to the live view and into the persisted transcript.
fn ask_emit_text(result: &mut ChatResult, channel: &Channel<Value>, t: &str) {
    if t.is_empty() {
        return;
    }
    result.push_text(t);
    let _ = channel.send(json!({ "type": "token", "text": t }));
}

/// The `questions` array of a parsed body — either `{"questions":[…]}` or the
/// bare `[…]` array itself.
fn questions_of(v: &Value) -> Option<Value> {
    v.get("questions")
        .cloned()
        .filter(|q| q.is_array())
        .or_else(|| if v.is_array() { Some(v.clone()) } else { None })
}

/// The `[ … ]` slice that starts at `from`, honouring strings and escapes so a
/// bracket inside an option's text can't close it early. None if it never closes.
fn balanced_array(s: &str, from: usize) -> Option<&str> {
    let b = s.as_bytes();
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for i in from..b.len() {
        let c = b[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[from..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Pull the `questions` array out of a ```krystal-ask block body. Accepts either
/// the full `{"questions":[…]}` object or a bare `[…]` array; returns None if the
/// body doesn't hold an array of questions.
///
/// A strict parse is tried first, then a lenient recovery: models do sometimes
/// close a long block one brace short, or trail a line of prose after the JSON.
/// The `questions` array itself is intact in both cases, so we lift it out on its
/// own rather than losing the whole card to a stray character.
fn parse_ask_questions(body: &str) -> Option<Value> {
    let body = body.trim();
    if let Some(q) = serde_json::from_str::<Value>(body).ok().as_ref().and_then(questions_of) {
        return Some(q);
    }
    let from = match body.find("\"questions\"") {
        Some(k) => k + body[k..].find('[')?,
        None => body.find('[')?,
    };
    let v: Value = serde_json::from_str(balanced_array(body, from)?).ok()?;
    // Only a real list of question objects — never a stray array of scalars.
    let ok = v
        .as_array()
        .is_some_and(|a| !a.is_empty() && a.iter().all(|q| q.is_object()));
    if ok { Some(v) } else { None }
}

/// Turn a captured ```krystal-ask body into the same `{questions}` tool segment the
/// frontend already knows how to render. On any parse failure, fall back to showing
/// the raw text so nothing the model wrote is ever lost.
fn ask_emit_question(result: &mut ChatResult, channel: &Channel<Value>, body: &str) {
    match parse_ask_questions(body) {
        Some(q) => {
            let first = q.as_array().and_then(|a| a.first());
            let qtext = first
                .and_then(|f| f.get("question"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let header = first
                .and_then(|f| f.get("header"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(qtext);
            let id = format!("ask-{}", result.segments.len());
            let msg = json!({
                "type": "tool",
                "name": "AskUserQuestion",
                "id": id,
                "detail": qtext,
                "target": take_chars(header, 28),
                "questions": q,
            });
            result.push_tool(msg.clone());
            let _ = channel.send(msg);
        }
        // Not the JSON we expected — show it verbatim rather than dropping it.
        None => ask_emit_text(result, channel, body),
    }
}

#[derive(Default)]
struct AskParser {
    /// Text held back: either a short tail that might begin the open marker, or
    /// the block body accumulating until its closing fence arrives.
    held: String,
    in_block: bool,
}

impl AskParser {
    /// Feed a chunk of streamed assistant text. Plain prose is forwarded
    /// immediately; a ```krystal-ask block is withheld, captured, and converted
    /// into a choice-card segment once its closing fence arrives.
    fn feed(&mut self, t: &str, result: &mut ChatResult, channel: &Channel<Value>) {
        self.held.push_str(t);
        loop {
            if self.in_block {
                if let Some(p) = self.held.find(ASK_CLOSE) {
                    let body = self.held[..p].to_string();
                    ask_emit_question(result, channel, &body);
                    self.held = self.held[p + ASK_CLOSE.len()..].to_string();
                    self.in_block = false;
                    continue;
                }
                return; // still buffering the block body
            }
            if let Some(p) = self.held.find(ASK_OPEN) {
                let before = self.held[..p].to_string();
                ask_emit_text(result, channel, &before);
                self.held = self.held[p + ASK_OPEN.len()..].to_string();
                self.in_block = true;
                continue;
            }
            // No marker yet — emit everything except a short trailing window that
            // could be the start of one split across the next delta.
            let keep = ASK_OPEN.len() - 1;
            if self.held.len() <= keep {
                return;
            }
            let mut cut = self.held.len() - keep;
            while cut > 0 && !self.held.is_char_boundary(cut) {
                cut -= 1;
            }
            let safe = self.held[..cut].to_string();
            ask_emit_text(result, channel, &safe);
            self.held = self.held[cut..].to_string();
            return;
        }
    }

    /// End of a text block / turn: release whatever is still held. An unterminated
    /// block is shown verbatim (with its opening fence) so nothing is lost.
    fn flush(&mut self, result: &mut ChatResult, channel: &Channel<Value>) {
        if self.held.is_empty() {
            self.in_block = false;
            return;
        }
        let leftover = std::mem::take(&mut self.held);
        if self.in_block {
            ask_emit_text(result, channel, &format!("{ASK_OPEN}{leftover}"));
            self.in_block = false;
        } else {
            ask_emit_text(result, channel, &leftover);
        }
    }
}

/// Remove any ```krystal-ask blocks from a finished answer string so the raw JSON
/// never leaks into a persisted/fallback transcript (the block becomes a card).
fn strip_ask_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find(ASK_OPEN) {
        out.push_str(&rest[..p]);
        let after = &rest[p + ASK_OPEN.len()..];
        match after.find(ASK_CLOSE) {
            Some(q) => rest = &after[q + ASK_CLOSE.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Run one turn on a warm session (see `session.rs`).
///
/// The old shape of this function was "spawn a process, read until it exits".
/// A session outlives the turn, so the loop now ends where the *turn* ends — at
/// the `result` event — and everything else about the process (its stdout reader,
/// its context, its session id) carries on to the next message.
///
/// A turn can therefore end three ways: the `result` arrives (normal, including a
/// turn the user interrupted, which the CLI reports as an errored result), the
/// event stream closes (the process died under us), or the caller drops us.
/// How often the half-written answer is flushed to the database mid-turn. Often
/// enough that closing the app loses at most a sentence, rare enough that a long
/// turn costs a handful of small writes rather than one per token.
const PARTIAL_SAVE_MS: u128 = 1200;

/// `on_partial` is handed the answer so far (text + transcript segments) on that
/// throttle, so an interrupted turn leaves something behind to come back to.
///
/// `own_dirs` are the folders Krystal keeps its own files in; in Ask mode a
/// permission prompt about one of those is answered here instead of being put to
/// the user (see `is_own_business`).
pub async fn run_turn(
    session: &Session,
    prompt: &str,
    channel: &Channel<Value>,
    running: &std::sync::Mutex<HashMap<String, u32>>,
    thread_id: &str,
    orchestrating: bool,
    artifact_dir: Option<&std::path::Path>,
    own_dirs: &[PathBuf],
    on_partial: &mut (dyn FnMut(&str, &[Value]) + Send),
) -> Result<ChatResult, String> {
    let mut events = session.begin_turn(prompt).await?;

    // Register the PID for the Activity panel's "running turns" list; `stop_chat`
    // interrupts through the session rather than killing this.
    running.lock().unwrap().insert(thread_id.to_string(), session.pid);

    let mut result = ChatResult::default();
    // index -> (tool name, accumulating input JSON, tool_use id)
    let mut tool_blocks: HashMap<i64, (String, String, String)> = HashMap::new();
    let mut ask = AskParser::default();
    // Sub-agent message ids already forwarded as live activity (dedupes the
    // repeats `--include-partial-messages` produces).
    let mut seen_agent_msgs: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Artifact tool calls waiting on their result: tool_use id -> artifact id.
    // The content isn't in the call we watch go by — it's what the MCP server
    // resolved and wrote to disk — so we pick it up when the result lands.
    let mut pending_artifacts: HashMap<String, String> = HashMap::new();
    let mut got_result = false;
    let mut last_save = std::time::Instant::now();
    let mut saved_len = 0usize;

    while let Some(ev) = events.recv().await {
        // Ask mode: the CLI stopping to ask permission (or taking the question
        // back). Not part of the transcript — the turn just waits here, still
        // reading, until `answer_permission` writes the reply on stdin.
        if handle_control(session, &ev, own_dirs, channel).await {
            continue;
        }
        let is_result = ev.get("type").and_then(|v| v.as_str()) == Some("result");
        route_event(
            &ev,
            &mut result,
            &mut tool_blocks,
            &mut ask,
            &mut seen_agent_msgs,
            artifact_dir,
            &mut pending_artifacts,
            channel,
        );
        if is_result {
            got_result = true;
            break;
        }
        // Keep the half-written answer on disk. Only when it actually grew, and
        // never more than once per `PARTIAL_SAVE_MS`.
        if result.final_text.len() != saved_len && last_save.elapsed().as_millis() >= PARTIAL_SAVE_MS
        {
            saved_len = result.final_text.len();
            last_save = std::time::Instant::now();
            on_partial(&result.final_text, &result.segments);
        }
    }
    running.lock().unwrap().remove(thread_id);
    // Whatever the turn was still asking, it can no longer be answered.
    session.clear_permissions();

    // Release anything the ask-block parser is still holding (e.g. a turn that
    // ended without a trailing text block to trigger the per-block flush).
    ask.flush(&mut result, channel);

    // Orchestrator turns: surface how the turn's tokens split between the premium
    // supervisor and the cheaper workers it delegated to.
    if orchestrating {
        emit_orchestration_summary(&mut result, channel);
    }

    // If the answer arrived only via the final `result` event (no streamed text
    // deltas), still expose it as one text segment so the transcript isn't empty.
    if result.segments.is_empty() && !result.final_text.trim().is_empty() {
        result.segments.push(json!({ "type": "text", "text": result.final_text.clone() }));
    }

    // No `result` means the stream ended early — the process died mid-turn. Say so
    // with whatever it wrote to stderr, the same way the old per-turn spawn did.
    if !got_result && result.final_text.is_empty() && !result.is_error {
        result.is_error = true;
        let errout = session.stderr_text();
        let msg = if errout.is_empty() {
            "the claude session ended unexpectedly".to_string()
        } else {
            errout
        };
        let _ = channel.send(json!({ "type": "error", "message": msg }));
    }
    Ok(result)
}

fn emit_agent_progress(ev: &Value, channel: &Channel<Value>) {
    let id = ev.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return;
    }
    let phase = match ev.get("subtype").and_then(|v| v.as_str()) {
        Some("task_started") => "started",
        _ => "progress",
    };
    let usage = ev.get("usage");
    let u = |k: &str| usage.and_then(|x| x.get(k)).and_then(|v| v.as_u64());
    let mut msg = json!({ "type": "agent_progress", "id": id, "phase": phase });
    if let Some(s) = ev.get("subagent_type").and_then(|v| v.as_str()) {
        msg["subagent"] = json!(s);
    }
    if let Some(d) = ev.get("description").and_then(|v| v.as_str()) {
        msg["description"] = json!(d);
    }
    if let Some(t) = ev.get("last_tool_name").and_then(|v| v.as_str()) {
        msg["lastTool"] = json!(t);
    }
    if let Some(n) = u("tool_uses") {
        msg["toolUses"] = json!(n);
    }
    if let Some(n) = u("total_tokens") {
        msg["tokens"] = json!(n);
    }
    if let Some(n) = u("duration_ms") {
        msg["durationMs"] = json!(n);
    }
    let _ = channel.send(msg);
}

/// Forward what a sub-agent is *saying and doing* right now as `agent_activity`
/// lines, keyed by the parent Task's `tool_use_id` so the Task's action chip can
/// show a live log instead of sitting blank until the worker returns.
///
/// A delegated worker's own assistant messages come back through the same stream
/// tagged with `parent_tool_use_id`; each content block becomes one line (its
/// prose, or the tool it just reached for). Live-only — nothing here is
/// persisted; the Task's final output still lands via its `tool_result`.
fn emit_agent_activity(
    parent: &str,
    ev: &Value,
    seen: &mut std::collections::HashSet<String>,
    channel: &Channel<Value>,
) {
    let msg = match ev.get("message") {
        Some(m) => m,
        None => return,
    };
    // `--include-partial-messages` emits the consolidated assistant message more
    // than once; the message id makes those repeats free to drop.
    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
        if !seen.insert(format!("{parent}:{id}")) {
            return;
        }
    }
    let blocks = match msg.get("content").and_then(|c| c.as_array()) {
        Some(a) => a,
        None => return,
    };
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                let t = block.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                if t.is_empty() {
                    continue;
                }
                let _ = channel.send(json!({
                    "type": "agent_activity", "id": parent,
                    "kind": "text", "text": take_chars(t, 600),
                }));
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let (detail, target) = tool_detail(name, &input);
                let mut line = json!({
                    "type": "agent_activity", "id": parent,
                    "kind": "tool", "tool": name,
                });
                if let Some(t) = target {
                    line["target"] = json!(t);
                }
                if let Some(d) = detail {
                    line["detail"] = json!(take_chars(&d, 300));
                }
                let _ = channel.send(line);
            }
            _ => {}
        }
    }
}

/// Build the orchestrator savings readout from the per-model token tally and
/// both persist it (as an `orchestration` segment, replayed into the Activity
/// panel on reload) and stream it live. No-op unless the turn actually delegated
/// — i.e. some tokens ran on a model other than the orchestrator's.
fn emit_orchestration_summary(result: &mut ChatResult, channel: &Channel<Value>) {
    let main = match &result.main_model {
        Some(m) => m.clone(),
        None => return,
    };
    // Fold the per-message tally into a per-model total.
    let mut per_model: HashMap<String, u64> = HashMap::new();
    for (model, toks) in result.msg_usage.values() {
        *per_model.entry(model.clone()).or_insert(0) += toks;
    }
    let orch_tokens = per_model.get(&main).copied().unwrap_or(0);
    let mut workers: Vec<(String, u64)> = per_model
        .iter()
        .filter(|(m, _)| **m != main)
        .map(|(m, t)| (m.clone(), *t))
        .collect();
    let worker_tokens: u64 = workers.iter().map(|(_, t)| t).sum();
    // Nothing was delegated (or every worker shared the orchestrator's model):
    // there's no split worth showing.
    if worker_tokens == 0 {
        return;
    }
    workers.sort_by(|a, b| b.1.cmp(&a.1)); // heaviest worker first
    let total = orch_tokens + worker_tokens;
    let worker_pct = ((worker_tokens as f64 / total as f64) * 100.0).round() as u64;

    let summary = json!({
        "type": "orchestration",
        "orchestrator": { "model": main, "name": model_name(&main), "tokens": orch_tokens },
        "workers": workers
            .iter()
            .map(|(m, t)| json!({ "model": m, "name": model_name(m), "tokens": t }))
            .collect::<Vec<_>>(),
        "orchestratorTokens": orch_tokens,
        "workerTokens": worker_tokens,
        "totalTokens": total,
        "workerPct": worker_pct,
    });
    // Persist with the turn so it rebuilds on reload; renderSegments ignores the
    // unknown type, so it never leaks into the transcript.
    result.push_tool(summary.clone());
    let _ = channel.send(summary);
}

/// Flatten a tool_result's `content` (a string, or an array of text blocks)
/// into plain text — the shell/sub-agent output we surface in the Activity panel.
fn tool_result_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            let mut out = String::new();
            for b in a {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Cap a string to `cap` characters, appending a truncation marker if it had to
/// be cut, so a chatty tool can't bloat the saved transcript.
fn cap_text(s: &str, cap: usize) -> String {
    if s.chars().count() > cap {
        let mut t: String = s.chars().take(cap).collect();
        t.push_str("\n… (truncated)");
        t
    } else {
        s.to_string()
    }
}

/// Attach a tool's captured output to its segment (so it persists) and stream a
/// `tool_result` event to the live view. Applied to every tool so its action
/// chip can be expanded to reveal what it did; capped to keep transcripts lean.
fn attach_output(
    result: &mut ChatResult,
    id: &str,
    output: &str,
    is_error: bool,
    channel: &Channel<Value>,
) {
    let capped = cap_text(output, 4000);
    let mut matched = false;
    for seg in result.segments.iter_mut() {
        if seg.get("id").and_then(|v| v.as_str()) == Some(id) {
            seg["output"] = json!(capped.clone());
            if is_error {
                seg["isError"] = json!(true);
            }
            matched = true;
            break;
        }
    }
    if matched {
        let _ = channel.send(
            json!({ "type": "tool_result", "id": id, "output": capped, "isError": is_error }),
        );
    }
}

/// Read a just-resolved artifact off disk, remember it on the turn (so the
/// caller can persist it) and stream it to the panel. Called once per artifact
/// tool result — a turn that patches one ten times publishes ten times, each
/// carrying the whole document, which is what makes the panel update live.
fn publish_artifact(
    result: &mut ChatResult,
    dir: &std::path::Path,
    art_id: &str,
    channel: &Channel<Value>,
) {
    let Some((content, title, kind)) = artifacts::read_current(dir, art_id) else {
        return;
    };
    let payload = json!({
        "type": "artifact",
        "artId": art_id,
        "title": title,
        "kind": kind,
        "content": content,
    });
    // One entry per artifact, holding its latest state: a turn's tenth patch
    // replaces the ninth rather than queueing behind it.
    match result
        .artifacts
        .iter_mut()
        .find(|a| a.get("artId").and_then(|v| v.as_str()) == Some(art_id))
    {
        Some(slot) => *slot = payload.clone(),
        None => result.artifacts.push(payload.clone()),
    }
    let _ = channel.send(payload);
}

#[allow(clippy::too_many_arguments)]
fn route_event(
    ev: &Value,
    result: &mut ChatResult,
    tool_blocks: &mut HashMap<i64, (String, String, String)>,
    ask: &mut AskParser,
    seen_agent_msgs: &mut std::collections::HashSet<String>,
    artifact_dir: Option<&std::path::Path>,
    pending_artifacts: &mut HashMap<String, String>,
    channel: &Channel<Value>,
) {
    let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "system" if ev.get("subtype").and_then(|v| v.as_str()) == Some("init") => {
            if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                result.session_id = Some(sid.to_string());
            }
            // The turn's main model — the orchestrator when that mode is on.
            if let Some(m) = ev.get("model").and_then(|v| v.as_str()) {
                result.main_model = Some(m.to_string());
            }
            // The authoritative list of `/skill-name` commands this session can
            // run — including the ones built into the CLI binary, which exist
            // nowhere on disk for `skills::scan` to find. Forwarded so the
            // composer's `/` picker can learn them (see src/app/skills.js).
            let skills = ev
                .get("skills")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let _ = channel.send(json!({
                "type": "start",
                "sessionId": result.session_id,
                "skills": skills,
            }));
        }
        // A predicted next message for the user (`--prompt-suggestions`). The CLI
        // only offers one once a conversation has some history, and only when it
        // has a confident guess, so this arrives on some turns and not others —
        // the UI treats it as a bonus chip, never as something it waits for.
        "prompt_suggestion" => {
            if let Some(t) = ev.get("suggestion").and_then(|v| v.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    let _ = channel.send(json!({ "type": "suggestion", "text": t }));
                }
            }
        }
        // Live sub-agent progress: while a Task runs, the CLI streams what the
        // worker is doing (its evolving description, the tool it last used, and a
        // running step/token/duration tally), keyed by the Task's `tool_use_id` —
        // the same id our Activity chip carries. Forwarded so the panel can show
        // it live instead of a blank "Running…".
        "system"
            if matches!(
                ev.get("subtype").and_then(|v| v.as_str()),
                Some("task_started") | Some("task_progress") | Some("task_updated")
            ) =>
        {
            emit_agent_progress(ev, channel);
        }
        // Consolidated assistant message: carries `model` + `usage`. Worker
        // sub-agents surface here tagged with their own (cheaper) model, so this
        // is where we attribute tokens for the orchestrator savings readout.
        "assistant" => {
            // A delegated worker's messages carry the parent Task's tool_use id —
            // stream them on as live activity for that Task's chip.
            if let Some(parent) = ev.get("parent_tool_use_id").and_then(|v| v.as_str()) {
                if !parent.is_empty() {
                    emit_agent_activity(parent, ev, seen_agent_msgs, channel);
                }
            }
            if let Some(msg) = ev.get("message") {
                let model = msg.get("model").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(u) = msg.get("usage") {
                    let tok = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                    let billable = tok("input_tokens")
                        + tok("output_tokens")
                        + tok("cache_creation_input_tokens");
                    if !model.is_empty() && billable > 0 {
                        // Dedupe by message id (duplicated under partial-messages);
                        // fall back to a positional key if the id is ever missing.
                        let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let key = if id.is_empty() {
                            format!("_{}", result.msg_usage.len())
                        } else {
                            id.to_string()
                        };
                        result.msg_usage.insert(key, (model.to_string(), billable));
                    }
                }
            }
        }
        "stream_event" => {
            let e = match ev.get("event") {
                Some(e) => e,
                None => return,
            };
            let etype = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let index = e.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            match etype {
                "content_block_start"
                    if e.get("content_block").and_then(|c| c.get("type")).and_then(|v| v.as_str())
                        == Some("tool_use") =>
                {
                    let cb = e.get("content_block");
                    let name = cb
                        .and_then(|c| c.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let id = cb
                        .and_then(|c| c.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    tool_blocks.insert(index, (name.clone(), String::new(), id.clone()));
                    let _ = channel.send(json!({ "type": "tool", "name": name, "id": id }));
                }
                "content_block_delta" => {
                    let delta = e.get("delta");
                    let dtype = delta.and_then(|d| d.get("type")).and_then(|v| v.as_str()).unwrap_or("");
                    match dtype {
                        "input_json_delta" => {
                            if let Some(tb) = tool_blocks.get_mut(&index) {
                                if let Some(pj) =
                                    delta.and_then(|d| d.get("partial_json")).and_then(|v| v.as_str())
                                {
                                    tb.1.push_str(pj);
                                }
                            }
                        }
                        "text_delta" => {
                            if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|v| v.as_str()) {
                                // Run text through the ask-block parser: plain prose
                                // streams straight through; a ```krystal-ask block is
                                // captured and turned into a choice card instead.
                                ask.feed(t, result, channel);
                            }
                        }
                        "thinking_delta" => {
                            if let Some(t) =
                                delta.and_then(|d| d.get("thinking")).and_then(|v| v.as_str())
                            {
                                let _ = channel.send(json!({ "type": "thinking", "text": t }));
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    if let Some((name, jsonbuf, id)) = tool_blocks.remove(&index) {
                        let input: Value = serde_json::from_str(if jsonbuf.is_empty() { "{}" } else { &jsonbuf })
                            .unwrap_or_else(|_| json!({}));
                        let (detail, target) = tool_detail(&name, &input);
                        let mut msg = json!({ "type": "tool", "name": name });
                        if !id.is_empty() {
                            // carried so the Activity panel can match the tool's
                            // later output (tool_result) back to this action.
                            msg["id"] = json!(id);
                        }
                        if let Some(d) = detail {
                            msg["detail"] = json!(d);
                        }
                        if let Some(t) = target {
                            msg["target"] = json!(t);
                        }
                        // AskUserQuestion: carry the full questions/options structure
                        // so the frontend can render an interactive choice card.
                        if name == "AskUserQuestion" {
                            if let Some(q) = input.get("questions") {
                                if q.is_array() {
                                    msg["questions"] = q.clone();
                                }
                            }
                        }
                        // An artifact call: remember which artifact it touches so
                        // the result can be picked up off disk, and label the chip
                        // with the artifact rather than the raw MCP tool name.
                        if name == artifacts::TOOL_NAME {
                            if let Some(aid) = input.get("id").and_then(|v| v.as_str()) {
                                if !id.is_empty() {
                                    pending_artifacts.insert(id.clone(), aid.to_string());
                                }
                                msg["artifact"] = json!(aid);
                            }
                            if let Some(t) = input.get("title").and_then(|v| v.as_str()) {
                                msg["target"] = json!(t);
                            }
                            // `detail` would otherwise be the whole document.
                            msg.as_object_mut().map(|o| o.remove("detail"));
                        }
                        // ExitPlanMode (Plan mode): carry the proposed plan so the
                        // frontend can render it as a readable plan card.
                        if name == "ExitPlanMode" || name == "exit_plan_mode" {
                            if let Some(p) = input.get("plan") {
                                if p.is_string() {
                                    msg["plan"] = p.clone();
                                }
                            }
                        }
                        // Edits & writes: carry the actual change so the chip can
                        // be expanded into a readable diff / the written content.
                        if let Some(rich) = tool_change(&name, &input) {
                            for (k, v) in rich {
                                msg[k] = v;
                            }
                        }
                        // Record the completed action as a persisted segment, then
                        // stream the same payload to the live view.
                        result.push_tool(msg.clone());
                        let _ = channel.send(msg);
                    } else {
                        // A text (non-tool) block ended: release any tail the
                        // ask-block parser was holding back.
                        ask.flush(result, channel);
                    }
                }
                _ => {}
            }
        }
        // The CLI reports each tool's output back as a `user` message carrying
        // tool_result blocks. We mine those for the shell/sub-agent output shown
        // in the Activity panel (the live deltas above never include it).
        "user" => {
            if let Some(arr) = ev
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in arr {
                    if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() {
                        continue;
                    }
                    let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                    let output = tool_result_text(block.get("content"));
                    attach_output(result, id, &output, is_error, channel);
                    // An artifact finished resolving: the MCP server has written
                    // it out, so read the whole thing back and hand it to the UI.
                    if let Some(art_id) = pending_artifacts.remove(id) {
                        if !is_error {
                            if let Some(dir) = artifact_dir {
                                publish_artifact(result, dir, &art_id, channel);
                            }
                        }
                    }
                }
            }
        }
        "result" => {
            if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                result.session_id = Some(sid.to_string());
            }
            if let Some(r) = ev.get("result").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    // Drop any ```krystal-ask block — it's rendered as a card, not text.
                    result.final_text = strip_ask_blocks(r);
                }
            }
            if let Some(u) = ev.get("usage") {
                if !u.is_null() {
                    result.usage = Some(u.clone());
                }
            }
            if let Some(c) = ev.get("total_cost_usd").and_then(|v| v.as_f64()) {
                result.cost_usd = c;
            }
            if ev.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                result.is_error = true;
                let m = ev
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Claude reported an error");
                let _ = channel.send(json!({ "type": "error", "message": m }));
            }
        }
        _ => {}
    }
}

/// Tidy a raw model reply into a usable chat title: first line only, no
/// surrounding quotes, trimmed trailing punctuation, capped to a few words.
fn clean_title(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let line = line.trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '*');
    let line = line.trim_end_matches(|c: char| matches!(c, '.' | '!' | '?' | ':' | ';' | ','));
    let line = line.trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > 48 {
        let mut t: String = chars.iter().take(48).collect();
        t.push('…');
        t
    } else {
        line.to_string()
    }
}

/// Name a chat from its first message using the cheapest model — a tiny one-off
/// call kept deliberately short (small input, tiny output) so it costs almost
/// nothing and returns fast. Returns None on any failure (caller falls back to
/// the truncated first message). Never resumes a session — it's standalone.
pub async fn generate_title(bin: &str, cwd: &str, user_prompt: &str) -> Option<String> {
    let sys = "You generate an extremely short title for a chat, summarizing what the user wants. \
        Rules: 2–5 words, at most ~40 characters; no quotes; no trailing punctuation; no preamble or explanation. \
        Reply with ONLY the title, written in the same language as the user's message.";
    let args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--dangerously-skip-permissions".into(),
        "--model".into(),
        TITLE_MODEL.into(),
        "--append-system-prompt".into(),
        sys.into(),
    ];
    let prompt = format!(
        "Title this conversation based on the user's first message:\n\n{}",
        take_chars(user_prompt, 1000)
    );
    match run_claude_text(bin, &args, cwd, &prompt).await {
        Ok((text, _)) => {
            let t = clean_title(&text);
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        Err(_) => None,
    }
}

/// Run a one-off claude call (no streaming) and return its final text + usage.
/// Used by Compact, Hint and the Initialize wizard. Mirrors `runClaudeText`.
pub async fn run_claude_text(
    bin: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
) -> Result<(String, Option<Value>), String> {
    let (args, _sys_file) = spill_system_prompt(args);
    let mut child = claude_command(bin, &args, cwd)
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let prompt_owned = prompt.to_string();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(prompt_owned.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let mut r = stderr;
        let _ = r.read_to_string(&mut s).await;
        s
    });

    let mut text = String::new();
    let mut usage: Option<Value> = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let ev: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if ev.get("type").and_then(|v| v.as_str()) == Some("result") {
            if let Some(r) = ev.get("result").and_then(|v| v.as_str()) {
                text = r.to_string();
            }
            if let Some(u) = ev.get("usage") {
                if !u.is_null() {
                    usage = Some(u.clone());
                }
            }
        }
    }

    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let errout = err_task.await.unwrap_or_default();

    if !text.is_empty() {
        Ok((text, usage))
    } else {
        let code = status.code().unwrap_or(-1);
        Err(if errout.trim().is_empty() {
            format!("claude exited {code}")
        } else {
            errout.trim().to_string()
        })
    }
}

/// Run a one-off shell command directly (the composer's `$` escape hatch),
/// capturing combined stdout+stderr and the exit code. Uses PowerShell on
/// Windows (so `ls`, `cat`, … work as users expect) and `sh -c` elsewhere.
/// Bounded by a timeout and an output cap so a runaway command can't hang the UI
/// or bloat the transcript. Returns `(output, exit_code)`.
pub async fn run_shell_capture(command: &str, cwd: &str) -> Result<(String, i32), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start shell: {e}"))?;
    let out = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("command timed out after 120s".into()),
    };

    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    const CAP: usize = 100_000;
    if combined.len() > CAP {
        combined.truncate(CAP);
        combined.push_str("\n… (output truncated)");
    }

    Ok((combined.trim_end().to_string(), out.status.code().unwrap_or(-1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode_args(mode: &str) -> Vec<String> {
        let mut args = base_args("claude-opus-5-5", "sys");
        apply_mode(&mut args, mode);
        args
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn auto_mode_keeps_full_power() {
        let args = mode_args("auto");
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!args.iter().any(|a| a == "--permission-prompt-tool"));
    }

    #[test]
    fn ask_mode_asks_and_routes_the_question_to_the_host() {
        let args = mode_args("ask");
        // Skipping permissions and asking for them cannot both be on.
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(has_pair(&args, "--permission-mode", "default"));
        // Without this the CLI has nobody to ask and refuses everything instead.
        assert!(has_pair(&args, "--permission-prompt-tool", "stdio"));
    }

    #[test]
    fn plan_mode_has_no_prompt_to_answer() {
        let args = mode_args("plan");
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(has_pair(&args, "--permission-mode", "plan"));
        assert!(!args.iter().any(|a| a == "--permission-prompt-tool"));
    }

    #[test]
    fn krystals_own_files_are_not_put_to_the_user() {
        let own = vec![
            PathBuf::from(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\task-lists"),
            PathBuf::from(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\attachments"),
        ];
        let at = |p: &str| json!({ "file_path": p });

        // The task snapshot, in whichever slash and case the model wrote it.
        assert!(is_own_business(
            "Edit",
            &at(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\task-lists\cfcc.md"),
            &own
        ));
        assert!(is_own_business(
            "Read",
            &at("c:/users/me/appdata/roaming/com.krystal.claudecode/attachments/shot.png"),
            &own
        ));
        // The artifact tool is Krystal's own, whatever it is handed.
        assert!(is_own_business(artifacts::TOOL_NAME, &json!({ "id": "a" }), &own));
    }

    #[test]
    fn everything_else_is_still_asked() {
        let own = vec![PathBuf::from(r"C:\data\krystal\task-lists")];
        let at = |p: &str| json!({ "file_path": p });

        // The user's project is exactly what Ask mode is for.
        assert!(!is_own_business("Edit", &at(r"C:\proj\src\main.rs"), &own));
        // A neighbour of an owned folder is not inside it — the database lives
        // one level up, and a name that merely starts the same is a different folder.
        assert!(!is_own_business("Edit", &at(r"C:\data\krystal\krystal.db"), &own));
        assert!(!is_own_business("Edit", &at(r"C:\data\krystal\task-lists-old\x.md"), &own));
        // No climbing back out through `..`.
        assert!(!is_own_business(
            "Write",
            &at(r"C:\data\krystal\task-lists\..\krystal.db"),
            &own
        ));
        // Only the file tools: a shell command naming the path is still asked.
        assert!(!is_own_business(
            "Bash",
            &json!({ "command": r"del C:\data\krystal\task-lists\x.md" }),
            &own
        ));
        // And with nothing owned, nothing is waved through.
        assert!(!is_own_business("Read", &at(r"C:\data\krystal\task-lists\x.md"), &[]));
    }

    #[test]
    fn a_permission_prompt_says_what_is_being_agreed_to() {
        let request = json!({
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "input": { "command": "npm install left-pad", "description": "Install left-pad" },
            "permission_suggestions": [
                { "type": "addRules", "behavior": "allow", "destination": "localSettings",
                  "rules": [{ "toolName": "Bash", "ruleContent": "npm install *" }] },
                { "type": "addDirectories", "directories": ["C:\\p"], "destination": "session" }
            ],
            "tool_use_id": "toolu_1",
        });
        let msg = permission_prompt("req-9", &request);
        assert_eq!(msg["type"], "permission");
        assert_eq!(msg["id"], "req-9");
        assert_eq!(msg["tool"], "Bash");
        assert_eq!(msg["detail"], "npm install left-pad");
        assert_eq!(msg["why"], "Install left-pad");
        assert_eq!(msg["toolUseId"], "toolu_1");
        // What "always" would do, flattened for the button to describe.
        let always = msg["always"].as_array().unwrap();
        assert_eq!(always.len(), 2);
        assert_eq!(always[0]["kind"], "rule");
        assert_eq!(always[0]["text"], "npm install *");
        assert_eq!(always[0]["scope"], "localSettings");
        assert_eq!(always[1]["kind"], "dir");
    }

    #[test]
    fn an_edit_prompt_carries_the_diff() {
        let request = json!({
            "tool_name": "Edit",
            "input": { "file_path": "C:/p/a.rs", "old_string": "foo", "new_string": "bar" },
            "permission_suggestions": [
                { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
            ],
        });
        let msg = permission_prompt("req-10", &request);
        assert_eq!(msg["target"], "a.rs");
        assert_eq!(msg["edits"][0]["old"], "foo");
        assert_eq!(msg["edits"][0]["new"], "bar");
        assert_eq!(msg["always"][0]["kind"], "mode");
        assert_eq!(msg["always"][0]["text"], "acceptEdits");
        // No suggestions at all → no "always" on offer, not a broken one.
        let bare = json!({ "tool_name": "WebFetch", "input": { "url": "https://example.com/x" } });
        assert_eq!(permission_prompt("r", &bare)["always"].as_array().unwrap().len(), 0);
    }

    // The real thing the fallback keys off: the CLI's registry pre-check giving
    // up, as opposed to a download or install that actually went wrong.
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

    #[test]
    fn strip_removes_a_single_block() {
        let s = "Here are some options:
```krystal-ask
{\"questions\":[]}
```";
        assert_eq!(strip_ask_blocks(s), "Here are some options:");
    }

    #[test]
    fn strip_keeps_text_on_both_sides() {
        let s = "before ```krystal-ask
{}
``` after";
        assert_eq!(strip_ask_blocks(s), "before  after");
    }

    #[test]
    fn strip_drops_an_unterminated_block() {
        let s = "intro ```krystal-ask
{\"questions\": [";
        assert_eq!(strip_ask_blocks(s), "intro");
    }

    #[test]
    fn strip_leaves_ordinary_text_and_code_fences_untouched() {
        let s = "see ```rust
fn main() {}
``` ok";
        assert_eq!(strip_ask_blocks(s), s.trim());
    }

    #[test]
    fn parse_accepts_questions_object() {
        let body = "{\"questions\":[{\"question\":\"Pick\",\"options\":[{\"label\":\"A\"}]}]}";
        let q = parse_ask_questions(body).expect("should parse");
        assert!(q.is_array());
        assert_eq!(q.as_array().unwrap().len(), 1);
    }

    #[test]
    fn parse_accepts_bare_array() {
        let body = "[{\"question\":\"Pick\"}]";
        assert!(parse_ask_questions(body).is_some());
    }

    // The real-world slip: a long block closed one brace short of the root object.
    #[test]
    fn parse_recovers_a_missing_closing_brace() {
        let body = "{\"questions\":[{\"question\":\"What next?\",\"header\":\"Next step\",\
                     \"multiSelect\":true,\"options\":[{\"label\":\"4.2 [gate]\",\
                     \"description\":\"a ] inside the text\"},{\"label\":\"B\"}]}]";
        let q = parse_ask_questions(body).expect("should recover");
        let a = q.as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["options"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_recovers_with_trailing_prose() {
        let body = "{\"questions\":[{\"question\":\"Pick\",\"options\":[{\"label\":\"A\"}]}]}\nLet me know.";
        assert!(parse_ask_questions(body).is_some());
    }

    #[test]
    fn parse_rejects_non_json_and_non_arrays() {
        assert!(parse_ask_questions("not json").is_none());
        assert!(parse_ask_questions("{\"questions\": 5}").is_none());
        assert!(parse_ask_questions("{\"foo\": 1}").is_none());
    }

    #[test]
    fn spill_moves_system_prompt_to_a_file() {
        let sys = "help {\"q\":\"x\"} pandoc 'f.docx' -t markdown -o out.docx";
        let args = base_args("claude-haiku-4-5-20251001", sys);
        let (out, guard) = spill_system_prompt(&args);

        // The inline flag is gone; the file variant carries a real path.
        assert!(!out.iter().any(|a| a == "--append-system-prompt"));
        let i = out
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .expect("file flag present");
        let path = &out[i + 1];
        // No option-like token (e.g. the pandoc `-t`) is left on the command line.
        assert!(!out.iter().any(|a| a == "-t"));
        // The prompt round-trips verbatim through the file.
        assert_eq!(std::fs::read_to_string(path).unwrap(), sys);

        let owned = path.clone();
        drop(guard);
        assert!(!std::path::Path::new(&owned).exists(), "file cleaned up on drop");
    }

    #[test]
    fn spill_is_a_noop_without_a_system_prompt() {
        let args = vec!["-p".to_string(), "--verbose".to_string()];
        let (out, _guard) = spill_system_prompt(&args);
        assert_eq!(out, args);
    }

    #[test]
    fn base_args_forwards_the_selected_model_verbatim() {
        // The exact id the user picked must ride through as `--model <id>`.
        let args = base_args("claude-opus-4-8", "sys");
        let i = args.iter().position(|a| a == "--model").expect("--model present");
        assert_eq!(args[i + 1], "claude-opus-4-8");

        // A dynamic id we never hardcoded is still forwarded (no prefix gating).
        let args = base_args("some-future-model-9", "sys");
        let i = args.iter().position(|a| a == "--model").expect("--model present");
        assert_eq!(args[i + 1], "some-future-model-9");

        // Only an un-forwardable id is dropped — never a real selection.
        let args = base_args("bad id", "sys");
        assert!(!args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn worker_definition_pins_its_model_and_keeps_the_fixed_brief() {
        let def = worker_def("A worker", "claude-sonnet-4-6");
        assert_eq!(def.get("description").and_then(|v| v.as_str()), Some("A worker"));
        assert_eq!(def.get("model").and_then(|v| v.as_str()), Some("claude-sonnet-4-6"));
        assert!(def.get("prompt").and_then(|v| v.as_str()).unwrap().contains("worker sub-agent"));
    }

    #[test]
    fn orchestrator_note_names_the_exact_worker_and_forbids_generic_types() {
        // Enforcement is prompt-only (see the NOTE above `Orchestration`): a CLI-level
        // --disallowedTools deny was tried and reverted, since Claude Code's built-in
        // generic agent types (general-purpose, claude, …) share the parent's
        // permission set and would silently inherit the deny if the model drifted to
        // one instead of the pinned custom worker. So the note must both name the
        // exact worker and explicitly forbid the generic fallbacks.
        let o = prepare_orchestration("claude-haiku-4-5-20251001", &[]);
        assert!(o.note.contains("ORCHESTRATOR MODE"));
        assert!(o.note.contains("general-purpose"));
        assert!(o.note.contains(WORKER_PREFIX));
    }

    #[test]
    fn orchestrator_note_names_the_current_delegation_tool() {
        // The delegation tool is `Agent` today and was `Task` before. Pointing the
        // orchestrator at a tool that no longer exists, while telling it to route
        // all work through that tool, is exactly how a turn hangs — so the note has
        // to name the current one (and may mention the legacy alias).
        let o = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert!(o.note.contains("`Agent` tool"));
        assert!(o.note.contains("subagent_type"));
    }

    #[test]
    fn orchestrator_note_keeps_targeted_reads_and_caps_parallelism() {
        // The mode used to demand delegating *every* action, including a single
        // Read — a fresh-context agent boot per look-up, which is what made simple
        // requests crawl. The note must keep targeted reads with the orchestrator
        // and bound how many workers run at once.
        let o = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert!(o.note.contains("Read/Grep/Glob"));
        assert!(o.note.contains("2–4 workers in parallel"));
        assert!(o.note.contains("Stop conditions"));
        // …and it must not go back to the all-or-nothing rule.
        assert!(!o.note.contains("NEVER use tools yourself"));
    }

    #[test]
    fn worker_brief_forbids_nesting_and_sets_a_stop_condition() {
        // A worker that delegates further turns one task into a tree; a worker with
        // no stop condition grinds on a failing loop. Both are turn-length bugs.
        assert!(WORKER_BODY.contains("Do NOT delegate"));
        assert!(WORKER_BODY.contains("fails twice"));
    }

    #[test]
    fn orchestration_defines_its_workers_inline_with_stable_names() {
        // The definitions ride on `--agents`, so nothing is written to the user's
        // ~/.claude/agents any more — and the names must not vary from turn to
        // turn, or the appended system prompt (and with it the prompt cache
        // prefix) changes on every single orchestrated turn.
        let a = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        let b = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert_eq!(a.agents, b.agents, "worker definitions are stable across turns");
        assert_eq!(a.note, b.note, "so is the note that names them");

        let defs: Value = serde_json::from_str(&a.agents).expect("valid --agents JSON");
        let obj = defs.as_object().expect("an object of name -> definition");
        assert_eq!(obj.len(), 3, "auto offers a fast/balanced/deep trio");
        for (name, def) in obj {
            assert!(name.starts_with(WORKER_PREFIX), "{name} is namespaced to us");
            assert!(a.note.contains(name.as_str()), "the note names {name}");
            assert!(def.get("description").and_then(|v| v.as_str()).is_some());
            assert!(def.get("model").and_then(|v| v.as_str()).is_some());
            assert_eq!(def.get("prompt").and_then(|v| v.as_str()), Some(WORKER_BODY));
            // Full tool freedom is a project rule: a worker inherits everything.
            assert!(def.get("tools").is_none(), "we never restrict a worker's toolset");
        }
    }

    #[test]
    fn a_pinned_sub_model_gets_one_worker_on_that_model() {
        let o = prepare_orchestration("claude-haiku-4-5-20251001", &[]);
        let defs: Value = serde_json::from_str(&o.agents).unwrap();
        let obj = defs.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        let (name, def) = obj.iter().next().unwrap();
        assert!(o.note.contains(name.as_str()));
        assert_eq!(def.get("model").and_then(|v| v.as_str()), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn per_turn_notes_lead_the_message_and_are_fenced_off() {
        // The task note can't live in the system prompt any more (it changes every
        // time a task is ticked off, which would retire the session each turn), so
        // it rides on the message — ahead of, and separated from, the user's words.
        let p = build_prompt("do the thing", &[], None, None, Some("OPEN TASKS: one, two"));
        assert!(p.starts_with("OPEN TASKS: one, two"));
        assert!(p.contains("---"));
        assert!(p.trim_end().ends_with("do the thing"));

        // No notes, no fence — an ordinary message is untouched.
        let plain = build_prompt("hello", &[], None, None, None);
        assert_eq!(plain, "hello");
        assert_eq!(build_prompt("hello", &[], None, None, Some("")), "hello");
    }

    #[test]
    fn session_flags_make_the_process_reusable() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_session_flags(&mut args);
        let i = args
            .iter()
            .position(|a| a == "--input-format")
            .expect("--input-format present");
        assert_eq!(args[i + 1], "stream-json");
    }

    #[test]
    fn a_slash_command_stays_at_the_head_of_the_prompt() {
        // Background context normally leads. It must not, here: the CLI reads
        // `/skill-name` only as the very first thing in the prompt, so a task
        // note in front of it would silently turn the skill into prose.
        let p = build_prompt(
            "/code-review the login screen",
            &["C:/shot.png".into()],
            None,
            None,
            Some("OPEN TASKS: one, two"),
        );
        assert!(p.starts_with("/code-review the login screen"), "{p}");
        assert!(p.contains("OPEN TASKS: one, two"), "context is still there: {p}");
        assert!(p.contains("C:/shot.png"), "attachments are still there: {p}");
    }

    #[test]
    fn only_a_real_slash_command_reorders_the_prompt() {
        assert!(starts_with_slash_command("/run"));
        assert!(starts_with_slash_command("/code-review the diff"));
        assert!(starts_with_slash_command("/git:sync\nand then"));
        // A path, a lone slash, a fraction — none of these invoke anything.
        assert!(!starts_with_slash_command("/usr/bin/env"));
        assert!(!starts_with_slash_command("/"));
        assert!(!starts_with_slash_command("/ leading space"));
        assert!(!starts_with_slash_command("/-dash-first"));
        assert!(!starts_with_slash_command("look at /etc/hosts"));
        // …so an ordinary message still gets its context first.
        let p = build_prompt("/usr/bin matters", &[], None, None, Some("NOTE"));
        assert!(p.starts_with("NOTE"), "{p}");
    }

    #[test]
    fn extra_dirs_become_add_dir_flags_in_order() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_extra_dirs(
            &mut args,
            &["/shared/assets".into(), "  ".into(), "/notes".into()],
        );
        let flags: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, _)| *i > 0 && args[i - 1] == "--add-dir")
            .map(|(_, a)| a)
            .collect();
        assert_eq!(flags, ["/shared/assets", "/notes"], "blank entries dropped");
        assert_eq!(args.iter().filter(|a| *a == "--add-dir").count(), 2);
    }

    #[test]
    fn no_extra_dirs_adds_nothing() {
        let mut args = base_args("claude-opus-5", "sys");
        let before = args.len();
        apply_extra_dirs(&mut args, &[]);
        assert_eq!(args.len(), before);
    }

    #[test]
    fn chat_flags_carry_effort_fallback_and_autocompact() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_chat_flags(&mut args, "xhigh", Some("claude-sonnet-5"), true);
        let at = |flag: &str| args.iter().position(|a| a == flag);
        assert_eq!(args[at("--effort").expect("--effort present") + 1], "xhigh");
        assert_eq!(
            args[at("--fallback-model").expect("--fallback-model present") + 1],
            "claude-sonnet-5"
        );
        assert_eq!(args[at("--autocompact").expect("--autocompact present") + 1], "auto");
        assert!(at("--prompt-suggestions").is_some());
    }

    #[test]
    fn chat_flags_skip_what_they_have_no_value_for() {
        // An unknown effort must not reach the CLI as `--effort <garbage>` (that
        // fails the whole turn); no fallback and no suggestions simply add nothing.
        let mut args = base_args("claude-opus-5", "sys");
        apply_chat_flags(&mut args, "turbo", None, false);
        assert!(!args.iter().any(|a| a == "--effort"));
        assert!(!args.iter().any(|a| a == "--fallback-model"));
        assert!(!args.iter().any(|a| a == "--prompt-suggestions"));
    }

    #[test]
    fn the_system_prompt_survives_being_multi_line() {
        // The single-line rule is gone because the prompt is spilled to a file.
        // Guard the mechanism that made that safe, not the old constraint.
        let sys = capability_prompt(Caps { pandoc: true, python_docx: true }, "hr");
        assert!(sys.contains('\n'), "written as sections, not one run-on line");
        assert!(sys.contains("## Reply language"));
        let args = base_args("claude-opus-5", &sys);
        let (out, _guard) = spill_system_prompt(&args);
        assert!(!out.iter().any(|a| a == "--append-system-prompt"));
        let i = out
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .expect("spilled to a file");
        assert_eq!(std::fs::read_to_string(&out[i + 1]).unwrap(), sys);
    }
}
