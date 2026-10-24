//! Files pinned to the side of the chat.

use super::*;

/* ---------------------------------- pins --------------------------------- */
/// Files the user has pinned to the side of the chat for quick reference — a
/// task list, a brief, notes. Scoped to a project, ordered oldest-first so the
/// rail doesn't reshuffle itself as pins come and go.
pub fn list_pins(conn: &Connection, project: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, path, label FROM pins WHERE project = ?1 ORDER BY id ASC",
    ) {
        if let Ok(rows) = stmt.query_map([project], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "path": r.get::<_, String>(1)?,
                "label": r.get::<_, Option<String>>(2)?,
            }))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// Pin a file. Pinning one that is already pinned just returns the whole list
/// again, so the caller never has to special-case a duplicate.
pub fn add_pin(conn: &Connection, project: &str, path: &str, label: &str) -> Vec<Value> {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO pins (project, path, label, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![project, path, label, now()],
    );
    list_pins(conn, project)
}

pub fn remove_pin(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM pins WHERE id = ?1", [id]);
}
