//! Artifacts, one row per version.

use super::*;

/* -------------------------------- artifacts ------------------------------- */
// The self-contained documents Claude builds in the artifact panel. Stored per
// project (like pins), one row per version.

/// One write to the artifact store: which artifact, from which chat, its content
/// now, and the turn that wrote it.
pub struct ArtifactWrite<'a> {
    pub project: &'a str,
    pub thread_id: &'a str,
    pub art_id: &'a str,
    pub title: &'a str,
    pub kind: &'a str,
    pub content: &'a str,
    /// The id of the user message that started the turn (see `save_artifact`).
    pub turn: Option<i64>,
}

/// Record a new state of an artifact.
///
/// Within a single turn this OVERWRITES rather than piling up: Claude routinely
/// patches an artifact five or ten times while working through one request, and
/// a version list with ten entries per message would be useless. The first write
/// of a turn opens a new version; the rest revise it. `turn` is the id of the
/// user message that started the turn — `None` collapses to "always a new
/// version", which is what the one-off paths want.
///
/// Returns the version number the content landed on.
pub fn save_artifact(conn: &Connection, w: &ArtifactWrite) -> i64 {
    let ArtifactWrite { project, thread_id, art_id, title, kind, content, turn } = *w;
    let existing: Option<i64> = turn.and_then(|t| {
        conn.query_row(
            "SELECT version FROM artifacts WHERE project = ?1 AND art_id = ?2 AND turn = ?3",
            params![project, art_id, t],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    });

    if let Some(version) = existing {
        let _ = conn.execute(
            "UPDATE artifacts SET title = ?1, kind = ?2, content = ?3, created_at = ?4              WHERE project = ?5 AND art_id = ?6 AND version = ?7",
            params![title, kind, content, now(), project, art_id, version],
        );
        return version;
    }

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project = ?1 AND art_id = ?2",
            params![project, art_id],
            |r| r.get(0),
        )
        .unwrap_or(1);
    let _ = conn.execute(
        "INSERT INTO artifacts (project, thread_id, art_id, title, kind, content, version, turn, created_at)          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![project, thread_id, art_id, title, kind, content, version, turn, now()],
    );
    version
}

/// Every artifact in a project, newest activity first, as summaries — the panel's
/// list. Content is deliberately left out: a project can hold a lot of megabytes
/// of artifact, and the list only needs to name them.
pub fn list_artifacts(conn: &Connection, project: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT a.art_id, a.title, a.kind, a.version, a.created_at, a.thread_id,                 (SELECT COUNT(*) FROM artifacts b WHERE b.project = a.project AND b.art_id = a.art_id)          FROM artifacts a          WHERE a.project = ?1            AND a.version = (SELECT MAX(c.version) FROM artifacts c                             WHERE c.project = a.project AND c.art_id = a.art_id)          ORDER BY a.created_at DESC",
    ) {
        if let Ok(rows) = stmt.query_map([project], |r| {
            Ok(json!({
                "artId": r.get::<_, String>(0)?,
                "title": r.get::<_, Option<String>>(1)?,
                "kind": r.get::<_, String>(2)?,
                "version": r.get::<_, i64>(3)?,
                "updatedAt": r.get::<_, Option<String>>(4)?,
                "threadId": r.get::<_, Option<String>>(5)?,
                "versions": r.get::<_, i64>(6)?,
            }))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// One artifact with its content — the latest version, or a specific one.
pub fn get_artifact(conn: &Connection, project: &str, art_id: &str, version: Option<i64>) -> Option<Value> {
    let versions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM artifacts WHERE project = ?1 AND art_id = ?2",
            params![project, art_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let row = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
        Ok(json!({
            "artId": art_id,
            "title": r.get::<_, Option<String>>(0)?,
            "kind": r.get::<_, String>(1)?,
            "content": r.get::<_, String>(2)?,
            "version": r.get::<_, i64>(3)?,
            "updatedAt": r.get::<_, Option<String>>(4)?,
            "versions": versions,
        }))
    };
    const COLS: &str = "SELECT title, kind, content, version, created_at FROM artifacts";
    match version {
        Some(v) => conn.query_row(
            &format!("{COLS} WHERE project = ?1 AND art_id = ?2 AND version = ?3"),
            params![project, art_id, v],
            row,
        ),
        None => conn.query_row(
            &format!("{COLS} WHERE project = ?1 AND art_id = ?2 ORDER BY version DESC LIMIT 1"),
            params![project, art_id],
            row,
        ),
    }
    .optional()
    .ok()
    .flatten()
}

/// Forget an artifact and all of its versions.
pub fn delete_artifact(conn: &Connection, project: &str, art_id: &str) {
    let _ = conn.execute(
        "DELETE FROM artifacts WHERE project = ?1 AND art_id = ?2",
        params![project, art_id],
    );
}
