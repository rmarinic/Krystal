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
use tokio::process::Command;

use crate::models::{is_valid_model, TITLE_MODEL};

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

/// System prompt prepended on every turn. Kept to a SINGLE LINE (no newlines)
/// so it can be passed safely as a command-line argument to the `claude.cmd`
/// shim on Windows — Rust refuses to escape newlines into a batch invocation.
pub fn capability_prompt(caps: Caps) -> String {
    let mut lines: Vec<String> = vec![
        "You are helping the user with the files and work in the current project folder.".into(),
        "Read CLAUDE.md (if present) for what this project is about, and reply in the language the user writes in.".into(),
        "When you write any file that may contain Croatian text, always use UTF-8 so diacritics (č, ć, ž, š, đ) are preserved exactly.".into(),
        "When you want the user to pick between a few clear options, use the AskUserQuestion tool — this app renders it as clickable cards with a text box for a custom answer.".into(),
        "In THIS app the AskUserQuestion tool ALWAYS returns the error 'Answer questions?' the instant you call it; that is EXPECTED and only means the cards were shown — never treat it as a failure or say the tool didn't work.".into(),
        "After calling AskUserQuestion, write at most one short line inviting the user to choose above, then STOP and wait — their selection (or typed answer) arrives as their very next message, so just continue naturally from it.".into(),
    ];
    if caps.pandoc {
        lines.push("Word documents (.docx) ARE supported via pandoc:".into());
        lines.push("to READ a .docx, run: pandoc 'file.docx' -t markdown (then read its text);".into());
        lines.push("to CREATE/replace a .docx from markdown, run: pandoc 'draft.md' -o 'out.docx';".into());
        lines.push("a reference doc can carry styling: pandoc in.md -o out.docx --reference-doc=ref.docx.".into());
    }
    if caps.python_docx {
        lines.push("For SURGICAL edits that must preserve a .docx's existing formatting, use the python-docx library from a short python script (import docx) rather than pandoc.".into());
    }
    if !caps.pandoc && !caps.python_docx {
        lines.push("NOTE: Word (.docx) tooling is not installed, so you cannot open or write .docx files directly. If asked, tell the user to install pandoc and python-docx to enable Word support.".into());
    }
    lines.join(" ")
}

/* --------------------------- resolving claude ---------------------------- */

const CLAUDE_CANDIDATES: [&str; 4] = ["claude.cmd", "claude.exe", "claude.bat", "claude"];

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    let mut child = cmd.spawn().map_err(|e| format!("could not start the installer: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Stream stdout and stderr (the installer logs to both) line-by-line.
    let ch_out = channel.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let _ = ch_out.send(json!({ "type": "log", "line": line }));
            }
        }
    });
    let ch_err = channel.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let _ = ch_err.send(json!({ "type": "log", "line": line }));
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = out_task.await;
    let _ = err_task.await;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "installer exited with code {}",
            status.code().unwrap_or(-1)
        ))
    }
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
    if is_valid_model(model) {
        args.push("--model".into());
        args.push(model.to_string());
    }
    args
}

/// Apply a chat "mode" to freshly-built base args. `auto` keeps full power
/// (the default skip-permissions base). `plan` drops write access and asks
/// Claude to research and propose a plan instead of changing anything.
pub fn apply_mode(args: &mut Vec<String>, mode: &str) {
    if mode == "plan" {
        args.retain(|a| a != "--dangerously-skip-permissions");
        args.push("--permission-mode".into());
        args.push("plan".into());
    }
}

/// Assemble the prompt fed over stdin. Mirrors `buildPrompt` in server.js.
pub fn build_prompt(text: &str, files: &[String], seed: Option<&str>) -> String {
    let mut p = String::new();
    if let Some(seed) = seed {
        if !seed.is_empty() {
            p.push_str("Summary of our conversation so far (use it to continue seamlessly):\n");
            p.push_str(seed);
            p.push_str("\n\n---\n\n");
        }
    }
    if !files.is_empty() {
        p.push_str("Referenced files (read these as needed):\n");
        for f in files {
            p.push_str("- ");
            p.push_str(f);
            p.push('\n');
        }
        p.push('\n');
    }
    p.push_str(text);
    p
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
    if name == "Task" {
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

/* ------------------------------ spawning --------------------------------- */

fn claude_command(bin: &str, args: &[String], cwd: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
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

/// Spawn claude, stream the answer to the frontend over `channel`, and return
/// the accumulated result. Mirrors `handleChat`'s routeEvent loop.
pub async fn run_chat_stream(
    bin: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
    channel: &Channel<Value>,
) -> Result<ChatResult, String> {
    let mut child = claude_command(bin, args, cwd)
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Feed the prompt over stdin (in the background) so quotes/newlines never
    // hit the shell, and so a large prompt can't deadlock against stdout.
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

    let mut result = ChatResult::default();
    // index -> (tool name, accumulating input JSON, tool_use id)
    let mut tool_blocks: HashMap<i64, (String, String, String)> = HashMap::new();
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
        route_event(&ev, &mut result, &mut tool_blocks, channel);
    }

    // If the answer arrived only via the final `result` event (no streamed text
    // deltas), still expose it as one text segment so the transcript isn't empty.
    if result.segments.is_empty() && !result.final_text.trim().is_empty() {
        result.segments.push(json!({ "type": "text", "text": result.final_text.clone() }));
    }

    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let errout = err_task.await.unwrap_or_default();
    let code = status.code().unwrap_or(-1);

    if code != 0 && result.final_text.is_empty() && !result.is_error {
        result.is_error = true;
        let msg = if errout.trim().is_empty() {
            format!("claude exited with code {code}")
        } else {
            errout.trim().to_string()
        };
        let _ = channel.send(json!({ "type": "error", "message": msg }));
    }
    Ok(result)
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

/// Attach a tool's captured output to its segment (so it persists) and stream a
/// `tool_result` event to the live view. Scoped to shells (Bash) and sub-agents
/// (Task) — the things the Activity panel watches — and capped so a chatty
/// command can't bloat the saved transcript.
fn attach_output(
    result: &mut ChatResult,
    id: &str,
    output: &str,
    is_error: bool,
    channel: &Channel<Value>,
) {
    const CAP: usize = 4000;
    let capped: String = if output.chars().count() > CAP {
        let mut s: String = output.chars().take(CAP).collect();
        s.push_str("\n… (truncated)");
        s
    } else {
        output.to_string()
    };
    let mut matched = false;
    for seg in result.segments.iter_mut() {
        if seg.get("id").and_then(|v| v.as_str()) == Some(id) {
            let name = seg.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name == "Bash" || name == "Task" {
                seg["output"] = json!(capped.clone());
                if is_error {
                    seg["isError"] = json!(true);
                }
                matched = true;
            }
            break;
        }
    }
    if matched {
        let _ = channel.send(
            json!({ "type": "tool_result", "id": id, "output": capped, "isError": is_error }),
        );
    }
}

fn route_event(
    ev: &Value,
    result: &mut ChatResult,
    tool_blocks: &mut HashMap<i64, (String, String, String)>,
    channel: &Channel<Value>,
) {
    let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "system" if ev.get("subtype").and_then(|v| v.as_str()) == Some("init") => {
            if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                result.session_id = Some(sid.to_string());
            }
            let _ = channel.send(json!({ "type": "start", "sessionId": result.session_id }));
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
                                result.push_text(t);
                                let _ = channel.send(json!({ "type": "token", "text": t }));
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
                        // ExitPlanMode (Plan mode): carry the proposed plan so the
                        // frontend can render it as a readable plan card.
                        if name == "ExitPlanMode" || name == "exit_plan_mode" {
                            if let Some(p) = input.get("plan") {
                                if p.is_string() {
                                    msg["plan"] = p.clone();
                                }
                            }
                        }
                        // Record the completed action as a persisted segment, then
                        // stream the same payload to the live view.
                        result.push_tool(msg.clone());
                        let _ = channel.send(msg);
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
                }
            }
        }
        "result" => {
            if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                result.session_id = Some(sid.to_string());
            }
            if let Some(r) = ev.get("result").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    result.final_text = r.to_string();
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
    let mut child = claude_command(bin, args, cwd)
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
