//! Projects: the picker, moving a project's folder, the extra folders granted to
//! it, and what can be found in it (skills, a CLAUDE.md).

use super::*;

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Value {
    let conn = state.db();
    json!({ "projects": db::list_projects(&conn) })
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, path: String) -> CmdResult {
    if path.trim().is_empty() {
        return Err("path required".into());
    }
    let conn = state.db();
    db::create_project(&conn, &path).ok_or_else(|| "could not create project".into())
}

#[tauri::command]
pub fn select_project(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db();
    db::select_project(&conn, &id).ok_or_else(|| "not found".into())
}

/// Point a project at a different folder — after moving/renaming it on disk, or
/// when the same work lives somewhere else now. The project keeps its identity,
/// its chats, its tasks and its run command; only their location changes.
/// Errors are short codes the frontend turns into localized text.
#[tauri::command]
pub async fn move_project(state: State<'_, AppState>, id: String, path: String) -> CmdResult {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("path-required".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err("not-a-folder".into());
    }
    // Locks taken one at a time, never nested (the run panel holds them the other
    // way round).
    let old = {
        let conn = state.db();
        db::project_path(&conn, &id).ok_or_else(|| "not-found".to_string())?
    };
    // A live RUN belongs to the folder it was started in — its process is keyed by
    // that path and still executing there. Ask for it to be stopped first rather
    // than orphaning it beyond the reach of the Stop button.
    if state.run_procs.lock().unwrap().contains_key(&old) {
        return Err("run-in-flight".into());
    }
    // Scoped so the DB lock is released before the await below.
    let project = {
        let conn = state.db();
        if old != path && db::project_path_taken(&conn, &path) {
            return Err("folder-taken".into());
        }
        db::move_project(&conn, &id, &path).ok_or_else(|| "move-failed".to_string())?
    };
    // Every warm process is pinned to the folder it started in, and the move drops
    // the moved chats' session ids — so none of them may serve another turn.
    state.sessions.retire_all().await;
    // The task snapshot Claude reads is keyed by the folder path, so the old
    // file is now orphaned — drop it; the next turn writes one under the new key.
    if old != path {
        let stale = state
            .data_dir
            .join("task-lists")
            .join(format!("{}.md", project_key(&old)));
        let _ = std::fs::remove_file(stale);
    }
    Ok(project)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db();
    db::delete_project(&conn, &id);
    json!({ "ok": true })
}

/// The `/skill-name` commands we can find on disk for this project (see
/// `skills.rs`). The CLI's own built-ins aren't here — those arrive with the
/// session's `start` event and the frontend merges the two.
#[tauri::command]
pub fn list_skills(project: Option<String>) -> Value {
    json!({ "skills": skills::scan(project.as_deref()) })
}

#[tauri::command]
pub fn list_project_dirs(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    json!({ "dirs": db::list_project_dirs(&conn, &project) })
}

/// Grant this project's chats access to another folder. Rejected if the folder
/// is gone, or if it's the project folder (or inside it) — those are already
/// reachable, and passing them again would only pad every turn's flags.
#[tauri::command]
pub fn add_project_dir(state: State<'_, AppState>, project: String, path: String) -> CmdResult {
    let path = path.trim().to_string();
    if project.trim().is_empty() || path.is_empty() {
        return Err("nothing to add".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err("not-a-folder".into());
    }
    if is_within(&path, &project) {
        return Err("already-included".into());
    }
    let conn = state.db();
    Ok(json!({ "dirs": db::add_project_dir(&conn, &project, &path) }))
}

#[tauri::command]
pub fn remove_project_dir(state: State<'_, AppState>, project: String, id: i64) -> Value {
    let conn = state.db();
    db::remove_project_dir(&conn, id);
    json!({ "dirs": db::list_project_dirs(&conn, &project) })
}

/// Is `path` the same folder as `root`, or inside it? Compared on the canonical
/// paths so `C:\p\..\p\sub` and a symlinked route to the same place both count;
/// falls back to the raw strings when a path can't be canonicalized.
fn is_within(path: &str, root: &str) -> bool {
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
    let (path, root) = (canon(path), canon(root));
    path == root || path.starts_with(&root)
}

/// Does this project folder already have a CLAUDE.md? Lets the welcome screen
/// decide whether its button reads "Initialize" or "Reinitialize" — no thread
/// needed, just the project path.
#[tauri::command]
pub fn claude_md_exists(cwd: String) -> Value {
    let exists = std::path::Path::new(&cwd).join("CLAUDE.md").exists();
    json!({ "exists": exists })
}
