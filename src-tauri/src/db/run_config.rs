//! The RUN button's per-project command.

use super::*;

/* ------------------------------- run config ------------------------------ */
/* How to start a project locally for testing (the RUN button). One command per
 * project folder — the same `path` threads/tasks use — set by hand or detected
 * by Claude. Empty/whitespace is treated as "not set yet". */

/// The stored run command for a project folder, or None if unset/blank.
pub fn get_run_command(conn: &Connection, project: &str) -> Option<String> {
    conn.query_row(
        "SELECT command FROM run_config WHERE project = ?1",
        [project],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|s| !s.trim().is_empty())
}

/// Set (or overwrite) a project's run command.
pub fn set_run_command(conn: &Connection, project: &str, command: &str) {
    let t = now();
    let _ = conn.execute(
        "INSERT INTO run_config (project,command,updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(project) DO UPDATE SET command = ?2, updated_at = ?3",
        params![project, command, t],
    );
}
