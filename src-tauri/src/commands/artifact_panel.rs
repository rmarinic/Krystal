//! The artifact panel's commands: listing, reading, deleting, exporting and
//! opening artifacts. The artifact tool itself is `crate::artifacts`.
//!
//! The self-contained documents Claude builds in the artifact panel. See
//! `artifacts.rs` for how the tool that makes them exists at all, and
//! `src/app/artifacts.js` for the panel.

use super::*;

#[tauri::command]
pub fn list_artifacts(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    json!({ "artifacts": db::list_artifacts(&conn, &project) })
}

/// One artifact's full content — the latest version, or a specific one when the
/// user walks back through the version history.
#[tauri::command]
pub fn get_artifact(
    state: State<'_, AppState>,
    project: String,
    art_id: String,
    version: Option<i64>,
) -> CmdResult {
    let conn = state.db();
    db::get_artifact(&conn, &project, &art_id, version).ok_or_else(|| "no such artifact".into())
}

#[tauri::command]
pub fn delete_artifact(state: State<'_, AppState>, project: String, art_id: String) -> Value {
    let conn = state.db();
    db::delete_artifact(&conn, &project, &art_id);
    json!({ "artifacts": db::list_artifacts(&conn, &project) })
}

/// Write an artifact to a file the user chose — the "keep it / send it to
/// someone" half of the feature. The whole point of an artifact being
/// self-contained is that the file works anywhere on its own, so this is a plain
/// copy with no rewriting.
///
/// `rendered` is what the panel is actually showing, when that differs from what
/// is stored: a mermaid artifact is *stored* as its source (so Claude's patches
/// keep applying) but is *saved* as the SVG the user is looking at, which opens
/// anywhere without a renderer. The frontend does that rendering, so it hands
/// the result back here rather than the backend guessing.
#[tauri::command]
pub fn export_artifact(
    state: State<'_, AppState>,
    project: String,
    art_id: String,
    version: Option<i64>,
    path: String,
    rendered: Option<String>,
) -> CmdResult {
    let content = artifact_bytes(&state, &project, &art_id, version, rendered)?;
    std::fs::write(&path, content).map_err(|e| format!("could not save it: {e}"))?;
    Ok(json!({ "ok": true, "path": path }))
}

/// What should actually be written to a file for this artifact: the rendering
/// the panel is showing when there is one, otherwise what's stored.
fn artifact_bytes(
    state: &State<'_, AppState>,
    project: &str,
    art_id: &str,
    version: Option<i64>,
    rendered: Option<String>,
) -> Result<String, String> {
    if let Some(r) = rendered.filter(|r| !r.trim().is_empty()) {
        return Ok(r);
    }
    let conn = state.db();
    let art = db::get_artifact(&conn, project, art_id, version).ok_or("no such artifact")?;
    Ok(art.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// Open an artifact in the user's real browser, by writing it to a scratch file
/// first. `open_external` only takes http(s) links (it guards the reply-link
/// path), and this is a local file — a different job with a different rule: the
/// file is one Krystal just wrote itself, from content it already holds.
#[tauri::command]
pub fn open_artifact_externally(
    state: State<'_, AppState>,
    project: String,
    art_id: String,
    version: Option<i64>,
    rendered: Option<String>,
    ext: Option<String>,
) -> CmdResult {
    let stored_ext = {
        let conn = state.db();
        let art = db::get_artifact(&conn, &project, &art_id, version).ok_or("no such artifact")?;
        artifacts::ext_for(art.get("kind").and_then(|v| v.as_str()).unwrap_or("text/html"))
    };
    let content = artifact_bytes(&state, &project, &art_id, version, rendered)?;
    // A mermaid artifact opens as the SVG the panel rendered, not as its source
    // (see `export_artifact`), so the caller can override the extension.
    let ext = ext.filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()) && !e.is_empty())
        .unwrap_or_else(|| stored_ext.to_string());

    let dir = state.data_dir.join("artifact-preview");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not open it: {e}"))?;
    let file = dir.join(format!("{}.{}", artifacts::safe_id(&art_id), ext));
    std::fs::write(&file, content).map_err(|e| format!("could not open it: {e}"))?;

    std::process::Command::new("explorer.exe")
        .arg(&file)
        .spawn()
        .map_err(|e| format!("could not open it: {e}"))?;
    Ok(json!({ "ok": true, "path": file.to_string_lossy() }))
}
