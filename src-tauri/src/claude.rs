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

use crate::models::{
    is_safe_model_arg, model_name, ModelInfo, ORCH_BALANCED_MODEL, ORCH_DEEP_MODEL,
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

/// System prompt prepended on every turn. Kept to a SINGLE LINE (no newlines)
/// so it can be passed safely as a command-line argument to the `claude.cmd`
/// shim on Windows — Rust refuses to escape newlines into a batch invocation.
pub fn capability_prompt(caps: Caps) -> String {
    let mut lines: Vec<String> = vec![
        "You are helping the user with the files and work in the current project folder.".into(),
        "Read CLAUDE.md (if present) for what this project is about, and reply in the language the user writes in.".into(),
        "When you write any file that may contain Croatian text, always use UTF-8 so diacritics (č, ć, ž, š, đ) are preserved exactly.".into(),
        "When you want the user to choose between a few clear options, present a choice card instead of asking in prose: output a fenced code block tagged krystal-ask whose body is valid JSON of the form {\"questions\":[{\"question\":\"…\",\"header\":\"short label\",\"multiSelect\":false,\"options\":[{\"label\":\"…\",\"description\":\"…\"}]}]} — this app renders it as clickable cards with a custom-answer box.".into(),
        "Emit that block as the very last thing in your reply and then STOP; the user's selection (or typed answer) arrives as their next message, so just continue naturally from it. Use it only for genuine forks where the choice changes what you do — never for routine questions.".into(),
        // Each turn is a separate headless `claude -p` process (see run_chat_stream);
        // when it exits, harness-tracked background work dies with it — a background
        // shell can never outlive the reply that started it, and its "you'll be
        // notified" promise silently breaks. Steer Claude away from ever relying on it.
        "IMPORTANT: this app runs each reply as a separate headless claude process that EXITS as soon as the reply finishes, so background work does NOT survive between replies: never run Bash/PowerShell commands with run_in_background=true and never launch background agents or tasks you intend to check later — their processes and completion notifications die with the reply. Run long commands in the FOREGROUND with a generous timeout (up to 10 minutes) and wait for them inside the same reply; if something would take longer, break it into explicit steps the user triggers one reply at a time.".into(),
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

/// Update Claude Code in place by running `<bin> update`, streaming every output
/// line to the frontend as `{type:"log", line}` (same shape as the installer) so
/// the Settings panel can show live progress. This is exactly what running
/// `claude update` in a terminal does — it checks for a newer release and, if
/// there is one, downloads and applies it. Resolves Ok on a clean exit.
pub async fn update_claude_code(bin: &str, channel: &Channel<Value>) -> Result<(), String> {
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
    let mut child = cmd.spawn().map_err(|e| format!("could not start the updater: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Stream stdout and stderr (the updater logs to both) line-by-line.
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
            "updater exited with code {}",
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
pub fn apply_mode(args: &mut Vec<String>, mode: &str) {
    if mode == "plan" {
        args.retain(|a| a != "--dangerously-skip-permissions");
        args.push("--permission-mode".into());
        args.push("plan".into());
    }
}

/* ---------------------------- orchestrator ------------------------------- */

/// RAII guard for the temporary worker-agent `.md` files written under
/// `~/.claude/agents` for a single orchestrator turn. Removed on drop — i.e.
/// once the claude child has exited and the chat handler returns — so they never
/// linger to pollute the user's own Claude Code agents. Mirrors `SysPromptFile`.
pub struct OrchestratorGuard(Vec<PathBuf>);

impl Drop for OrchestratorGuard {
    fn drop(&mut self) {
        for p in self.0.drain(..) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Everything a chat turn needs to run in orchestrator mode: a system-prompt
/// note steering the orchestrator to delegate, plus the guard that cleans up the
/// worker-agent files it references.
pub struct Orchestration {
    /// Appended (single line) to the system prompt for this turn.
    pub note: String,
    _guard: OrchestratorGuard,
}

static ORCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn claude_agents_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(PathBuf::from(home).join(".claude").join("agents"))
}

/// Write one worker-agent definition file. The `model:` frontmatter pins the
/// sub-agent's model; the body is its (deliberately generic, full-tool) brief —
/// we never restrict a worker's toolset. Returns the path on success.
fn write_worker_agent(dir: &std::path::Path, name: &str, description: &str, model: &str) -> Option<PathBuf> {
    const BODY: &str = "You are a worker sub-agent operating under an orchestrator. Carry out the delegated task end-to-end with your full toolset, then return a tight, complete result the orchestrator can use directly. Be thorough but concise, and don't hand work back with questions unless you are genuinely blocked.";
    let path = dir.join(format!("{name}.md"));
    let content = format!("---\nname: {name}\ndescription: {description}\nmodel: {model}\n---\n{BODY}\n");
    std::fs::write(&path, content).ok()?;
    Some(path)
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

/// Prepare the worker sub-agents for one orchestrator turn and the note that
/// steers the orchestrator to delegate to them. `sub_model` is a concrete model
/// id, or `auto` to offer a fast/balanced/deep trio (drawn from the live
/// `catalog`) the orchestrator picks from per task. Returns `None` (mode
/// silently off) if the agents dir is unwritable.
pub fn prepare_orchestration(sub_model: &str, catalog: &[ModelInfo]) -> Option<Orchestration> {
    let dir = claude_agents_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    // Unique per process + call so concurrent turns never share (and so cleaning
    // up one turn's files can't yank an agent out from under another).
    let seq = ORCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tag = format!("{}-{}", std::process::id(), seq);
    let mut files = Vec::new();

    let note = if sub_model == SUB_MODEL_AUTO {
        // Tiers track the live catalogue; the ORCH_* ids are only fallbacks.
        let (fast_id, fast_m) = pick_tier(catalog, "haiku", ORCH_FAST_MODEL);
        let (bal_id, bal_m) = pick_tier(catalog, "sonnet", ORCH_BALANCED_MODEL);
        let (deep_id, deep_m) = pick_tier(catalog, "opus", ORCH_DEEP_MODEL);
        let fast = format!("krystal-worker-fast-{tag}");
        let bal = format!("krystal-worker-balanced-{tag}");
        let deep = format!("krystal-worker-deep-{tag}");
        files.push(write_worker_agent(&dir, &fast, "Fast, cheap worker for simple or mechanical delegated tasks.", &fast_id)?);
        files.push(write_worker_agent(&dir, &bal, "Balanced worker for typical coding, analysis and writing tasks.", &bal_id)?);
        files.push(write_worker_agent(&dir, &deep, "Most-capable worker, for genuinely hard reasoning tasks.", &deep_id)?);
        format!(
            "ORCHESTRATOR MODE: You are the orchestrator, running on a premium model — conserve budget by delegating the heavy lifting to worker sub-agents via the Task tool instead of doing it yourself. For any substantial, well-scoped unit of work (searching or reading many files, running commands, implementing edits, drafting content, research), dispatch it to a worker, choosing the cheapest one that can do it well: `{fast}` ({fast_m}, fast & cheap) for simple or mechanical tasks, `{bal}` ({bal_m}, balanced) for typical coding, analysis and writing, and `{deep}` ({deep_m}, most capable) only for genuinely hard reasoning. Launch independent pieces in parallel (multiple Task calls in a single turn). Keep your own turns focused on understanding the request, planning, dispatching, reviewing results, and writing the final answer; do the work yourself only when it is trivial or delegation would add pointless overhead.",
        )
    } else {
        let name = format!("krystal-worker-{tag}");
        files.push(write_worker_agent(&dir, &name, "Worker sub-agent for delegated tasks; runs on a cheaper model to conserve budget.", sub_model)?);
        format!(
            "ORCHESTRATOR MODE: You are the orchestrator, running on a premium model — conserve budget by delegating the heavy lifting to your `{name}` worker sub-agent (which runs on {mname}) via the Task tool instead of doing it yourself. For any substantial, well-scoped unit of work (searching or reading many files, running commands, implementing edits, drafting content, research), dispatch it to `{name}`, launching independent pieces in parallel (multiple Task calls in a single turn). Keep your own turns focused on understanding the request, planning, dispatching, reviewing results, and writing the final answer; do the work yourself only when it is trivial or delegation would add pointless overhead.",
            mname = resolve_model_name(catalog, sub_model),
        )
    };

    Some(Orchestration { note, _guard: OrchestratorGuard(files) })
}

/// Assemble the prompt fed over stdin. Mirrors `buildPrompt` in server.js.
pub fn build_prompt(text: &str, files: &[String], seed: Option<&str>, references: Option<&str>) -> String {
    let mut p = String::new();
    if let Some(seed) = seed {
        if !seed.is_empty() {
            p.push_str("Summary of our conversation so far (use it to continue seamlessly):\n");
            p.push_str(seed);
            p.push_str("\n\n---\n\n");
        }
    }
    if let Some(refs) = references {
        if !refs.is_empty() {
            p.push_str(refs);
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
struct SysPromptFile(Option<PathBuf>);

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
fn spill_system_prompt(args: &[String]) -> (Vec<String>, SysPromptFile) {
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

/// Pull the `questions` array out of a ```krystal-ask block body. Accepts either
/// the full `{"questions":[…]}` object or a bare `[…]` array; returns None if the
/// body isn't valid JSON or doesn't hold an array of questions.
fn parse_ask_questions(body: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    v.get("questions")
        .cloned()
        .filter(|q| q.is_array())
        .or_else(|| if v.is_array() { Some(v) } else { None })
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

/// Spawn claude, stream the answer to the frontend over `channel`, and return
/// the accumulated result. Mirrors `handleChat`'s routeEvent loop.
pub async fn run_chat_stream(
    bin: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
    channel: &Channel<Value>,
    running: &std::sync::Mutex<HashMap<String, u32>>,
    thread_id: &str,
) -> Result<ChatResult, String> {
    let (args, _sys_file) = spill_system_prompt(args);
    let mut child = claude_command(bin, &args, cwd)
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    // Register the PID so `stop_chat` can interrupt this turn mid-stream.
    if let Some(pid) = child.id() {
        running.lock().unwrap().insert(thread_id.to_string(), pid);
    }

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
    let mut ask = AskParser::default();
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
        route_event(&ev, &mut result, &mut tool_blocks, &mut ask, channel);
    }
    // Release anything the ask-block parser is still holding (e.g. a turn that
    // ended without a trailing text block to trigger the per-block flush).
    ask.flush(&mut result, channel);

    // If the answer arrived only via the final `result` event (no streamed text
    // deltas), still expose it as one text segment so the transcript isn't empty.
    if result.segments.is_empty() && !result.final_text.trim().is_empty() {
        result.segments.push(json!({ "type": "text", "text": result.final_text.clone() }));
    }

    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    running.lock().unwrap().remove(thread_id);
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

fn route_event(
    ev: &Value,
    result: &mut ChatResult,
    tool_blocks: &mut HashMap<i64, (String, String, String)>,
    ask: &mut AskParser,
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
    fn worker_agent_file_has_frontmatter_and_pinned_model() {
        let dir = std::env::temp_dir().join(format!("krystal-agents-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = write_worker_agent(&dir, "krystal-worker-x", "A worker", "claude-sonnet-4-6")
            .expect("writes the agent file");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("---\n"));
        assert!(body.contains("name: krystal-worker-x"));
        assert!(body.contains("model: claude-sonnet-4-6"));
        assert!(body.contains("worker sub-agent")); // the fixed brief
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
