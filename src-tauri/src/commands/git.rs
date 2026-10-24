//! The git status line and the branch picker.

use super::*;

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
