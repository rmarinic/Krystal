//! Who may reach what, for a caller from outside.
//!
//! The cloud has already checked that whoever asks may reach this computer at
//! all: they own it, or its owner shared it with them (a request's
//! `from.owner` says which). The **owner** gets everything the window can do.
//! Someone it was **shared** with, a guest, gets what the owner chose in
//! Settings → Remote (`guests.rs`, `GuestAccess`):
//!
//!   * **Files.** Unless the owner allowed the whole computer, every path a
//!     guest names (a file to read, a folder to run git in, a chat's
//!     attachments, a new chat's folder) must lie inside one of the projects'
//!     folders or the extra folders granted to one. Pasted attachments (the
//!     app's own `attachments` folder) may be read and attached too: they are
//!     what the computer's chats show. Which folders count as projects is the
//!     owner's alone to change.
//!   * **Chat modes.** A guest's turn runs in a mode the owner allowed (see
//!     `stream.rs` and `models::cap_mode`); `set_mode` only to one of those.
//!     The one-off Claude helpers (Initialize, generating tasks, finding the
//!     run command, compacting) run with nothing checked, so they need Full
//!     access to be allowed.
//!   * **Permission prompts** of a turn are answered by the owner, unless the
//!     owner let guests answer their own.
//!   * **Commands** (the `$` shell, the RUN button, git's changing commands)
//!     only when the owner allowed them.

use std::path::{Path, PathBuf};

use super::guests::GuestAccess;
use super::*;

/// Who sent a request from outside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caller {
    pub owner: bool,
}

impl Caller {
    /// From a relayed request's `from`. Anything but an explicit owner is a
    /// guest: a missing or garbled `from` gets the smaller set, never the larger.
    pub fn from_request(from: &Value) -> Self {
        Caller { owner: from["owner"].as_bool() == Some(true) }
    }
}

/// The commands that change which folders count as projects.
const OWNER_ONLY: &[&str] =
    &["create_project", "move_project", "delete_project", "add_project_dir", "remove_project_dir"];

/// Commands that run something on this computer.
const COMMANDS: &[&str] = &[
    "run_shell", "run_app", "set_run_config",
    "git_checkout", "git_create_branch", "git_fetch", "git_pull", "git_push",
];

/// One-off Claude calls that run with nothing checked (`claude::base_args`), on
/// text the guest wrote. Full access in all but name, so they need it allowed.
const FULL_ACCESS_HELPERS: &[&str] =
    &["init_analyze", "init_draft", "init_save", "generate_tasks", "detect_run_command", "compact_thread"];

/// Arguments that name a folder a command works in.
const FOLDER_ARGS: &[&str] = &["cwd", "project"];

/// Where a guest's paths may lead.
struct Roots {
    /// Every project's folder and the extra folders granted to each.
    projects: Vec<PathBuf>,
    /// The pasted attachments: readable and attachable, not somewhere to work.
    attachments: Option<PathBuf>,
}

/// May `caller` run `cmd` with `args`? `Err` says why not, in words the person
/// asking can read.
pub fn check_access<R: Runtime>(app: &AppHandle<R>, caller: Caller, cmd: &str, args: &Value) -> Result<(), String> {
    if caller.owner {
        return Ok(());
    }
    let state: tauri::State<'_, AppState> = app.state();
    allowed(cmd, args, &GuestAccess::load(&state.data_dir), || roots(&state))
}

/// The rule itself, for a guest held to `to`. `roots` is only worked out when a
/// path needs it.
fn allowed(cmd: &str, args: &Value, to: &GuestAccess, roots: impl FnOnce() -> Roots) -> Result<(), String> {
    if OWNER_ONLY.contains(&cmd) {
        return Err("only this computer's owner can change its projects".into());
    }
    if COMMANDS.contains(&cmd) && !to.commands {
        return Err("this computer's owner hasn't allowed running commands".into());
    }
    if cmd == "answer_permission" && !to.approve {
        return Err("this computer's owner answers its permission prompts".into());
    }
    if FULL_ACCESS_HELPERS.contains(&cmd) && !to.allows_mode("auto") {
        return Err("this needs Full access, which this computer's owner hasn't allowed".into());
    }
    if cmd == "set_mode" && !to.allows_mode(args["mode"].as_str().unwrap_or("")) {
        return Err("this computer's owner hasn't allowed that mode".into());
    }
    if cmd == "chat" && to.modes.is_empty() {
        return Err("this computer's owner hasn't allowed sending messages".into());
    }
    if to.all_files {
        return Ok(());
    }
    let folders = FOLDER_ARGS.iter().filter_map(|k| non_empty(&args[*k]));
    let files = non_empty(&args["path"])
        .into_iter()
        .chain(args["files"].as_array().into_iter().flatten().filter_map(non_empty));
    let (folders, files): (Vec<&str>, Vec<&str>) = (folders.collect(), files.collect());
    if folders.is_empty() && files.is_empty() {
        return Ok(());
    }
    let roots = roots();
    let in_project = |p: &str| inside(p, &roots.projects);
    let in_attachments = |p: &str| inside(p, roots.attachments.as_slice());
    if let Some(p) = folders.into_iter().find(|p| !in_project(p)) {
        return Err(format!("{p} is not one of this computer's projects"));
    }
    if let Some(p) = files.into_iter().find(|p| !in_project(p) && !in_attachments(p)) {
        return Err(format!("{p} is outside this computer's projects"));
    }
    Ok(())
}

fn non_empty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.trim().is_empty())
}

fn roots(state: &AppState) -> Roots {
    let conn = state.db();
    let mut projects = Vec::new();
    for p in crate::db::list_projects(&conn) {
        let Some(path) = p["path"].as_str() else { continue };
        projects.push(path.to_string());
        projects.extend(crate::db::project_dir_paths(&conn, path));
    }
    Roots {
        projects: projects.iter().filter_map(|p| Path::new(p).canonicalize().ok()).collect(),
        attachments: state.data_dir.join("attachments").canonicalize().ok(),
    }
}

/// Is `path` (resolved: `..`, links and case as the disk has them) inside one of
/// `roots` (already resolved)? A path that doesn't exist can't be resolved and
/// is never inside, so `..` can't walk out through a folder that isn't there.
/// Component-wise, so `C:\proj` doesn't admit `C:\project2`.
fn inside(path: &str, roots: &[PathBuf]) -> bool {
    match Path::new(path).canonicalize() {
        Ok(p) => roots.iter().any(|r| p.starts_with(r)),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::{mock_app, TempDir};

    /// A project folder with a file in it, a folder beside it, and a pasted
    /// attachment, laid out in a scratch directory.
    struct Disk {
        _dir: TempDir,
        project: String,
        inner: String,
        outside: String,
        twin: String,
        pasted: String,
        attachments: PathBuf,
    }

    fn disk() -> Disk {
        let dir = TempDir::new();
        let at = |p: &str| dir.0.join(p);
        for d in ["proj/src", "elsewhere", "project2", "attachments"] {
            std::fs::create_dir_all(at(d)).unwrap();
        }
        for f in ["proj/src/main.rs", "elsewhere/secret.txt", "project2/x.txt", "attachments/1-shot.png"] {
            std::fs::write(at(f), "x").unwrap();
        }
        let s = |p: &str| at(p).to_string_lossy().to_string();
        Disk {
            project: s("proj"),
            inner: s("proj/src/main.rs"),
            outside: s("elsewhere/secret.txt"),
            twin: s("project2/x.txt"),
            pasted: s("attachments/1-shot.png"),
            attachments: at("attachments").canonicalize().unwrap(),
            _dir: dir,
        }
    }

    fn roots_of(d: &Disk) -> Roots {
        Roots { projects: vec![Path::new(&d.project).canonicalize().unwrap()], attachments: Some(d.attachments.clone()) }
    }

    /// A guest under the defaults.
    fn guest(d: &Disk, cmd: &str, args: Value) -> Result<(), String> {
        allowed(cmd, &args, &GuestAccess::default(), || roots_of(d))
    }

    /// A guest under what the owner chose.
    fn guest_with(to: &GuestAccess, d: &Disk, cmd: &str, args: Value) -> Result<(), String> {
        allowed(cmd, &args, to, || roots_of(d))
    }

    #[test]
    fn a_guest_reads_inside_the_projects_and_nothing_else() {
        let d = disk();
        assert!(guest(&d, "read_pinned_file", json!({ "path": d.inner })).is_ok());
        assert!(guest(&d, "read_image", json!({ "path": d.pasted })).is_ok(), "pasted attachments are readable");
        assert!(guest(&d, "read_pinned_file", json!({ "path": d.outside })).is_err());
        assert!(guest(&d, "read_image", json!({ "path": d.twin })).is_err(), "a folder whose name starts the same isn't inside");
        // Walking out with `..` resolves first.
        let escape = format!("{}/../elsewhere/secret.txt", d.project);
        assert!(guest(&d, "read_pinned_file", json!({ "path": escape })).is_err());
        assert!(guest(&d, "read_pinned_file", json!({ "path": format!("{}/nope.txt", d.project) })).is_err());
    }

    #[test]
    fn a_guest_works_only_in_project_folders() {
        let d = disk();
        assert!(guest(&d, "git_status", json!({ "cwd": d.project })).is_ok());
        assert!(guest(&d, "create_thread", json!({ "cwd": d.project })).is_ok());
        let parent = Path::new(&d.project).parent().unwrap().to_string_lossy().to_string();
        assert!(guest(&d, "create_thread", json!({ "cwd": parent })).is_err(), "a chat in the folder above");
        assert!(guest(&d, "git_status", json!({ "cwd": parent })).is_err());
        let atts = d.attachments.to_string_lossy().to_string();
        assert!(guest(&d, "create_thread", json!({ "cwd": atts })).is_err(), "attachments aren't a place to work");
        assert!(guest(&d, "list_skills", json!({ "project": parent })).is_err());
    }

    #[test]
    fn a_guest_attaches_only_files_from_the_projects_or_pasted_ones() {
        let d = disk();
        let ok = json!({ "threadId": "t1", "text": "look", "files": [d.inner, d.pasted] });
        assert!(guest(&d, "chat", ok).is_ok());
        let bad = json!({ "threadId": "t1", "text": "look", "files": [d.inner, d.outside] });
        assert!(guest(&d, "chat", bad).is_err());
    }

    #[test]
    fn a_guest_cannot_change_which_folders_are_projects() {
        let d = disk();
        for cmd in OWNER_ONLY {
            assert!(guest(&d, cmd, json!({ "path": d.inner, "id": "p1", "project": d.project })).is_err(), "{cmd}");
        }
    }

    #[test]
    fn calls_that_name_no_path_need_no_roots() {
        let args = json!({ "id": "t1", "project": "" });
        let to = GuestAccess::default();
        assert!(allowed("get_thread", &args, &to, || panic!("no path, no lookup")).is_ok());
        assert!(allowed("list_projects", &json!({}), &to, || panic!("no path, no lookup")).is_ok());
    }

    #[test]
    fn by_default_a_guest_runs_no_commands_answers_no_prompts_and_gets_no_full_access() {
        let d = disk();
        assert!(guest(&d, "run_shell", json!({ "threadId": "t1", "command": "dir" })).is_err());
        assert!(guest(&d, "run_app", json!({ "project": d.project })).is_err());
        assert!(guest(&d, "git_push", json!({ "cwd": d.project })).is_err());
        assert!(guest(&d, "git_status", json!({ "cwd": d.project })).is_ok(), "looking is fine");
        assert!(guest(&d, "answer_permission", json!({ "threadId": "t1", "requestId": "p", "decision": "allow" })).is_err());
        assert!(guest(&d, "stop_chat", json!({ "threadId": "t1" })).is_ok());
        assert!(guest(&d, "generate_tasks", json!({ "cwd": d.project, "brief": "x" })).is_err());
        assert!(guest(&d, "set_mode", json!({ "id": "t1", "mode": "auto" })).is_err());
        assert!(guest(&d, "set_mode", json!({ "id": "t1", "mode": "plan" })).is_ok());
        assert!(guest(&d, "chat", json!({ "threadId": "t1", "text": "hi" })).is_ok());
    }

    #[test]
    fn what_the_owner_allows_a_guest_may_do() {
        let d = disk();
        let to = GuestAccess { modes: vec!["auto".into()], approve: true, commands: true, all_files: true };
        assert!(guest_with(&to, &d, "run_shell", json!({ "threadId": "t1", "command": "dir" })).is_ok());
        assert!(guest_with(&to, &d, "answer_permission", json!({ "decision": "allow" })).is_ok());
        assert!(guest_with(&to, &d, "generate_tasks", json!({ "cwd": d.project })).is_ok());
        assert!(guest_with(&to, &d, "read_pinned_file", json!({ "path": d.outside })).is_ok(), "the whole computer");
        assert!(guest_with(&to, &d, "create_project", json!({ "path": d.outside })).is_err(), "projects stay the owner's");
        let none = GuestAccess { modes: vec![], ..GuestAccess::default() };
        assert!(guest_with(&none, &d, "chat", json!({ "threadId": "t1", "text": "hi" })).is_err(), "no modes: read only");
    }

    #[test]
    fn only_an_explicit_owner_is_the_owner() {
        assert!(Caller::from_request(&json!({ "email": "a@b", "owner": true })).owner);
        assert!(!Caller::from_request(&json!({ "email": "a@b", "owner": false })).owner);
        assert!(!Caller::from_request(&json!({ "owner": "true" })).owner);
        assert!(!Caller::from_request(&Value::Null).owner);
    }

    #[tokio::test]
    async fn the_owner_reaches_anything_and_a_guest_is_held_to_the_projects() {
        let d = disk();
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        dispatch(app.handle(), "create_project", &json!({ "path": d.project })).await.unwrap().unwrap();
        let (owner, guest) = (Caller { owner: true }, Caller { owner: false });
        let read = |p: &str| json!({ "path": p });
        assert!(check_access(app.handle(), owner, "read_pinned_file", &read(&d.outside)).is_ok());
        assert!(check_access(app.handle(), guest, "read_pinned_file", &read(&d.inner)).is_ok(), "the project is on the list");
        assert!(check_access(app.handle(), guest, "read_pinned_file", &read(&d.outside)).is_err());
        assert!(check_access(app.handle(), guest, "create_project", &read(&d.outside)).is_err());
    }
}
