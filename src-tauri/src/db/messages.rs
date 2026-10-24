//! Message search, favourites and deleting a single message.

use super::*;

/* ---- search + favorites ---- */

pub fn search(conn: &Connection, q: &str, project: Option<&str>) -> Vec<Value> {
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.thread_id, m.role, m.text, m.ts, t.title
             FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.text LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR t.cwd = ?2)
             ORDER BY m.id DESC LIMIT 60",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![like, project], |r| {
            Ok(json!({
                "messageId": r.get::<_, i64>(0)?,
                "threadId": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "text": r.get::<_, String>(3)?,
                "ts": r.get::<_, Option<String>>(4)?,
                "threadTitle": r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "New chat".into()),
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn toggle_favorite(conn: &Connection, message_id: i64) -> Option<Value> {
    let cur: Option<i64> = conn
        .query_row("SELECT favorite FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let cur = cur?;
    let fav = if cur != 0 { 0 } else { 1 };
    let _ = conn.execute("UPDATE messages SET favorite = ?1 WHERE id = ?2", params![fav, message_id]);
    Some(json!({ "favorite": fav != 0 }))
}

/// Remove a single message from a thread's transcript. Returns the thread id it
/// belonged to, or `None` if there was no such message.
///
/// This edits the *saved* transcript only — the `claude` session the thread
/// resumes from keeps its own history, so a deleted message can still colour
/// later replies until the chat is cleared or compacted. The UI says so.
pub fn delete_message(conn: &Connection, message_id: i64) -> Option<String> {
    let thread_id: Option<String> = conn
        .query_row("SELECT thread_id FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let thread_id = thread_id?;
    conn.execute("DELETE FROM messages WHERE id = ?1", [message_id]).ok()?;
    Some(thread_id)
}

pub fn list_favorites(conn: &Connection, project: Option<&str>) -> Vec<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.thread_id, m.text, m.ts, t.title
             FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.favorite = 1 AND (?1 IS NULL OR t.cwd = ?1) ORDER BY m.id DESC",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![project], |r| {
            Ok(json!({
                "messageId": r.get::<_, i64>(0)?,
                "threadId": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
                "ts": r.get::<_, Option<String>>(3)?,
                "threadTitle": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "New chat".into()),
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}
