//! Projects: the picker's list, moving a project's folder, its extra folders,
//! and deleting one.

use super::*;

/* -------------------------------- projects ------------------------------- */

fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "path": r.get::<_, Option<String>>(1)?,
        "name": r.get::<_, Option<String>>(2)?,
        "createdAt": r.get::<_, Option<String>>(3)?,
        "updatedAt": r.get::<_, Option<String>>(4)?,
        "chatCount": r.get::<_, i64>(5)?,
    }))
}

const PROJECT_SELECT: &str = "SELECT p.id, p.path, p.name, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM threads t WHERE t.cwd = p.path) AS chat_count
     FROM projects p";

pub fn list_projects(conn: &Connection) -> Vec<Value> {
    let sql = format!("{PROJECT_SELECT} ORDER BY p.updated_at DESC");
    let mut stmt = conn.prepare(&sql).unwrap();
    let rows = stmt.query_map([], project_row).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn get_project(conn: &Connection, id: &str) -> Option<Value> {
    let sql = format!("{PROJECT_SELECT} WHERE p.id = ?1");
    conn.query_row(&sql, [id], project_row).optional().ok().flatten()
}

/// Create a project for `path`, or return (and touch) the existing one.
pub fn create_project(conn: &Connection, path: &str) -> Option<Value> {
    let t = now();
    let existing: Option<String> = conn
        .query_row("SELECT id FROM projects WHERE path = ?1", [path], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let id = match existing {
        Some(id) => {
            let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", params![t, id]);
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO projects (id,path,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                params![id, path, base_name(path), t],
            )
            .ok()?;
            id
        }
    };
    get_project(conn, &id)
}

/// Mark a project as just-opened (moves it to the top of the list) and return it.
pub fn select_project(conn: &Connection, id: &str) -> Option<Value> {
    let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", params![now(), id]);
    get_project(conn, id)
}

/// The folder a project currently points at.
pub fn project_path(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT path FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Point a project at a different folder — the project keeps its identity and
/// takes everything keyed by its path with it: its chats (`threads.cwd`), its
/// tasks and its run command.
///
/// Every moved chat's `session_id` is dropped on purpose. Claude Code keys its
/// own session store by working directory, so resuming one of those sessions from
/// the new folder would look for a transcript that isn't there and fail the turn.
/// Krystal's own transcript is untouched — only the CLI-side continuation starts
/// fresh, the same way Clear already works.
///
/// Returns the updated project, or None if the move didn't happen (unknown
/// project, or another project already lives in that folder).
pub fn move_project(conn: &Connection, id: &str, new_path: &str) -> Option<Value> {
    let old = project_path(conn, id)?;
    if old == new_path {
        return get_project(conn, id);
    }
    if project_path_taken(conn, new_path) {
        return None;
    }
    // A name that still matches the old folder follows along; one the user picked
    // themselves stays as it is.
    let name = get_project(conn, id)
        .and_then(|p| p.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .filter(|n| *n != base_name(&old))
        .unwrap_or_else(|| base_name(new_path));

    let t = now();
    let _ = conn.execute_batch("BEGIN");
    let done = (|| -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE projects SET path = ?1, name = ?2, updated_at = ?3 WHERE id = ?4",
            params![new_path, name, t, id],
        )?;
        conn.execute(
            "UPDATE threads SET cwd = ?1, session_id = NULL WHERE cwd = ?2",
            params![new_path, old],
        )?;
        conn.execute("UPDATE tasks SET project = ?1 WHERE project = ?2", params![new_path, old])?;
        // Pins are re-keyed to the new project path, and any that pointed *inside*
        // the old folder are rewritten to their new home — otherwise every pin
        // would silently turn into a dead path after a move.
        conn.execute(
            "UPDATE pins SET path = ?1 || substr(path, length(?2) + 1) WHERE project = ?2 AND path LIKE ?2 || '%'",
            params![new_path, old],
        )?;
        conn.execute("UPDATE pins SET project = ?1 WHERE project = ?2", params![new_path, old])?;
        // Extra folders get the same treatment: re-keyed to the new project, and
        // any that sat *inside* the old folder follow it to the new one.
        conn.execute(
            "UPDATE project_dirs SET path = ?1 || substr(path, length(?2) + 1) WHERE project = ?2 AND path LIKE ?2 || '%'",
            params![new_path, old],
        )?;
        conn.execute(
            "DELETE FROM project_dirs WHERE project = ?1",
            [new_path],
        )?;
        // Artifacts belong to the project, like pins, so they follow it.
        conn.execute(
            "UPDATE artifacts SET project = ?1 WHERE project = ?2",
            params![new_path, old],
        )?;
        conn.execute(
            "UPDATE project_dirs SET project = ?1 WHERE project = ?2",
            params![new_path, old],
        )?;
        // run_config is keyed by path, so clear any stale row at the destination
        // before the old one takes its place.
        conn.execute("DELETE FROM run_config WHERE project = ?1", [new_path])?;
        conn.execute(
            "UPDATE run_config SET project = ?1 WHERE project = ?2",
            params![new_path, old],
        )?;
        Ok(())
    })();
    let _ = conn.execute_batch(if done.is_ok() { "COMMIT" } else { "ROLLBACK" });
    done.ok()?;
    get_project(conn, id)
}

/// Whether some project already points at this folder.
pub fn project_path_taken(conn: &Connection, path: &str) -> bool {
    conn.query_row("SELECT 1 FROM projects WHERE path = ?1", [path], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Bump a project's recency by its folder path (called when a chat is created).
pub fn touch_project(conn: &Connection, path: &str) {
    let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE path = ?2", params![now(), path]);
}

/* ------------------------------ extra folders ----------------------------- */
/// Folders outside the project that its chats may still read and write — a
/// shared assets folder, a second repo, the notes you keep somewhere else. Each
/// one reaches the CLI as `--add-dir`, so this is a project-level permission
/// list rather than a bookmark list. Oldest-first, like pins.
pub fn list_project_dirs(conn: &Connection, project: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT id, path FROM project_dirs WHERE project = ?1 ORDER BY id ASC")
    {
        if let Ok(rows) = stmt.query_map([project], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "path": r.get::<_, String>(1)? }))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// Adding a folder twice is a no-op rather than a duplicate row.
pub fn add_project_dir(conn: &Connection, project: &str, path: &str) -> Vec<Value> {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO project_dirs (project, path, created_at) VALUES (?1, ?2, ?3)",
        params![project, path, now()],
    );
    list_project_dirs(conn, project)
}

pub fn remove_project_dir(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM project_dirs WHERE id = ?1", [id]);
}

/// Just the paths, for building `--add-dir` flags on a chat turn.
pub fn project_dir_paths(conn: &Connection, project: &str) -> Vec<String> {
    list_project_dirs(conn, project)
        .into_iter()
        .filter_map(|d| d["path"].as_str().map(str::to_string))
        .collect()
}

/// Delete a project and all of its chats.
pub fn delete_project(conn: &Connection, id: &str) {
    let path: Option<String> = conn
        .query_row("SELECT path FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if let Some(path) = path {
        let _ = conn.execute("DELETE FROM threads WHERE cwd = ?1", [&path]);
        let _ = conn.execute("DELETE FROM tasks WHERE project = ?1", [&path]);
        let _ = conn.execute("DELETE FROM run_config WHERE project = ?1", [&path]);
        let _ = conn.execute("DELETE FROM project_dirs WHERE project = ?1", [&path]);
    }
    let _ = conn.execute("DELETE FROM projects WHERE id = ?1", [id]);
}
