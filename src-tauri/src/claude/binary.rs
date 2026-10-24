//! Finding and minding the `claude` executable: where it is, what version, what
//! the machine around it can do, and the process plumbing every spawn uses.

use super::*;

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
